'use strict';

/**
 * @file pipelining_benchmark_profiler.js
 * High-performance HTTP keep-alive & request pipelining benchmark profiler for LoadMach9.
 * Analyzes socket throughput, head-of-line (HoL) blocking, and connection multiplexing efficiency.
 */

/**
 * Validates and normalizes pipelining configuration options.
 * @param {Object} options
 * @returns {Object} Normalized options
 */
export function normalizeProfilerOptions(options = {}) {
  const depths = Array.isArray(options.pipeliningDepths) && options.pipeliningDepths.length > 0
    ? options.pipeliningDepths.map(Number).filter(d => Number.isInteger(d) && d >= 1)
    : [1, 2, 4, 8, 16];

  const defaultDepthList = depths.length > 0 ? depths : [1, 2, 4, 8, 16];

  return {
    pipeliningDepths: Array.from(new Set(defaultDepthList)).sort((a, b) => a - b),
    holBlockingThreshold: Number(options.holBlockingThreshold) > 1.0 ? Number(options.holBlockingThreshold) : 2.5,
    minSaturationGainPct: Number(options.minSaturationGainPct) >= 0 ? Number(options.minSaturationGainPct) : 5.0,
    warmupIterations: Math.max(0, parseInt(options.warmupIterations, 10) || 3),
    measurementIterations: Math.max(1, parseInt(options.measurementIterations, 10) || 10),
  };
}

/**
 * Calculates pipelining speedup factor and efficiency against un-pipelined baseline (depth=1).
 * @param {number} baselineRps - Throughput at depth = 1
 * @param {number} pipelinedRps - Throughput at depth = K
 * @param {number} depth - Pipelining depth factor
 * @returns {{ speedupFactor: number, efficiencyPct: number, theoreticalMax: number }}
 */
export function computePipeliningSpeedup(baselineRps, pipelinedRps, depth) {
  const base = Number(baselineRps);
  const target = Number(pipelinedRps);
  const d = Math.max(1, parseInt(depth, 10) || 1);

  if (!Number.isFinite(base) || base <= 0 || !Number.isFinite(target) || target <= 0) {
    return {
      speedupFactor: 1.0,
      efficiencyPct: 100.0,
      theoreticalMax: d,
    };
  }

  const speedup = target / base;
  const efficiency = (speedup / d) * 100.0;

  return {
    speedupFactor: Number(speedup.toFixed(4)),
    efficiencyPct: Number(efficiency.toFixed(2)),
    theoreticalMax: d,
  };
}

/**
 * Detects Head-of-Line (HoL) blocking inflation on tail latency percentiles.
 * @param {number} baselineP99Ms - P99 latency at depth = 1 in ms
 * @param {number} pipelinedP99Ms - P99 latency at depth = K in ms
 * @param {number} threshold - HoL inflation multiplier threshold (default 2.5x)
 * @returns {{ holIndex: number, holDetected: boolean, inflationPct: number }}
 */
export function detectHeadOfLineBlocking(baselineP99Ms, pipelinedP99Ms, threshold = 2.5) {
  const base = Number(baselineP99Ms);
  const target = Number(pipelinedP99Ms);
  const thresh = Number(threshold) > 1.0 ? Number(threshold) : 2.5;

  if (!Number.isFinite(base) || base <= 0 || !Number.isFinite(target) || target <= 0) {
    return {
      holIndex: 1.0,
      holDetected: false,
      inflationPct: 0.0,
    };
  }

  const holIndex = target / base;
  const inflation = Math.max(0, (holIndex - 1.0) * 100.0);
  const holDetected = holIndex >= thresh;

  return {
    holIndex: Number(holIndex.toFixed(4)),
    holDetected,
    inflationPct: Number(inflation.toFixed(2)),
  };
}

/**
 * PipeliningBenchmarkProfiler evaluates throughput and latency trade-offs across pipeline depths.
 */
export class PipeliningBenchmarkProfiler {
  constructor(options = {}) {
    this.options = normalizeProfilerOptions(options);
    this.records = new Map();
  }

  /**
   * Records a completed benchmark trial for a given pipeline depth.
   * @param {number} depth
   * @param {Object} metrics - { rps, p50, p90, p99, bytesPerSec, errorCount }
   */
  recordTrial(depth, metrics = {}) {
    const d = Math.max(1, parseInt(depth, 10) || 1);
    const rps = Math.max(0, Number(metrics.rps) || 0);
    const p50 = Math.max(0, Number(metrics.p50) || 0);
    const p90 = Math.max(0, Number(metrics.p90) || 0);
    const p99 = Math.max(0, Number(metrics.p99) || 0);
    const bytesPerSec = Math.max(0, Number(metrics.bytesPerSec) || 0);
    const errorCount = Math.max(0, Number(metrics.errorCount) || 0);

    this.records.set(d, {
      depth: d,
      rps,
      p50,
      p90,
      p99,
      bytesPerSec,
      errorCount,
    });
  }

