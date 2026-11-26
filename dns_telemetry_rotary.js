/**
 * LoadMach9: DNS Lookup Duration & Resolution Telemetry Rotary.
 * 
 * Provides thread-safe circular buffering of DNS resolution metrics,
 * cache hit/miss distributions, resolution latency quantiles (p50/p90/p99),
 * and OpenMetrics Prometheus exports for high-performance load testing.
 */

export class DnsTelemetryRotary {
  constructor(options = {}) {
    this.capacity = Math.max(1, options.capacity ?? 1000);
    this.slaThresholdMs = options.slaThresholdMs ?? 20.0;
    this.events = [];
    this.totalQueries = 0;
    this.cacheHits = 0;
    this.slaBreaches = 0;
    this.errorsByCode = new Map();
  }

  /**
   * Records a DNS lookup event in the rotary buffer.
   */
  recordLookup(event) {
    if (!event || typeof event !== 'object') {
      throw new TypeError('Lookup event must be an object');
    }
    const { host, resolvedIp = null, durationMs, cacheHit = false, status = 'SUCCESS', errorCode = null } = event;

    if (!host || typeof host !== 'string') {
      throw new TypeError('host must be a non-empty string');
    }
    if (typeof durationMs !== 'number' || durationMs < 0 || Number.isNaN(durationMs)) {
      throw new TypeError('durationMs must be a non-negative number');
    }

    const normalizedEvent = {
      host: host.toLowerCase().trim(),
      resolvedIp,
      durationMs: Number(durationMs.toFixed(3)),
      cacheHit: Boolean(cacheHit),
      status: status.toUpperCase(),
      errorCode: errorCode ? String(errorCode) : null,
      timestampMs: event.timestampMs ?? Date.now(),
    };

    this.totalQueries++;
    if (normalizedEvent.cacheHit) {
      this.cacheHits++;
    }
    if (normalizedEvent.durationMs > this.slaThresholdMs) {
      this.slaBreaches++;
    }
    if (normalizedEvent.errorCode) {
      const cnt = this.errorsByCode.get(normalizedEvent.errorCode) ?? 0;
      this.errorsByCode.set(normalizedEvent.errorCode, cnt + 1);
    }

    if (this.events.length >= this.capacity) {
      this.events.shift();
    }
    this.events.push(normalizedEvent);

    return normalizedEvent;
  }

  /**
   * Computes statistical distribution and latency quantiles over the active rotary window.
   */
  getSnapshot() {
    if (this.events.length === 0) {
      return {
        totalQueries: 0,
        activeWindowSize: 0,
        cacheHitRatePct: 100.0,
        slaBreachRatePct: 0.0,
        meanDurationMs: 0.0,
        p50DurationMs: 0.0,
        p90DurationMs: 0.0,
        p99DurationMs: 0.0,
        maxDurationMs: 0.0,
        errorsByCode: {},
      };
    }

    const n = this.events.length;
    const durations = this.events.map((e) => e.durationMs).sort((a, b) => a - b);
    const sumDurations = durations.reduce((acc, v) => acc + v, 0);

    const p50 = durations[Math.floor(n * 0.50)];
    const p90 = durations[Math.min(n - 1, Math.floor(n * 0.90))];
    const p99 = durations[Math.min(n - 1, Math.floor(n * 0.99))];

    const cacheRate = (this.cacheHits / this.totalQueries) * 100.0;
    const slaRate = (this.slaBreaches / this.totalQueries) * 100.0;

    const errorsObj = {};
    for (const [code, count] of this.errorsByCode.entries()) {
      errorsObj[code] = count;
    }

    return {
      totalQueries: this.totalQueries,
      activeWindowSize: n,
      cacheHitRatePct: Number(cacheRate.toFixed(2)),
      slaBreachRatePct: Number(slaRate.toFixed(2)),
      meanDurationMs: Number((sumDurations / n).toFixed(2)),
      p50DurationMs: Number(p50.toFixed(2)),
      p90DurationMs: Number(p90.toFixed(2)),
      p99DurationMs: Number(p99.toFixed(2)),
      maxDurationMs: Number(durations[n - 1].toFixed(2)),
      errorsByCode: errorsObj,
    };
  }

  /**
   * Exports OpenMetrics/Prometheus formatted lines.
   */
  exportPrometheus() {
    const lines = [
      '# HELP loadmach9_dns_queries_total Total DNS lookups executed',
      '# TYPE loadmach9_dns_queries_total counter',
      `loadmach9_dns_queries_total ${this.totalQueries}`,
      '# HELP loadmach9_dns_cache_hits_total Total DNS lookups satisfied from cache',
      '# TYPE loadmach9_dns_cache_hits_total counter',
      `loadmach9_dns_cache_hits_total ${this.cacheHits}`,
      '# HELP loadmach9_dns_sla_breaches_total DNS lookups exceeding latency threshold',
      '# TYPE loadmach9_dns_sla_breaches_total counter',
      `loadmach9_dns_sla_breaches_total ${this.slaBreaches}`,
    ];

    const snapshot = this.getSnapshot();
    lines.push(
      '# HELP loadmach9_dns_lookup_duration_ms DNS resolution latency percentiles',
      '# TYPE loadmach9_dns_lookup_duration_ms gauge',
      `loadmach9_dns_lookup_duration_ms{quantile="0.5"} ${snapshot.p50DurationMs}`,
      `loadmach9_dns_lookup_duration_ms{quantile="0.9"} ${snapshot.p90DurationMs}`,
      `loadmach9_dns_lookup_duration_ms{quantile="0.99"} ${snapshot.p99DurationMs}`
    );

    return lines.join('\n') + '\n';
  }
}
