import test from 'node:test';
import assert from 'node:assert/strict';
import { PayloadPoolProfiler } from '../payload_pool_profiler.js';

test('PayloadPoolProfiler - reuses pooled buffers with 100% hit rate when within capacity', () => {
  const profiler = new PayloadPoolProfiler(64, 1024);
  const res = profiler.runBenchmark(32, 20);

  assert.equal(res.poolHitRatePct, 100);
  assert.ok(res.p50Microseconds >= 0);
  assert.ok(res.throughputOpsSec > 0);
});

test('PayloadPoolProfiler - tracks misses when demand exceeds pool size', () => {
  const profiler = new PayloadPoolProfiler(10, 512);
  const res = profiler.runBenchmark(20, 1);

  assert.equal(res.poolHitRatePct, 50);
});
