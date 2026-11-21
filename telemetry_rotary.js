'use strict';

/**
 * TelemetryRotary & SLA Violation Engine for LoadMach9
 * Tracks real-time load test metrics, percentile distributions, and enforces SLA contracts.
 */

class TelemetryRotary {
  /**
   * @param {Object} [options]
   * @param {number} [options.maxErrorRate=0.01] Maximum permissible error fraction (e.g. 0.01 = 1%)
   * @param {number} [options.maxP99LatencyMs=250] Maximum acceptable p99 latency in ms
   * @param {number} [options.minThroughputRps=100] Minimum expected sustained throughput in requests/sec
   * @param {number} [options.warningThresholdRatio=0.85] Margin ratio to mark status AT_RISK
   */
  constructor(options = {}) {
    this.maxErrorRate = options.maxErrorRate ?? 0.01;
    this.maxP99LatencyMs = options.maxP99LatencyMs ?? 250;
    this.minThroughputRps = options.minThroughputRps ?? 100;
    this.warningThresholdRatio = options.warningThresholdRatio ?? 0.85;

    this.reset();
  }

  reset() {
    this.totalRequests = 0;
    this.statusCodes = new Map();
    this.latencies = [];
    this.startTime = null;
    this.endTime = null;
    this.slaViolations = [];
  }

  /**
   * Record a single completed request event.
   * @param {number} statusCode HTTP response code (e.g. 200, 500) or 0 for network failure
   * @param {number} latencyMs Request latency in milliseconds
   * @param {number} [timestamp=Date.now()]
   */
  recordRequest(statusCode, latencyMs, timestamp = Date.now()) {
    if (this.startTime === null || timestamp < this.startTime) {
      this.startTime = timestamp;
    }
    if (this.endTime === null || timestamp > this.endTime) {
      this.endTime = timestamp;
    }

    this.totalRequests++;

    const code = Number(statusCode) || 0;
    this.statusCodes.set(code, (this.statusCodes.get(code) || 0) + 1);

    const lat = Math.max(0, Number(latencyMs) || 0);
    this.latencies.push(lat);
  }

  /**
   * Calculates percentile value from recorded latencies.
   * @param {number} percentile Number between 0 and 100
   * @returns {number}
   */
  getPercentile(percentile) {
    if (this.latencies.length === 0) return 0;
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
  }

  /**
   * Returns total error count (status >= 400 or status == 0).
   * @returns {number}
   */
  getErrorCount() {
    let errors = 0;
    for (const [code, count] of this.statusCodes.entries()) {
      if (code === 0 || code >= 400) {
        errors += count;
      }
    }
    return errors;
  }

  /**
   * Current error fraction [0.0, 1.0].
   * @returns {number}
   */
  getErrorRate() {
    if (this.totalRequests === 0) return 0.0;
    return this.getErrorCount() / this.totalRequests;
  }

  /**
   * Calculate effective duration in seconds.
   * @returns {number}
   */
  getDurationSeconds() {
    if (!this.startTime || !this.endTime || this.endTime <= this.startTime) {
      return 0.001;
    }
    return Math.max(0.001, (this.endTime - this.startTime) / 1000);
  }

  /**
   * Calculate overall throughput in requests per second.
   * @returns {number}
   */
  getThroughputRps() {
    if (this.totalRequests === 0) return 0;
    const dur = this.getDurationSeconds();
    return Number((this.totalRequests / dur).toFixed(2));
  }

