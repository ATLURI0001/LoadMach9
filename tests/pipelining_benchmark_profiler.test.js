import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PipeliningBenchmarkProfiler,
  normalizeProfilerOptions,
  computePipeliningSpeedup,
  detectHeadOfLineBlocking,
} from '../pipelining_benchmark_profiler.js';

describe('PipeliningBenchmarkProfiler Suite', () => {
  it('normalizes profiler options with resilient defaults', () => {
    const opts = normalizeProfilerOptions();
    assert.deepEqual(opts.pipeliningDepths, [1, 2, 4, 8, 16]);
    assert.equal(opts.holBlockingThreshold, 2.5);
    assert.equal(opts.minSaturationGainPct, 5.0);

    const custom = normalizeProfilerOptions({
      pipeliningDepths: [10, 2, 2, 5, 1],
      holBlockingThreshold: 3.0,
      minSaturationGainPct: 10.0,
    });
    assert.deepEqual(custom.pipeliningDepths, [1, 2, 5, 10]);
    assert.equal(custom.holBlockingThreshold, 3.0);
    assert.equal(custom.minSaturationGainPct, 10.0);
  });

  it('computes pipelining speedup and efficiency correctly', () => {
    const res = computePipeliningSpeedup(10000, 35000, 4);
    assert.equal(res.speedupFactor, 3.5);
    assert.equal(res.efficiencyPct, 87.5);
    assert.equal(res.theoreticalMax, 4);

    // Fallback on zero / non-finite inputs
    const fallback = computePipeliningSpeedup(0, 0, 4);
    assert.equal(fallback.speedupFactor, 1.0);
    assert.equal(fallback.efficiencyPct, 100.0);
  });

  it('detects Head-of-Line (HoL) blocking on tail latency inflation', () => {
    // Normal latency: 10ms -> 15ms (1.5x <= 2.5x threshold)
    const normal = detectHeadOfLineBlocking(10, 15, 2.5);
    assert.equal(normal.holDetected, false);
    assert.equal(normal.holIndex, 1.5);
    assert.equal(normal.inflationPct, 50.0);

    // Inflated latency: 10ms -> 32ms (3.2x >= 2.5x threshold)
    const blocked = detectHeadOfLineBlocking(10, 32, 2.5);
    assert.equal(blocked.holDetected, true);
    assert.equal(blocked.holIndex, 3.2);
    assert.equal(blocked.inflationPct, 220.0);

    // Non-finite fallback
    const fallback = detectHeadOfLineBlocking(0, 0);
    assert.equal(fallback.holDetected, false);
    assert.equal(fallback.holIndex, 1.0);
  });

  it('evaluates multi-depth trials and identifies optimal depth and HoL warnings', () => {
    const profiler = new PipeliningBenchmarkProfiler({ holBlockingThreshold: 2.5 });

    // Record progressive trials
    profiler.recordTrial(1, { rps: 10000, p50: 5, p90: 10, p99: 15, bytesPerSec: 1000000 });
    profiler.recordTrial(2, { rps: 18000, p50: 6, p90: 12, p99: 18, bytesPerSec: 1800000 });
    profiler.recordTrial(4, { rps: 32000, p50: 8, p90: 16, p99: 25, bytesPerSec: 3200000 });
    profiler.recordTrial(8, { rps: 38000, p50: 15, p90: 30, p99: 45, bytesPerSec: 3800000 }); // P99 = 45 vs baseline 15 -> 3x HoL!
    profiler.recordTrial(16, { rps: 39000, p50: 35, p90: 60, p99: 90, bytesPerSec: 3900000 }); // P99 = 90 vs baseline 15 -> 6x HoL!

    const evalResult = profiler.evaluate();
    assert.equal(evalResult.baselineRps, 10000);
    // Depths 8 and 16 triggered HoL blocking, so optimal non-blocked depth should be 4
    assert.equal(evalResult.optimalDepth, 4);
    assert.equal(evalResult.holBlockingWarnings.length, 2);
    assert.equal(evalResult.holBlockingWarnings[0].depth, 8);
    assert.equal(evalResult.holBlockingWarnings[1].depth, 16);

    // Markdown report generation
    const report = profiler.generateMarkdownReport();
    assert.ok(report.includes('| 4 | 32,000 | 3.2x |'));
    assert.ok(report.includes(`**Recommended Optimal Depth:** ${evalResult.optimalDepth}`));
    assert.ok(report.includes('Head-of-Line Blocking Warnings:'));
  });

  it('handles empty trials gracefully and supports state reset', () => {
    const profiler = new PipeliningBenchmarkProfiler();
    const emptyEval = profiler.evaluate();
    assert.equal(emptyEval.optimalDepth, 1);
    assert.equal(emptyEval.maxThroughputRps, 0);

    profiler.recordTrial(1, { rps: 5000 });
    assert.equal(profiler.evaluate().baselineRps, 5000);

    profiler.reset();
    assert.equal(profiler.evaluate().maxThroughputRps, 0);
  });
});
