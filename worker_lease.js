import crypto from 'node:crypto';

/**
 * WorkerLeaseManager manages distributed worker execution slots, enforcing concurrency
 * ceilings, deadman heartbeats, and non-blocking lease evictions.
 */
export class WorkerLeaseManager {
  /**
   * @param {Object} options
   * @param {number} [options.maxConcurrency=10] - Maximum simultaneous active worker leases.
   * @param {number} [options.defaultTtlMs=5000] - Default lease lifetime in milliseconds.
   * @param {Function} [options.clockFn=Date.now] - Clock provider for deterministic testing.
   */
  constructor(options = {}) {
    const maxConcurrency = Number(options.maxConcurrency);
    this.maxConcurrency = Number.isInteger(maxConcurrency) && maxConcurrency > 0 ? maxConcurrency : 10;

    const defaultTtlMs = Number(options.defaultTtlMs);
    this.defaultTtlMs = Number.isFinite(defaultTtlMs) && defaultTtlMs >= 100 ? defaultTtlMs : 5000;

    this.clockFn = typeof options.clockFn === 'function' ? options.clockFn : Date.now;

    /** @type {Map<string, Object>} */
    this.leases = new Map();

    this.stats = {
      acquiredTotal: 0,
      expiredTotal: 0,
      releasedTotal: 0,
      rejectedTotal: 0,
    };
  }

  /**
   * Cleans up stale leases whose TTL has elapsed.
   * @param {number} [now]
   * @returns {string[]} List of evicted worker IDs.
   */
  evictExpired(now = this.clockFn()) {
    const evicted = [];
    for (const [workerId, lease] of this.leases.entries()) {
      if (now >= lease.expiresAt) {
        this.leases.delete(workerId);
        this.stats.expiredTotal++;
        evicted.push(workerId);
      }
    }
    return evicted;
  }

  /**
   * Attempts to acquire an execution lease for a worker.
   * @param {string} workerId - Unique identifier for the worker.
   * @param {Object} [metadata={}] - Arbitrary worker metadata.
   * @param {number} [customTtlMs] - Optional custom TTL in milliseconds.
   * @returns {{ acquired: boolean, leaseToken?: string, expiresAt?: number, reason?: string, activeCount: number }}
   */
  acquireLease(workerId, metadata = {}, customTtlMs) {
    if (!workerId || typeof workerId !== 'string' || workerId.trim().length === 0) {
      throw new TypeError('workerId must be a non-empty string');
    }

    const now = this.clockFn();
    this.evictExpired(now);

    const ttl = Number.isFinite(customTtlMs) && customTtlMs >= 100 ? customTtlMs : this.defaultTtlMs;

    // Check if worker already has a valid lease
    if (this.leases.has(workerId)) {
      const existing = this.leases.get(workerId);
      if (now < existing.expiresAt) {
        this.stats.rejectedTotal++;
        return {
          acquired: false,
          reason: 'WORKER_ALREADY_HAS_ACTIVE_LEASE',
          activeCount: this.leases.size,
        };
      }
      // Stale lease for the same worker - evict it
      this.leases.delete(workerId);
      this.stats.expiredTotal++;
    }

    // Check concurrency capacity
    if (this.leases.size >= this.maxConcurrency) {
      this.stats.rejectedTotal++;
      return {
        acquired: false,
        reason: 'CAPACITY_EXCEEDED',
        activeCount: this.leases.size,
      };
    }

    const leaseToken = crypto.randomUUID();
    const expiresAt = now + ttl;

    const leaseRecord = {
      workerId,
      leaseToken,
      acquiredAt: now,
      expiresAt,
      lastHeartbeat: now,
      metadata: { ...metadata },
    };

    this.leases.set(workerId, leaseRecord);
    this.stats.acquiredTotal++;

    return {
      acquired: true,
      leaseToken,
      expiresAt,
      activeCount: this.leases.size,
    };
  }

  /**
   * Renews an existing lease, refreshing its expiration timestamp.
   * @param {string} workerId
   * @param {string} leaseToken
   * @param {number} [extendMs]
   * @returns {{ renewed: boolean, expiresAt?: number, reason?: string }}
   */
  heartbeat(workerId, leaseToken, extendMs) {
    if (!workerId || !leaseToken) {
      return { renewed: false, reason: 'MISSING_CREDENTIALS' };
    }

    const now = this.clockFn();
    this.evictExpired(now);

    const lease = this.leases.get(workerId);
    if (!lease) {
      return { renewed: false, reason: 'LEASE_NOT_FOUND_OR_EXPIRED' };
    }

    if (lease.leaseToken !== leaseToken) {
      return { renewed: false, reason: 'INVALID_LEASE_TOKEN' };
    }

    const extension = Number.isFinite(extendMs) && extendMs >= 100 ? extendMs : this.defaultTtlMs;
    lease.expiresAt = now + extension;
    lease.lastHeartbeat = now;

    return {
      renewed: true,
      expiresAt: lease.expiresAt,
    };
  }

  /**
   * Voluntarily releases an active lease slot.
   * @param {string} workerId
   * @param {string} leaseToken
   * @returns {{ released: boolean, reason?: string }}
   */
  releaseLease(workerId, leaseToken) {
    if (!workerId || !leaseToken) {
      return { released: false, reason: 'MISSING_CREDENTIALS' };
    }

    const now = this.clockFn();
    this.evictExpired(now);

    const lease = this.leases.get(workerId);
    if (!lease) {
      return { released: false, reason: 'LEASE_NOT_FOUND_OR_EXPIRED' };
    }

    if (lease.leaseToken !== leaseToken) {
      return { released: false, reason: 'INVALID_LEASE_TOKEN' };
    }

    this.leases.delete(workerId);
    this.stats.releasedTotal++;

    return { released: true };
  }

  /**
   * Returns point-in-time snapshot of manager metrics and lease allocations.
   * @returns {Object}
   */
  getSnapshot() {
    const now = this.clockFn();
    this.evictExpired(now);

    const activeList = [];
    for (const [id, lease] of this.leases.entries()) {
      activeList.push({
        workerId: id,
        acquiredAt: lease.acquiredAt,
        expiresAt: lease.expiresAt,
        ttlRemainingMs: Math.max(0, lease.expiresAt - now),
        metadata: { ...lease.metadata },
      });
    }

    return {
      activeCount: this.leases.size,
      maxConcurrency: this.maxConcurrency,
      availableCapacity: Math.max(0, this.maxConcurrency - this.leases.size),
      acquiredTotal: this.stats.acquiredTotal,
      expiredTotal: this.stats.expiredTotal,
      releasedTotal: this.stats.releasedTotal,
      rejectedTotal: this.stats.rejectedTotal,
      activeLeases: activeList,
    };
  }
}
