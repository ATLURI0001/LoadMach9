import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  compensateCoordinatedOmission,
  Rfc3550JitterProfiler,
} from '../coordinated_omission.js';

describe('Coordinated Omission Compensator', () => {
  test('should not inject virtual samples when latencies are within expected interval', () => {
    const raw = [5, 8, 4, 9, 7];
    const res = compensateCoordinatedOmission(raw, 10);
    assert.equal(res.omittedCount, 0);
    assert.equal(res.compensatedLatenciesMs.length, 5);
    assert.deepEqual(res.compensatedLatenciesMs, raw);
  });

  test('should accurately backfill virtual latencies during coordinated omission stalls', () => {
    // 1 request took 100ms when requests were expected every 20ms (Target: 50 RPS)
    // Should backfill: 80ms, 60ms, 40ms, 20ms (4 omitted requests)
    const raw = [100];
    const res = compensateCoordinatedOmission(raw, 20);
    assert.equal(res.omittedCount, 4);
    assert.equal(res.compensatedLatenciesMs.length, 5);
    assert.deepEqual(res.compensatedLatenciesMs, [100, 80, 60, 40, 20]);
    assert.equal(res.meanCompensated, (100 + 80 + 60 + 40 + 20) / 5);
  });

  test('should ignore NaN, negative, and non-numeric latencies safely', () => {
    const raw = [10, -5, NaN, 20, 'invalid'];
    const res = compensateCoordinatedOmission(raw, 15);
    // Only 10 and 20 are valid. 20 > 15 -> injects 20 - 15 = 5.
    assert.equal(res.omittedCount, 1);
    assert.deepEqual(res.compensatedLatenciesMs, [10, 20, 5]);
  });

  test('should throw on invalid arguments', () => {
    assert.throws(() => compensateCoordinatedOmission('not-an-array', 10), TypeError);
    assert.throws(() => compensateCoordinatedOmission([10], 0), RangeError);
    assert.throws(() => compensateCoordinatedOmission([10], -5), RangeError);
  });
});

describe('RFC 3550 Inter-Arrival Jitter Profiler', () => {
  test('should report zero jitter for perfectly constant transit intervals', () => {
    const profiler = new Rfc3550JitterProfiler();

    // Constant 10ms transit time across 10 packets
    for (let i = 0; i < 10; i++) {
      const send = i * 20;
      const recv = send + 10;
      profiler.record(send, recv);
    }

    const summary = profiler.getSummary();
    assert.equal(summary.samples, 10);
    assert.equal(summary.jitterMs, 0.0);
    assert.equal(summary.maxJitterMs, 0.0);
    assert.equal(summary.meanAbsoluteDeltaMs, 0.0);
  });

  test('should accurately compute smoothed jitter under oscillating latency delays', () => {
    const profiler = new Rfc3550JitterProfiler({ smoothingFactor: 16 });

    // Sample 1: send 0, recv 10 (transit = 10)
    const s1 = profiler.record(0, 10);
    assert.equal(s1.currentJitterMs, 0.0);

    // Sample 2: send 20, recv 46 (transit = 26, delta = |26 - 10| = 16)
    // Jitter = 0 + (16 - 0) / 16 = 1.0
    const s2 = profiler.record(20, 46);
    assert.equal(s2.deltaMs, 16.0);
    assert.equal(s2.currentJitterMs, 1.0);

    // Sample 3: send 40, recv 50 (transit = 10, delta = |10 - 26| = 16)
    // Jitter = 1.0 + (16 - 1.0) / 16 = 1.0 + 15 / 16 = 1.9375
    const s3 = profiler.record(40, 50);
    assert.equal(s3.deltaMs, 16.0);
    assert.equal(s3.currentJitterMs, 1.9375);

    const summary = profiler.getSummary();
    assert.equal(summary.samples, 3);
    assert.equal(summary.meanAbsoluteDeltaMs, 16.0);
  });

  test('should support state reset and validate input parameters', () => {
    const profiler = new Rfc3550JitterProfiler();
    profiler.record(0, 15);
    profiler.record(10, 40);
    assert.equal(profiler.getSummary().samples, 2);

    profiler.reset();
    assert.equal(profiler.getSummary().samples, 0);
    assert.equal(profiler.getSummary().jitterMs, 0);

    assert.throws(() => new Rfc3550JitterProfiler({ smoothingFactor: 0 }), RangeError);
    assert.throws(() => profiler.record(NaN, 10), TypeError);
  });
});
