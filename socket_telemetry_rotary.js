'use strict';

/**
 * SocketTelemetryRotary: Low-Level Socket Handshake & TTFB Latency Telemetry Rotary for LoadMach9
 * Tracks TCP connect, TLS negotiation, TTFB, socket pool reuse ratios, and socket error telemetry.
 */

export class SocketTelemetryRotary {
  /**
   * @param {Object} [options]
   * @param {number} [options.capacity=5000] Maximum events retained in circular buffer
   * @param {number} [options.maxP99HandshakeMs=100] Target max acceptable P99 handshake ms
   * @param {number} [options.minKeepAliveRatio=0.8] Target min socket reuse ratio (0.8 = 80%)
   */
  constructor(options = {}) {
    this.capacity = Math.max(1, Number(options.capacity) || 5000);
    this.maxP99HandshakeMs = Number(options.maxP99HandshakeMs) || 100;
    this.minKeepAliveRatio = Number(options.minKeepAliveRatio) || 0.8;

    this.reset();
  }

  reset() {
    this.events = [];
    this.totalConnections = 0;
    this.reusedConnections = 0;
    this.errorCount = 0;
    this.totalBytes = 0;
    this.startTime = null;
    this.endTime = null;
    this.errorCodes = new Map();
  }

  /**
   * Records a socket lifecycle event into the telemetry rotary buffer.
   * @param {Object} event
   * @param {number} event.handshakeMs TCP + TLS connection duration in ms
   * @param {number} event.ttfbMs Time To First Byte in ms
   * @param {number} event.totalDurationMs Full socket request duration in ms
   * @param {number} [event.bytesReceived=0] Total bytes received
   * @param {boolean} [event.isReused=false] Whether connection was reused from socket pool
   * @param {string} [event.errorCode] Optional error string if connection failed
   * @param {number} [event.timestamp=Date.now()]
   */
  recordSocketEvent(event) {
    if (!event || typeof event !== 'object') {
      throw new TypeError('Socket event must be a valid object');
    }

    const handshakeMs = Math.max(0, Number(event.handshakeMs) || 0);
    const ttfbMs = Math.max(0, Number(event.ttfbMs) || 0);
    const totalDurationMs = Math.max(0, Number(event.totalDurationMs) || 0);
    const bytesReceived = Math.max(0, Number(event.bytesReceived) || 0);
    const isReused = Boolean(event.isReused);
    const errorCode = event.errorCode ? String(event.errorCode).trim() : null;
    const ts = Number(event.timestamp) || Date.now();

    if (this.startTime === null || ts < this.startTime) {
      this.startTime = ts;
    }
    if (this.endTime === null || ts > this.endTime) {
      this.endTime = ts;
    }

    this.totalConnections++;
    if (isReused) {
      this.reusedConnections++;
    }
    if (errorCode) {
      this.errorCount++;
      this.errorCodes.set(errorCode, (this.errorCodes.get(errorCode) || 0) + 1);
    }
    this.totalBytes += bytesReceived;

    const record = {
      handshakeMs,
      ttfbMs,
      totalDurationMs,
      bytesReceived,
      isReused,
      errorCode,
      timestamp: ts,
    };

    if (this.events.length >= this.capacity) {
      this.events.shift();
    }
    this.events.push(record);

    return record;
  }

  _computePercentile(sortedArr, pct) {
    if (!sortedArr || sortedArr.length === 0) return 0;
    const idx = Math.min(sortedArr.length - 1, Math.max(0, Math.ceil(pct * sortedArr.length) - 1));
    return sortedArr[idx];
  }

