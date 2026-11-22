/**
 * LoadMach9 - Chaos Fault Injection Engine & Network Partition Simulator
 *
 * Provides fine-grained chaos engineering primitives for HTTP servers and microservice
 * load generators. Simulates latency jitter, HTTP fault statuses, network connection aborts,
 * and enforces strict blast-radius failure budgets.
 */

export class ChaosFaultInjector {
  /**
   * @param {Object} options
   * @param {boolean} [options.enabled=true] Master switch
   * @param {number} [options.faultRate=0.0] Global fault probability (0.0 to 1.0)
   * @param {number} [options.maxFaultsPerWindow=100] Blast radius limit (max faults per window)
   * @param {number} [options.windowMs=60000] Blast radius sliding window in ms
   * @param {Object} [options.latencyJitter] Latency injection config
   * @param {number} [options.latencyJitter.minMs=0]
   * @param {number} [options.latencyJitter.maxMs=0]
   * @param {'uniform'|'gaussian'|'pareto'} [options.latencyJitter.distribution='uniform']
   * @param {Array<{status: number, weight?: number, message?: string}>} [options.errorFaults]
   * @param {number} [options.abortRate=0.0] Probability of connection abort given a fault
   * @param {Array<string|RegExp>} [options.targetPaths] Paths to inject faults into (defaults to all)
   * @param {Array<string|RegExp>} [options.excludePaths] Paths to exclude from chaos
   */
  constructor(options = {}) {
    this.enabled = options.enabled ?? true;
    this.faultRate = Math.min(Math.max(options.faultRate ?? 0.0, 0.0), 1.0);
    this.maxFaultsPerWindow = options.maxFaultsPerWindow ?? 100;
    this.windowMs = options.windowMs ?? 60000;
    this.abortRate = Math.min(Math.max(options.abortRate ?? 0.0, 0.0), 1.0);
    this.targetPaths = options.targetPaths ?? [];
    this.excludePaths = options.excludePaths ?? [];

    this.latencyJitter = {
      minMs: options.latencyJitter?.minMs ?? 0,
      maxMs: options.latencyJitter?.maxMs ?? 0,
      distribution: options.latencyJitter?.distribution ?? 'uniform',
    };

    this.errorFaults = options.errorFaults && options.errorFaults.length > 0
      ? options.errorFaults.map(f => ({
          status: f.status || 500,
          weight: Math.max(f.weight ?? 1, 1),
          message: f.message || `Synthetic Chaos Error (${f.status || 500})`
        }))
      : [{ status: 500, weight: 1, message: 'Synthetic Chaos Internal Error (500)' }];

    // Blast-radius sliding window timestamps
    this.faultTimestamps = [];

    // Telemetry counters
    this.telemetry = {
      totalRequests: 0,
      injectedFaults: 0,
      latencyInjectedCount: 0,
      errorsInjectedCount: 0,
      abortsInjectedCount: 0,
      budgetExhaustedCount: 0,
    };
  }

  /**
   * Evaluates if a given request path matches targeting criteria
   * @param {string} path
   * @returns {boolean}
   */
  matchesPath(path) {
    if (!path) return true;

    for (const rule of this.excludePaths) {
      if (rule instanceof RegExp && rule.test(path)) return false;
      if (typeof rule === 'string' && (path === rule || path.startsWith(rule))) return false;
    }

    if (!this.targetPaths || this.targetPaths.length === 0) return true;

    for (const rule of this.targetPaths) {
      if (rule instanceof RegExp && rule.test(path)) return true;
      if (typeof rule === 'string' && (path === rule || path.startsWith(rule))) return true;
    }

    return false;
  }

  /**
   * Checks sliding window budget for blast radius safety
   * @param {number} [now=Date.now()]
   * @returns {boolean} True if within budget, false if exhausted
   */
  checkAndRecordBudget(now = Date.now()) {
    const cutoff = now - this.windowMs;
    // Evict old timestamps
    while (this.faultTimestamps.length > 0 && this.faultTimestamps[0] < cutoff) {
      this.faultTimestamps.shift();
    }

    if (this.faultTimestamps.length >= this.maxFaultsPerWindow) {
      this.telemetry.budgetExhaustedCount++;
      return false;
    }

    this.faultTimestamps.push(now);
    return true;
  }

  /**
   * Generates latency delay in ms according to configured distribution
   * @returns {number}
   */
  calculateLatency() {
    const { minMs, maxMs, distribution } = this.latencyJitter;
    if (maxMs <= minMs || maxMs <= 0) return 0;

    const span = maxMs - minMs;
    if (distribution === 'gaussian') {
      // Box-Muller transform
      const u1 = Math.max(Math.random(), 1e-9);
      const u2 = Math.random();
      const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
      // z0 is standard normal (mean 0, std 1). Map to [min, max] with 99.7% within span
      const normalized = Math.min(Math.max((z0 / 6.0) + 0.5, 0), 1);
      return Math.round(minMs + normalized * span);
    }

    if (distribution === 'pareto') {
      // Bounded Pareto distribution (alpha = 1.5)
      const alpha = 1.5;
      const u = Math.random();
      const sample = 1 / Math.pow(1 - u * (1 - Math.pow(1 + span, -alpha)), 1 / alpha) - 1;
      return Math.round(minMs + Math.min(sample, span));
    }

    // Default uniform
    return Math.round(minMs + Math.random() * span);
  }

