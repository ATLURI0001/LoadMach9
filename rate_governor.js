/**
 * LoadMach9: High-Performance Concurrent Virtual User (VU) Rate Governor & Concurrency Pool
 * Implements token-bucket pacing, SLA latency feedback, and adaptive backpressure.
 */

export class VuRateGovernor {
  /**
   * @param {Object} options
   * @param {number} [options.targetRps=100] Target requests per second
   * @param {number} [options.burstCapacity=200] Maximum token bucket capacity
   * @param {number} [options.maxConcurrency=50] Maximum active concurrent virtual users
   * @param {number} [options.slaThresholdMs=250] Maximum acceptable p99 latency SLA
   * @param {number} [options.backpressureStep=0.1] Throttling step on SLA breach
   */
  constructor(options = {}) {
    this.targetRps = Math.max(1, Number(options.targetRps) || 100);
    this.burstCapacity = options.burstCapacity !== undefined
      ? Math.max(1, Number(options.burstCapacity))
      : Math.max(this.targetRps, this.targetRps * 2);
    this.maxConcurrency = Math.max(1, Number(options.maxConcurrency) || 50);
    this.slaThresholdMs = Math.max(10, Number(options.slaThresholdMs) || 250);
    this.backpressureStep = Math.min(0.5, Math.max(0.01, Number(options.backpressureStep) || 0.1));

    // Token bucket state
    this.tokens = this.burstCapacity;
    this.lastRefill = Date.now();

    // Concurrency pool state
    this.activeWorkers = 0;
    this.queue = [];

    // Adaptive backpressure multiplier: 1.0 = full throughput, 0.1 = maximum throttle
    this.throttleFactor = 1.0;

    // Rolling latency window for SLA tracking (max 256 samples)
    this.latencies = [];
    this.maxLatencyWindow = 256;

    // Operational statistics
    this.stats = {
      admitted: 0,
      rejected: 0,
      throttled: 0,
      completed: 0,
      slaBreaches: 0,
    };
  }

  /**
   * Refills tokens based on elapsed wall-clock time and active throttle factor.
   * @private
   */
  _refillTokens() {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefill) / 1000.0;
    if (elapsedSec > 0) {
      const effectiveRps = this.targetRps * this.throttleFactor;
      const addedTokens = elapsedSec * effectiveRps;
      this.tokens = Math.min(this.burstCapacity, this.tokens + addedTokens);
      this.lastRefill = now;
    }
  }

  /**
   * Attempts to acquire execution permission for a virtual user.
   * @returns {boolean} True if permission granted, false if rejected/throttled.
   */
  tryAcquire() {
    this._refillTokens();

    if (this.activeWorkers >= this.maxConcurrency) {
      this.stats.rejected++;
      return false;
    }

    if (this.tokens < 1.0) {
      this.stats.throttled++;
      return false;
    }

    this.tokens -= 1.0;
    this.activeWorkers++;
    this.stats.admitted++;
    return true;
  }

  /**
   * Releases an active worker back to the pool and records task completion.
   */
  release() {
    if (this.activeWorkers > 0) {
      this.activeWorkers--;
      this.stats.completed++;
    }
  }

  /**
   * Records observed completion latency to evaluate SLA compliance and tune backpressure.
   * @param {number} latencyMs
   */
  recordLatency(latencyMs) {
    if (typeof latencyMs !== 'number' || isNaN(latencyMs) || latencyMs < 0) {
      return;
    }

    this.latencies.push(latencyMs);
    if (this.latencies.length > this.maxLatencyWindow) {
      this.latencies.shift();
    }

    // Evaluate rolling SLA breaches
    const p99 = this.getPercentileLatency(0.99);
    if (p99 > this.slaThresholdMs) {
      this.stats.slaBreaches++;
      // Apply multiplicative backpressure
      this.throttleFactor = Math.max(0.1, this.throttleFactor - this.backpressureStep);
    } else if (this.throttleFactor < 1.0) {
      // Additive recovery
      this.throttleFactor = Math.min(1.0, this.throttleFactor + (this.backpressureStep * 0.5));
    }
  }

  /**
   * Calculates percentile latency from the active rolling window.
   * @param {number} p Percentile between 0.0 and 1.0
   * @returns {number}
   */
  getPercentileLatency(p = 0.99) {
    if (this.latencies.length === 0) return 0;
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
    return sorted[index];
  }

  /**
   * Returns current operational telemetry snapshot.
   * @returns {Object}
   */
  getTelemetry() {
    return {
      targetRps: this.targetRps,
      effectiveRps: Math.round(this.targetRps * this.throttleFactor * 100) / 100,
      activeWorkers: this.activeWorkers,
      maxConcurrency: this.maxConcurrency,
      availableTokens: Math.floor(this.tokens * 10) / 10,
      throttleFactor: Math.round(this.throttleFactor * 1000) / 1000,
      p50LatencyMs: this.getPercentileLatency(0.50),
      p99LatencyMs: this.getPercentileLatency(0.99),
      stats: { ...this.stats },
    };
  }

  /**
   * Resets governor state and counters.
   */
  reset() {
    this.tokens = this.burstCapacity;
    this.lastRefill = Date.now();
    this.activeWorkers = 0;
    this.throttleFactor = 1.0;
    this.latencies = [];
    this.stats = {
      admitted: 0,
      rejected: 0,
      throttled: 0,
      completed: 0,
      slaBreaches: 0,
    };
  }
}