  getSocketTelemetrySummary() {
    if (this.events.length === 0) {
      return {
        totalConnections: 0,
        reusedConnections: 0,
        reuseRatioPct: 0,
        errorCount: 0,
        errorRatePct: 0,
        totalBytes: 0,
        throughputMbPerSec: 0,
        handshakeLatency: { p50Ms: 0, p90Ms: 0, p99Ms: 0, meanMs: 0, maxMs: 0 },
        ttfbLatency: { p50Ms: 0, p90Ms: 0, p99Ms: 0, meanMs: 0, maxMs: 0 },
        isSlaCompliant: true,
      };
    }

    const n = this.events.length;
    const handshakes = this.events.map((e) => e.handshakeMs).sort((a, b) => a - b);
    const ttfbs = this.events.map((e) => e.ttfbMs).sort((a, b) => a - b);

    const sumHandshake = handshakes.reduce((acc, v) => acc + v, 0);
    const sumTtfb = ttfbs.reduce((acc, v) => acc + v, 0);

    const durationSec = Math.max(0.001, ((this.endTime || Date.now()) - (this.startTime || Date.now())) / 1000);
    const mbPerSec = (this.totalBytes / (1024 * 1024)) / durationSec;

    const p99Handshake = this._computePercentile(handshakes, 0.99);
    const reuseRatioPct = Number(((this.reusedConnections / this.totalConnections) * 100).toFixed(2));
    const errorRatePct = Number(((this.errorCount / this.totalConnections) * 100).toFixed(2));

    const isSlaCompliant = p99Handshake <= this.maxP99HandshakeMs && (reuseRatioPct / 100) >= this.minKeepAliveRatio;

    return {
      totalConnections: this.totalConnections,
      reusedConnections: this.reusedConnections,
      reuseRatioPct,
      errorCount: this.errorCount,
      errorRatePct,
      totalBytes: this.totalBytes,
      throughputMbPerSec: Number(mbPerSec.toFixed(3)),
      handshakeLatency: {
        p50Ms: Number(this._computePercentile(handshakes, 0.5).toFixed(2)),
        p90Ms: Number(this._computePercentile(handshakes, 0.9).toFixed(2)),
        p99Ms: Number(p99Handshake.toFixed(2)),
        meanMs: Number((sumHandshake / n).toFixed(2)),
        maxMs: Number((handshakes[handshakes.length - 1] || 0).toFixed(2)),
      },
      ttfbLatency: {
        p50Ms: Number(this._computePercentile(ttfbs, 0.5).toFixed(2)),
        p90Ms: Number(this._computePercentile(ttfbs, 0.9).toFixed(2)),
        p99Ms: Number(this._computePercentile(ttfbs, 0.99).toFixed(2)),
        meanMs: Number((sumTtfb / n).toFixed(2)),
        maxMs: Number((ttfbs[ttfbs.length - 1] || 0).toFixed(2)),
      },
      isSlaCompliant,
    };
  }

  exportPrometheusMetrics() {
    const summary = this.getSocketTelemetrySummary();
    const lines = [
      '# HELP loadmach9_socket_connections_total Total socket connections evaluated',
      '# TYPE loadmach9_socket_connections_total counter',
      `loadmach9_socket_connections_total ${summary.totalConnections}`,
      '# HELP loadmach9_socket_reuse_ratio_pct Percentage of reused keep-alive sockets',
      '# TYPE loadmach9_socket_reuse_ratio_pct gauge',
      `loadmach9_socket_reuse_ratio_pct ${summary.reuseRatioPct}`,
      '# HELP loadmach9_socket_handshake_p99_ms 99th percentile socket handshake latency in ms',
      '# TYPE loadmach9_socket_handshake_p99_ms gauge',
      `loadmach9_socket_handshake_p99_ms ${summary.handshakeLatency.p99Ms}`,
      '# HELP loadmach9_socket_ttfb_p90_ms 90th percentile TTFB latency in ms',
      '# TYPE loadmach9_socket_ttfb_p90_ms gauge',
      `loadmach9_socket_ttfb_p90_ms ${summary.ttfbLatency.p90Ms}`,
      '# HELP loadmach9_socket_errors_total Total socket level errors',
      '# TYPE loadmach9_socket_errors_total counter',
      `loadmach9_socket_errors_total ${summary.errorCount}`,
    ];

    for (const [code, count] of this.errorCodes.entries()) {
      lines.push(`loadmach9_socket_error_type{code="${code}"} ${count}`);
    }

    return lines.join('\n') + '\n';
  }
}
