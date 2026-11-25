import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SocketTelemetryRotary } from '../socket_telemetry_rotary.js';

describe('SocketTelemetryRotary Suite', () => {
  test('initializes with default options and clean metrics', () => {
    const rotary = new SocketTelemetryRotary();
    const summary = rotary.getSocketTelemetrySummary();
    assert.equal(summary.totalConnections, 0);
    assert.equal(summary.reuseRatioPct, 0);
    assert.equal(summary.errorCount, 0);
    assert.equal(summary.handshakeLatency.p99Ms, 0);
    assert.equal(summary.isSlaCompliant, true);
  });

  test('records socket events and aggregates quantiles', () => {
    const rotary = new SocketTelemetryRotary({ capacity: 50 });

    const baseTs = 100000;
    rotary.recordSocketEvent({
      handshakeMs: 20,
      ttfbMs: 30,
      totalDurationMs: 50,
      bytesReceived: 1024,
      isReused: false,
      timestamp: baseTs,
    });

    rotary.recordSocketEvent({
      handshakeMs: 5,
      ttfbMs: 15,
      totalDurationMs: 25,
      bytesReceived: 2048,
      isReused: true,
      timestamp: baseTs + 500,
    });

    rotary.recordSocketEvent({
      handshakeMs: 4,
      ttfbMs: 12,
      totalDurationMs: 20,
      bytesReceived: 2048,
      isReused: true,
      timestamp: baseTs + 1000,
    });

    const summary = rotary.getSocketTelemetrySummary();
    assert.equal(summary.totalConnections, 3);
    assert.equal(summary.reusedConnections, 2);
    assert.equal(summary.reuseRatioPct, 66.67);
    assert.equal(summary.totalBytes, 5120);
    assert.equal(summary.handshakeLatency.maxMs, 20);
    assert.equal(summary.ttfbLatency.maxMs, 30);
  });

  test('tracks socket error codes and SLA breaches', () => {
    const rotary = new SocketTelemetryRotary({
      maxP99HandshakeMs: 50,
      minKeepAliveRatio: 0.9,
    });

    // High handshake + socket error
    rotary.recordSocketEvent({
      handshakeMs: 120, // Breaches 50ms
      ttfbMs: 100,
      totalDurationMs: 220,
      isReused: false,
      errorCode: 'ECONNRESET',
    });

    const summary = rotary.getSocketTelemetrySummary();
    assert.equal(summary.errorCount, 1);
    assert.equal(summary.errorRatePct, 100.0);
    assert.equal(summary.isSlaCompliant, false);

    const prom = rotary.exportPrometheusMetrics();
    assert.ok(prom.includes('loadmach9_socket_errors_total 1'));
    assert.ok(prom.includes('loadmach9_socket_error_type{code="ECONNRESET"} 1'));
  });

  test('evicts oldest events when capacity is exceeded', () => {
    const rotary = new SocketTelemetryRotary({ capacity: 3 });

    rotary.recordSocketEvent({ handshakeMs: 10, ttfbMs: 10, totalDurationMs: 20 });
    rotary.recordSocketEvent({ handshakeMs: 20, ttfbMs: 20, totalDurationMs: 30 });
    rotary.recordSocketEvent({ handshakeMs: 30, ttfbMs: 30, totalDurationMs: 40 });
    rotary.recordSocketEvent({ handshakeMs: 40, ttfbMs: 40, totalDurationMs: 50 }); // Evicts 10ms

    assert.equal(rotary.events.length, 3);
    assert.equal(rotary.totalConnections, 4); // Cumulative remains 4
    assert.equal(rotary.events[0].handshakeMs, 20);
  });

  test('throws TypeError on invalid event input', () => {
    const rotary = new SocketTelemetryRotary();
    assert.throws(() => rotary.recordSocketEvent(null), TypeError);
  });
});
