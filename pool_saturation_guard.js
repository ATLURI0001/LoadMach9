import crypto from 'node:crypto';

/**
 * Custom error class for connection pool saturation and load shedding events.
 */
export class PoolSaturationError extends Error {
  /**
   * @param {string} message
   * @param {'POOL_SHED' | 'QUEUE_TIMEOUT' | 'INVALID_TOKEN' | 'POOL_RESET'} code
   */
  constructor(message, code) {
    super(message);
    this.name = 'PoolSaturationError';
    this.code = code;
  }
}

/**
 * PoolSaturationGuard regulates database/TCP connection pool capacity, enforcing
 * proactive saturation alerts, queuing with strict deadlines, and graceful load shedding.
 */
export class PoolSaturationGuard {
  /**
   * @param {Object} [options={}]
   * @param {number} [options.maxPoolSize=50] - Maximum physical connection ceiling.
   * @param {number} [options.saturationThreshold=0.8] - Utilization ratio (0.1 - 1.0) triggering saturation backpressure.
   * @param {number} [options.maxQueueSize=100] - Maximum waiting callers before load shedding occurs.
   * @param {number} [options.queueTimeoutMs=3000] - Timeout for waiting in the acquisition queue.
   * @param {Function} [options.clockFn=Date.now] - Clock function for deterministic timing.
   */
  constructor(options = {}) {
    const poolSize = Number(options.maxPoolSize);
    this.maxPoolSize = Number.isInteger(poolSize) && poolSize > 0 ? poolSize : 50;

    const threshold = Number(options.saturationThreshold);
    this.saturationThreshold = Number.isFinite(threshold) && threshold > 0 && threshold <= 1.0 ? threshold : 0.8;

    const queueSize = Number(options.maxQueueSize);
    this.maxQueueSize = Number.isInteger(queueSize) && queueSize >= 0 ? queueSize : 100;

    const timeout = Number(options.queueTimeoutMs);
    this.queueTimeoutMs = Number.isFinite(timeout) && timeout >= 50 ? timeout : 3000;

    this.clockFn = typeof options.clockFn === 'function' ? options.clockFn : Date.now;

    /** @type {Map<string, { acquiredAt: number, clientTag: string }>} */
    this.activeTokens = new Map();

    /** @type {Array<{ resolve: Function, reject: Function, enqueuedAt: number, clientTag: string, timer: any }>} */
    this.queue = [];

    /** @type {number[]} */
    this.waitTimes = [];

    this.stats = {
      acquiredTotal: 0,
      releasedTotal: 0,
      queuedTotal: 0,
      queueTimeoutsTotal: 0,
      shedTotal: 0,
      saturationEventsTotal: 0,
    };
  }

  /**
   * Evaluates whether current pool utilization meets or exceeds saturation threshold.
   * @returns {boolean}
   */
  isSaturated() {
    return (this.activeTokens.size / this.maxPoolSize) >= this.saturationThreshold;
  }