  /**
   * Evaluate SLA compliance against configured limits.
   * @returns {{
   *   status: 'COMPLIANT' | 'AT_RISK' | 'BREACHED',
   *   isCompliant: boolean,
   *   violations: Array<{metric: string, observed: number, threshold: number, severity: string, message: string}>,
   *   metrics: Object
   * }}
   */
  evaluateSLA() {
    const errorRate = this.getErrorRate();
    const p99 = this.getPercentile(99);
    const throughput = this.getThroughputRps();

    const violations = [];
    let hasBreach = false;
    let hasRisk = false;

    // 1. Error Rate Check
    if (errorRate > this.maxErrorRate) {
      hasBreach = true;
      violations.push({
        metric: 'error_rate',
        observed: Number(errorRate.toFixed(4)),
        threshold: this.maxErrorRate,
        severity: 'CRITICAL',
        message: `Error rate ${(errorRate * 100).toFixed(2)}% breached SLA maximum ${(this.maxErrorRate * 100).toFixed(2)}%`
      });
    } else if (errorRate >= this.maxErrorRate * this.warningThresholdRatio && this.maxErrorRate > 0) {
      hasRisk = true;
      violations.push({
        metric: 'error_rate',
        observed: Number(errorRate.toFixed(4)),
        threshold: this.maxErrorRate,
        severity: 'WARNING',
        message: `Error rate ${(errorRate * 100).toFixed(2)}% nearing SLA limit`
      });
    }

    // 2. P99 Latency Check
    if (p99 > this.maxP99LatencyMs) {
      hasBreach = true;
      violations.push({
        metric: 'p99_latency_ms',
        observed: p99,
        threshold: this.maxP99LatencyMs,
        severity: 'CRITICAL',
        message: `P99 latency ${p99}ms breached SLA limit ${this.maxP99LatencyMs}ms`
      });
    } else if (p99 >= this.maxP99LatencyMs * this.warningThresholdRatio) {
      hasRisk = true;
      violations.push({
        metric: 'p99_latency_ms',
        observed: p99,
        threshold: this.maxP99LatencyMs,
        severity: 'WARNING',
        message: `P99 latency ${p99}ms approaching SLA ceiling`
      });
    }

    // 3. Minimum Throughput Check (only if test has meaningful duration > 0.5s and > 20 requests)
    if (this.totalRequests >= 20 && this.getDurationSeconds() >= 0.5) {
      if (throughput < this.minThroughputRps) {
        hasBreach = true;
        violations.push({
          metric: 'throughput_rps',
          observed: throughput,
          threshold: this.minThroughputRps,
          severity: 'CRITICAL',
          message: `Throughput ${throughput} req/s below SLA minimum ${this.minThroughputRps} req/s`
        });
      }
    }

    let status = 'COMPLIANT';
    if (hasBreach) {
      status = 'BREACHED';
    } else if (hasRisk) {
      status = 'AT_RISK';
    }

    this.slaViolations = violations;

    return {
      status,
      isCompliant: !hasBreach,
      violations,
      metrics: {
        totalRequests: this.totalRequests,
        errorRate: Number(errorRate.toFixed(4)),
        p50LatencyMs: this.getPercentile(50),
        p90LatencyMs: this.getPercentile(90),
        p99LatencyMs: p99,
        throughputRps: throughput
      }
    };
  }

  /**
   * Formats current metrics in standard Prometheus exposition text.
   * @param {string} [jobLabel='loadmach9']
   * @returns {string}
   */
  exportPrometheus(jobLabel = 'loadmach9') {
    const p50 = this.getPercentile(50);
    const p90 = this.getPercentile(90);
    const p99 = this.getPercentile(99);
    const sla = this.evaluateSLA();
    const errorCount = this.getErrorCount();
    const throughput = this.getThroughputRps();

    const lines = [
      `# HELP loadmach9_requests_total Total number of simulated requests`,
      `# TYPE loadmach9_requests_total counter`,
      `loadmach9_requests_total{job="${jobLabel}"} ${this.totalRequests}`,
      `# HELP loadmach9_errors_total Total number of failed HTTP requests`,
      `# TYPE loadmach9_errors_total counter`,
      `loadmach9_errors_total{job="${jobLabel}"} ${errorCount}`,
      `# HELP loadmach9_latency_ms Latency percentiles in milliseconds`,
      `# TYPE loadmach9_latency_ms gauge`,
      `loadmach9_latency_ms{job="${jobLabel}",quantile="0.50"} ${p50}`,
      `loadmach9_latency_ms{job="${jobLabel}",quantile="0.90"} ${p90}`,
      `loadmach9_latency_ms{job="${jobLabel}",quantile="0.99"} ${p99}`,
      `# HELP loadmach9_throughput_rps Effective load throughput in requests per second`,
      `# TYPE loadmach9_throughput_rps gauge`,
      `loadmach9_throughput_rps{job="${jobLabel}"} ${throughput}`,
      `# HELP loadmach9_sla_compliant Binary SLA compliance state (1 = compliant, 0 = breached)`,
      `# TYPE loadmach9_sla_compliant gauge`,
      `loadmach9_sla_compliant{job="${jobLabel}"} ${sla.isCompliant ? 1 : 0}`,
      `# HELP loadmach9_sla_violations_total Total active SLA violations observed`,
      `# TYPE loadmach9_sla_violations_total gauge`,
      `loadmach9_sla_violations_total{job="${jobLabel}"} ${sla.violations.length}`
    ];

    // Status breakdown
    for (const [code, count] of this.statusCodes.entries()) {
      lines.push(`loadmach9_http_status_total{job="${jobLabel}",status="${code}"} ${count}`);
    }

    return lines.join('\n') + '\n';
  }
}

export {
  TelemetryRotary
};