  /**
   * Selects an error fault based on relative weights
   * @returns {{status: number, message: string}}
   */
  selectError() {
    const totalWeight = this.errorFaults.reduce((sum, f) => sum + f.weight, 0);
    let r = Math.random() * totalWeight;
    for (const fault of this.errorFaults) {
      r -= fault.weight;
      if (r <= 0) return { status: fault.status, message: fault.message };
    }
    return { status: this.errorFaults[0].status, message: this.errorFaults[0].message };
  }

  /**
   * Evaluates if a fault should be injected for the request
   * @param {string} [path='/']
   * @returns {{shouldInject: boolean, latencyMs: number, error: {status: number, message: string}|null, abort: boolean}}
   */
  decide(path = '/') {
    this.telemetry.totalRequests++;

    if (!this.enabled || this.faultRate <= 0.0) {
      return { shouldInject: false, latencyMs: 0, error: null, abort: false };
    }

    if (!this.matchesPath(path)) {
      return { shouldInject: false, latencyMs: 0, error: null, abort: false };
    }

    if (Math.random() >= this.faultRate) {
      return { shouldInject: false, latencyMs: 0, error: null, abort: false };
    }

    // Attempt to acquire budget
    if (!this.checkAndRecordBudget()) {
      return { shouldInject: false, latencyMs: 0, error: null, abort: false };
    }

    this.telemetry.injectedFaults++;

    const latencyMs = this.calculateLatency();
    if (latencyMs > 0) {
      this.telemetry.latencyInjectedCount++;
    }

    const abort = this.abortRate > 0 && Math.random() < this.abortRate;
    let error = null;

    if (abort) {
      this.telemetry.abortsInjectedCount++;
    } else {
      error = this.selectError();
      this.telemetry.errorsInjectedCount++;
    }

    return {
      shouldInject: true,
      latencyMs,
      error,
      abort,
    };
  }

  /**
   * Helper delay promise
   * @param {number} ms
   * @returns {Promise<void>}
   */
  static delay(ms) {
    if (ms <= 0) return Promise.resolve();
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Express middleware factory
   * @returns {Function}
   */
  expressMiddleware() {
    return async (req, res, next) => {
      const decision = this.decide(req.path || req.url || '/');
      if (!decision.shouldInject) {
        return next();
      }

      if (decision.latencyMs > 0) {
        await ChaosFaultInjector.delay(decision.latencyMs);
      }

      if (decision.abort) {
        if (req.socket && typeof req.socket.destroy === 'function') {
          req.socket.destroy();
          return;
        }
        res.status(502).end('Simulated Connection Reset');
        return;
      }

      if (decision.error) {
        return res.status(decision.error.status).json({
          error: 'ChaosFaultInjected',
          status: decision.error.status,
          message: decision.error.message,
          timestamp: new Date().toISOString()
        });
      }

      next();
    };
  }

  /**
   * Fastify preHandler hook
   * @returns {Function}
   */
  fastifyHook() {
    return async (request, reply) => {
      const decision = this.decide(request.url || '/');
      if (!decision.shouldInject) {
        return;
      }

      if (decision.latencyMs > 0) {
        await ChaosFaultInjector.delay(decision.latencyMs);
      }

      if (decision.abort) {
        if (request.raw?.socket && typeof request.raw.socket.destroy === 'function') {
          request.raw.socket.destroy();
          return;
        }
        reply.code(502).send('Simulated Connection Reset');
        return;
      }

      if (decision.error) {
        reply.code(decision.error.status).send({
          error: 'ChaosFaultInjected',
          status: decision.error.status,
          message: decision.error.message,
          timestamp: new Date().toISOString()
        });
      }
    };
  }

  /**
   * Returns a copy of telemetry counters
   * @returns {Object}
   */
  getTelemetry() {
    return { ...this.telemetry, activeBudgetRemaining: Math.max(0, this.maxFaultsPerWindow - this.faultTimestamps.length) };
  }

  /**
   * Resets all internal counters and budgets
   */
  reset() {
    this.faultTimestamps = [];
    this.telemetry = {
      totalRequests: 0,
      injectedFaults: 0,
      latencyInjectedCount: 0,
      errorsInjectedCount: 0,
      abortsInjectedCount: 0,
      budgetExhaustedCount: 0,
    };
  }
}