  /**
   * Acquires a connection lease from the pool or queues with deadline.
   * @param {string} [clientTag='default']
   * @param {number} [timeoutMs]
   * @returns {Promise<{ token: string, acquiredAt: number, waitMs: number, isSaturated: boolean }>}
   */
  async acquire(clientTag = 'default', timeoutMs = this.queueTimeoutMs) {
    const now = this.clockFn();

    // Fast path: connection slot available
    if (this.activeTokens.size < this.maxPoolSize) {
      return this._grantLease(clientTag, now, 0);
    }

    // Pool exhausted: check if queue capacity is reached (load shedding)
    if (this.queue.length >= this.maxQueueSize) {
      this.stats.shedTotal++;
      throw new PoolSaturationError(
        `Connection pool (${this.maxPoolSize}) and queue limit (${this.maxQueueSize}) exhausted: shedding request`,
        'POOL_SHED'
      );
    }

    // Enqueue request
    this.stats.queuedTotal++;
    const effectiveTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : this.queueTimeoutMs;

    return new Promise((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        enqueuedAt: now,
        clientTag: String(clientTag),
        timer: null,
      };

      entry.timer = setTimeout(() => {
        // Remove from queue
        const idx = this.queue.indexOf(entry);
        if (idx !== -1) {
          this.queue.splice(idx, 1);
          this.stats.queueTimeoutsTotal++;
          reject(new PoolSaturationError(`Connection acquisition queue timed out after ${effectiveTimeout}ms`, 'QUEUE_TIMEOUT'));
        }
      }, effectiveTimeout);

      this.queue.push(entry);
    });
  }

  /**
   * Internal lease grant helper.
   * @private
   */
  _grantLease(clientTag, now, waitMs) {
    const token = crypto.randomUUID();
    this.activeTokens.set(token, {
      acquiredAt: now,
      clientTag: String(clientTag),
    });

    this.stats.acquiredTotal++;
    if (waitMs > 0) {
      this.waitTimes.push(waitMs);
      if (this.waitTimes.length > 1000) {
        this.waitTimes.shift();
      }
    }

    const saturated = this.isSaturated();
    if (saturated) {
      this.stats.saturationEventsTotal++;
    }

    return {
      token,
      acquiredAt: now,
      waitMs,
      isSaturated: saturated,
    };
  }

  /**
   * Releases an active connection lease, immediately servicing the next queued caller if present.
   * @param {string} token
   * @returns {boolean} True if released, false if token was unrecognized or already released.
   */
  release(token) {
    if (!token || !this.activeTokens.has(token)) {
      return false;
    }

    this.activeTokens.delete(token);
    this.stats.releasedTotal++;

    // Service queued requests FIFO
    while (this.queue.length > 0) {
      const nextEntry = this.queue.shift();
      if (nextEntry.timer) {
        clearTimeout(nextEntry.timer);
      }

      const now = this.clockFn();
      const waitMs = Math.max(0, now - nextEntry.enqueuedAt);
      const grant = this._grantLease(nextEntry.clientTag, now, waitMs);
      nextEntry.resolve(grant);
      return true;
    }

    return true;
  }

  /**
   * Gathers comprehensive runtime telemetry and percentiles.
   * @returns {Object}
   */
  getMetrics() {
    const active = this.activeTokens.size;
    const queued = this.queue.length;
    const utilization = Number((active / this.maxPoolSize).toFixed(4));
    const saturated = utilization >= this.saturationThreshold;

    let p95WaitMs = 0;
    let avgWaitMs = 0;

    if (this.waitTimes.length > 0) {
      const sorted = [...this.waitTimes].sort((a, b) => a - b);
      const p95Idx = Math.floor(sorted.length * 0.95);
      p95WaitMs = sorted[Math.min(p95Idx, sorted.length - 1)];
      const sum = sorted.reduce((acc, v) => acc + v, 0);
      avgWaitMs = Number((sum / sorted.length).toFixed(2));
    }

    return {
      maxPoolSize: this.maxPoolSize,
      activeConnections: active,
      availableSlots: Math.max(0, this.maxPoolSize - active),
      queuedRequests: queued,
      maxQueueSize: this.maxQueueSize,
      utilizationRate: utilization,
      isSaturated: saturated,
      avgWaitMs,
      p95WaitMs,
      stats: { ...this.stats },
    };
  }

  /**
   * Flushes active leases and drops all pending queue entries with POOL_RESET error.
   */
  reset() {
    for (const entry of this.queue) {
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
      entry.reject(new PoolSaturationError('Pool was reset: pending request aborted', 'POOL_RESET'));
    }

    this.queue = [];
    this.activeTokens.clear();
    this.waitTimes = [];
    this.stats = {
      acquiredTotal: 0,
      releasedTotal: 0,
      queuedTotal: 0,
      queueTimeoutsTotal: 0,
      shedTotal: 0,
      saturationEventsTotal: 0,
    };
  }

  /**
   * Express/Connect middleware for automatic connection gating and backpressure header tagging.
   * @returns {Function}
   */
  createMiddleware() {
    return async (req, res, next) => {
      try {
        const lease = await this.acquire(req.path || 'http_request');
        res.setHeader('x-pool-utilization', (this.activeTokens.size / this.maxPoolSize).toFixed(2));
        res.setHeader('x-pool-saturated', lease.isSaturated ? 'true' : 'false');

        let released = false;
        const cleanup = () => {
          if (!released) {
            released = true;
            this.release(lease.token);
          }
        };

        res.once('finish', cleanup);
        res.once('close', cleanup);
        next();
      } catch (err) {
        if (err.code === 'POOL_SHED') {
          res.setHeader('Retry-After', '2');
          return res.status(503).json({
            error: 'Service Unavailable',
            reason: 'Connection pool saturated and backpressure shed threshold reached',
            code: 'POOL_SHED',
          });
        }
        if (err.code === 'QUEUE_TIMEOUT') {
          res.setHeader('Retry-After', '1');
          return res.status(504).json({
            error: 'Gateway Timeout',
            reason: 'Timed out waiting for available connection pool slot',
            code: 'QUEUE_TIMEOUT',
          });
        }
        return next(err);
      }
    };
  }
}
