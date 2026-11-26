import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DnsTelemetryRotary } from '../dns_telemetry_rotary.js';

describe('DnsTelemetryRotary Suite', () => {
  it('initializes with default options and clean snapshot', () => {
    const rotary = new DnsTelemetryRotary();
    const snap = rotary.getSnapshot();
    assert.equal(snap.totalQueries, 0);
    assert.equal(snap.activeWindowSize, 0);
    assert.equal(snap.meanDurationMs, 0.0);
  });

  it('records DNS lookups, tracks cache hits, and aggregates quantiles', () => {
    const rotary = new DnsTelemetryRotary({ slaThresholdMs: 15.0 });

    rotary.recordLookup({ host: 'api.example.com', durationMs: 2.5, cacheHit: true });
    rotary.recordLookup({ host: 'api.example.com', durationMs: 5.0, cacheHit: false });
    rotary.recordLookup({ host: 'api.example.com', durationMs: 18.0, cacheHit: false }); // SLA breach
    rotary.recordLookup({ host: 'auth.example.com', durationMs: 22.0, cacheHit: false, errorCode: 'ENOTFOUND' });

    const snap = rotary.getSnapshot();
    assert.equal(snap.totalQueries, 4);
    assert.equal(snap.activeWindowSize, 4);
    assert.equal(snap.cacheHitRatePct, 25.0); // 1 / 4
    assert.equal(snap.slaBreachRatePct, 50.0); // 2 / 4 (> 15ms)
    assert.ok(snap.p50DurationMs >= 5.0);
    assert.ok(snap.p99DurationMs >= 18.0);
    assert.equal(snap.errorsByCode['ENOTFOUND'], 1);
  });

  it('exports valid Prometheus metrics text', () => {
    const rotary = new DnsTelemetryRotary();
    rotary.recordLookup({ host: 'db.internal', durationMs: 4.2, cacheHit: true });

    const prom = rotary.exportPrometheus();
    assert.ok(prom.includes('loadmach9_dns_queries_total 1'));
    assert.ok(prom.includes('loadmach9_dns_cache_hits_total 1'));
    assert.ok(prom.includes('loadmach9_dns_lookup_duration_ms{quantile="0.5"} 4.2'));
  });

  it('evicts oldest entries when rotary buffer capacity is exceeded', () => {
    const rotary = new DnsTelemetryRotary({ capacity: 3 });

    rotary.recordLookup({ host: 'h1', durationMs: 10 });
    rotary.recordLookup({ host: 'h2', durationMs: 20 });
    rotary.recordLookup({ host: 'h3', durationMs: 30 });
    rotary.recordLookup({ host: 'h4', durationMs: 40 });

    const snap = rotary.getSnapshot();
    assert.equal(snap.totalQueries, 4);
    assert.equal(snap.activeWindowSize, 3);
    assert.equal(rotary.events[0].host, 'h2');
    assert.equal(rotary.events[2].host, 'h4');
  });

  it('throws TypeError on invalid lookup parameters', () => {
    const rotary = new DnsTelemetryRotary();
    assert.throws(() => rotary.recordLookup(null), TypeError);
    assert.throws(() => rotary.recordLookup({ host: '', durationMs: 5 }), TypeError);
    assert.throws(() => rotary.recordLookup({ host: 'valid.com', durationMs: -2 }), TypeError);
  });
});
