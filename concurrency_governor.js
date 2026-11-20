/**
 * Adaptive Concurrency Governor based on Little's Law and TCP Vegas AIMD principles.
 * Dynamically adjusts client/worker concurrency limits to maximize throughput while
 * mitigating bufferbloat and queueing-induced tail latency.
 */

class AdaptiveConcurrencyGovernor {
  /**
   * @param {Object} [options]
   * @param {number} [options.initialLimit=10] - Starting concurrency limit.
   * @param {number} [options.minLimit=1] - Minimum permitted concurrency limit.
   * @param {number} [options.maxLimit=1000] - Ceiling concurrency limit.
   * @param {number} [options.alpha=3] - Lower queue threshold for additive increase.
   * @param {number} [options.gamma=6] - Upper queue threshold for multiplicative decrease.
   * @param {number} [options.beta=1] - Concurrency step for additive increase.
   * @param {number} [options.backoffRatio=0.8] - Multiplicative backoff ratio upon congestion (0 < r < 1).
   * @param {number} [options.rttSmoothingAlpha=0.2] - Smoothing coefficient for RTT EWMA (0 < a <= 1).
   * @param {number} [options.windowSize=15] - Sample batch size between limit updates.
   */
  constructor(options = {}) {
    this.initialLimit = Math.max(1, Number(options.initialLimit) || 10);
    this.minLimit = Math.max(1, Number(options.minLimit) || 1);
    this.maxLimit = Math.max(this.minLimit, Number(options.maxLimit) || 1000);
    this.alpha = Math.max(0.5, Number(options.alpha) || 3);
    this.gamma = Math.max(this.alpha + 0.5, Number(options.gamma) || 6);
    this.beta = Math.max(0.1, Number(options.beta) || 1);
    this.backoffRatio = Math.min(0.99, Math.max(0.1, Number(options.backoffRatio) || 0.8));
    this.rttSmoothingAlpha = Math.min(1.0, Math.max(0.01, Number(options.rttSmoothingAlpha) || 0.2));
    this.windowSize = Math.max(2, Math.floor(Number(options.windowSize) || 15));

    this.reset();
  }

  /**
   * Resets governor state to initial parameters.
   */
  reset() {
    this.limit = this.initialLimit;
    this.inFlight = 0;
    this.minRtt = Infinity;
    this.smoothedRtt = 0;
    this.sampleCount = 0;

    this.totalAcquired = 0;
    this.totalDropped = 0;
    this.totalCompleted = 0;
    this.totalFailed = 0;
  }

  /**
   * Attempts to acquire an execution slot.
   * @returns {boolean} True if slot acquired, false if concurrency limit exceeded.
   */
  tryAcquire() {
    if (this.inFlight >= Math.floor(this.limit)) {
      this.totalDropped++;
      return false;
    }
    this.inFlight++;
    this.totalAcquired++;
    return true;
  }

  /**
   * Releases an execution slot and feeds back sample latency and success status.
   * @param {number} latencyMs - Observed round trip execution time in milliseconds.
   * @param {boolean} [isSuccess=true] - Whether execution completed successfully.
   */
  release(latencyMs, isSuccess = true) {
    if (this.inFlight > 0) {
      this.inFlight--;
    }

    const safeLatency = Math.max(0.001, Number(latencyMs) || 0.001);

    if (!isSuccess) {
      this.totalFailed++;
      // Immediate multiplicative backoff on hard failure
      this.limit = Math.max(this.minLimit, this.limit * this.backoffRatio);
      this.sampleCount = 0;
      return;
    }

    this.totalCompleted++;

    if (safeLatency < this.minRtt) {
      this.minRtt = safeLatency;
    }

    if (this.smoothedRtt === 0) {
      this.smoothedRtt = safeLatency;
    } else {
      this.smoothedRtt =
        (1.0 - this.rttSmoothingAlpha) * this.smoothedRtt +
        this.rttSmoothingAlpha * safeLatency;
    }

    this.sampleCount++;

    if (this.sampleCount >= this.windowSize) {
      this._updateLimit();
      this.sampleCount = 0;
    }
  }

  /**
   * Evaluates queue gradient and applies AIMD adjustments.
   * @private
   */
  _updateLimit() {
    if (this.minRtt === Infinity || this.smoothedRtt <= 0) {
      return;
    }

    // Gradient = minRtt / smoothedRtt (values in [0.0, 1.0])
    const gradient = Math.min(1.0, this.minRtt / Math.max(0.001, this.smoothedRtt));

    // Estimated queue backlog = limit * (1 - gradient)
    const queueEstimate = this.limit * (1.0 - gradient);

    if (queueEstimate <= this.alpha) {
      // Underutilized pipeline: Additive increase
      this.limit = Math.min(this.maxLimit, this.limit + this.beta);
    } else if (queueEstimate >= this.gamma) {
      // Congestion detected: Multiplicative decrease
      this.limit = Math.max(this.minLimit, this.limit * this.backoffRatio);
    }
  }

  /**
   * Produces a diagnostic telemetry snapshot.
   * @returns {Object}
   */
  getDiagnostics() {
    const minRtt = this.minRtt === Infinity ? 0 : this.minRtt;
    const gradient = this.smoothedRtt > 0 && minRtt > 0
      ? Math.min(1.0, minRtt / this.smoothedRtt)
      : 1.0;
    const queueEstimate = this.limit * (1.0 - gradient);
    const effectiveLimit = Math.floor(this.limit);

    return {
      limit: Math.round(this.limit * 100) / 100,
      effectiveLimit,
      inFlight: this.inFlight,
      minRttMs: Math.round(minRtt * 100) / 100,
      smoothedRttMs: Math.round(this.smoothedRtt * 100) / 100,
      gradient: Math.round(gradient * 1000) / 1000,
      queueEstimate: Math.round(queueEstimate * 100) / 100,
      saturationRatio: Math.round((this.inFlight / Math.max(1, effectiveLimit)) * 1000) / 1000,
      totalAcquired: this.totalAcquired,
      totalCompleted: this.totalCompleted,
      totalDropped: this.totalDropped,
      totalFailed: this.totalFailed
    };
  }
}

export {
  AdaptiveConcurrencyGovernor
};

export default AdaptiveConcurrencyGovernor;
