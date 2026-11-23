'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeLatencySamples,
  computePercentiles,
  computeBasicStats,
  detectSteadyState,
  computeTailRatios,
  profileBenchmarkRun,
  formatProfileMarkdownTable,
} from '../tail_latency_profiler.js';

describe('TailLatencyProfiler Suite', () => {
  describe('sanitizeLatencySamples', () => {
    it('filters out non-numbers, negative values, and NaN/Infinities', () => {
      const input = [10.5, -3, '15.2', NaN, Infinity, -Infinity, null, undefined, 42];
      const clean = sanitizeLatencySamples(input);
      assert.deepEqual(clean, [10.5, 15.2, 0, 42]); // 'null' coerces to 0
    });

    it('returns empty array on non-array inputs', () => {
      assert.deepEqual(sanitizeLatencySamples(null), []);
      assert.deepEqual(sanitizeLatencySamples(undefined), []);
      assert.deepEqual(sanitizeLatencySamples('not-an-array'), []);
    });
  });

  describe('computePercentiles', () => {
    it('calculates exact percentiles using linear interpolation', () => {
      // 100 uniformly distributed values: 1 to 100
      const samples = Array.from({ length: 100 }, (_, i) => i + 1);
      const res = computePercentiles(samples, [50, 90, 95, 99]);

      assert.equal(res.p50, 50.5);
      assert.equal(res.p90, 90.1);
      assert.equal(res.p95, 95.05);
      assert.equal(res.p99, 99.01);
    });

    it('gracefully handles empty and single-element inputs', () => {
      const emptyRes = computePercentiles([], [50, 99]);
      assert.equal(emptyRes.p50, 0);
      assert.equal(emptyRes.p99, 0);

      const singleRes = computePercentiles([42.5], [50, 99]);
      assert.equal(singleRes.p50, 42.5);
      assert.equal(singleRes.p99, 42.5);
    });
  });

  describe('computeBasicStats', () => {
    it('computes accurate mean, stdDev, min, and max', () => {
      const data = [10, 20, 30, 40, 50];
      const stats = computeBasicStats(data);

      assert.equal(stats.mean, 30);
      assert.equal(stats.min, 10);
      assert.equal(stats.max, 50);
      assert.equal(stats.count, 5);
      // Sample standard deviation of [10, 20, 30, 40, 50] is sqrt(1000/4) = 15.8114
      assert.equal(stats.stdDev, 15.8114);
    });

    it('returns zeroes on empty input', () => {
      const stats = computeBasicStats([]);
      assert.deepEqual(stats, { mean: 0, stdDev: 0, min: 0, max: 0, count: 0 });
    });
  });

  describe('detectSteadyState', () => {
    it('identifies inflection point when variance stabilizes', () => {
      // 30 noisy warmup samples followed by 60 stable samples
      const warmup = Array.from({ length: 30 }, () => 100 + Math.random() * 200);
      const steady = Array.from({ length: 60 }, () => 20 + Math.random() * 2);
      const combined = [...warmup, ...steady];

      const res = detectSteadyState(combined, {
        windowSize: 15,
        cvThreshold: 0.15,
        minConsecutiveStable: 2,
      });

      assert.equal(res.converged, true);
      assert.ok(res.inflectionIndex >= 20 && res.inflectionIndex <= 45);
    });

    it('reports unconverged when variance remains excessively erratic', () => {
      const erratic = Array.from({ length: 50 }, (_, i) => (i % 2 === 0 ? 5 : 500));
      const res = detectSteadyState(erratic, { cvThreshold: 0.1 });
      assert.equal(res.converged, false);
      assert.equal(res.inflectionIndex, -1);
    });
  });

  describe('computeTailRatios', () => {
    it('computes accurate tail inflation multiples', () => {
      const percentiles = {
        p50: 10,
        p99: 50,
        p99_9: 150,
      };
      const ratios = computeTailRatios(percentiles);
      assert.equal(ratios.tailRatio, 5.0); // 50 / 10
      assert.equal(ratios.extremeTailRatio, 3.0); // 150 / 50
    });

    it('handles zero p50 safely', () => {
      const ratios = computeTailRatios({ p50: 0, p99: 0 });
      assert.equal(ratios.tailRatio, 1.0);
    });
  });

  describe('profileBenchmarkRun and formatProfileMarkdownTable', () => {
    it('generates comprehensive comparative benchmark profiles', () => {
      const warmup = [120, 150, 180, 210, 140, 190, 160];
      const steady = [15, 16, 15, 17, 16, 15, 18, 15, 16, 17];
      const samples = [...warmup, ...steady];

      const profile = profileBenchmarkRun({
        samples,
        explicitWarmupCount: warmup.length,
      });

      assert.equal(profile.status, 'OPTIMAL');
      assert.equal(profile.totalSamples, samples.length);
      assert.equal(profile.warmupSampleCount, warmup.length);
      assert.equal(profile.steadySampleCount, steady.length);
      assert.ok(profile.tailLatencyReduction.reductionPercent > 50);

      const md = formatProfileMarkdownTable(profile);
      assert.ok(md.includes('| Benchmark Phase |'));
      assert.ok(md.includes('Warmup (Transient)'));
      assert.ok(md.includes('Steady-State (Stable)'));
      assert.ok(md.includes('Delta / Optimization'));
    });

    it('handles empty runs gracefully', () => {
      const profile = profileBenchmarkRun({ samples: [] });
      assert.equal(profile.status, 'EMPTY_RUN');
      const md = formatProfileMarkdownTable(profile);
      assert.equal(md, '_No benchmark samples recorded._');
    });
  });
});