  /**
   * Evaluates all recorded trials and identifies optimal operating pipeline depth.
   * @returns {Object} Comprehensive evaluation summary
   */
  evaluate() {
    if (this.records.size === 0) {
      return {
        optimalDepth: 1,
        maxThroughputRps: 0,
        baselineRps: 0,
        depthAnalysis: [],
        holBlockingWarnings: [],
      };
    }

    const sortedDepths = Array.from(this.records.keys()).sort((a, b) => a - b);
    const baseline = this.records.get(1) || this.records.get(sortedDepths[0]);
    const baselineRps = baseline.rps;
    const baselineP99 = baseline.p99;

    let optimalDepth = sortedDepths[0];
    let maxThroughputRps = baselineRps;
    let saturationReached = false;
    let saturationDepth = null;

    const depthAnalysis = [];
    const holWarnings = [];

    for (let i = 0; i < sortedDepths.length; i++) {
      const d = sortedDepths[i];
      const rec = this.records.get(d);
      const speedup = computePipeliningSpeedup(baselineRps, rec.rps, d);
      const hol = detectHeadOfLineBlocking(baselineP99, rec.p99, this.options.holBlockingThreshold);

      if (hol.holDetected) {
        holWarnings.push({
          depth: d,
          p99: rec.p99,
          baselineP99,
          holIndex: hol.holIndex,
          message: `Depth ${d} experienced ${hol.holIndex}x P99 latency inflation due to head-of-line socket queuing.`,
        });
      }

      // Check for saturation (diminishing returns or throughput drop)
      if (i > 0 && !saturationReached) {
        const prevRec = this.records.get(sortedDepths[i - 1]);
        const gainPct = prevRec.rps > 0 ? ((rec.rps - prevRec.rps) / prevRec.rps) * 100.0 : 0;
        if (gainPct < this.options.minSaturationGainPct) {
          saturationReached = true;
          saturationDepth = sortedDepths[i - 1];
        }
      }

      if (rec.rps > maxThroughputRps && !hol.holDetected) {
        maxThroughputRps = rec.rps;
        optimalDepth = d;
      }

      depthAnalysis.push({
        depth: d,
        rps: rec.rps,
        speedupFactor: speedup.speedupFactor,
        efficiencyPct: speedup.efficiencyPct,
        p50: rec.p50,
        p99: rec.p99,
        holIndex: hol.holIndex,
        holDetected: hol.holDetected,
        bytesPerSec: rec.bytesPerSec,
      });
    }

    return {
      optimalDepth,
      maxThroughputRps,
      baselineRps,
      saturationDepth: saturationDepth || optimalDepth,
      depthAnalysis,
      holBlockingWarnings: holWarnings,
    };
  }

  /**
   * Generates a formatted ASCII / Markdown summary report for logging and artifacts.
   * @returns {string} Markdown formatted report
   */
  generateMarkdownReport() {
    const res = this.evaluate();
    const lines = [
      '### HTTP Pipelining & Keep-Alive Benchmark Analysis',
      '',
      `| Pipeline Depth | Throughput (RPS) | Speedup Factor | Efficiency (%) | P50 (ms) | P99 (ms) | HoL Index |`,
      `| :--- | :--- | :--- | :--- | :--- | :--- | :--- |`,
    ];

    for (const d of res.depthAnalysis) {
      lines.push(
        `| ${d.depth} | ${d.rps.toLocaleString()} | ${d.speedupFactor}x | ${d.efficiencyPct}% | ${d.p50}ms | ${d.p99}ms | ${d.holIndex}x |`
      );
    }

    lines.push('');
    lines.push(`- **Recommended Optimal Depth:** ${res.optimalDepth} (Yields peak throughput without excessive tail inflation)`);
    lines.push(`- **Saturation Boundary Depth:** ${res.saturationDepth}`);

    if (res.holBlockingWarnings.length > 0) {
      lines.push('');
      lines.push('#### ⚠ Head-of-Line Blocking Warnings:');
      for (const w of res.holBlockingWarnings) {
        lines.push(`- ${w.message}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Clears all recorded trial data.
   */
  reset() {
    this.records.clear();
  }
}
