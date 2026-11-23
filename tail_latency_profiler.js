'use strict';

/**
 * @file tail_latency_profiler.js
 * High-precision benchmark tail latency profiler and steady-state convergence analyzer.
 * Identifies JIT/warmup phases, computes percentile distributions, and evaluates tail inflation.
 */

/**
 * Validates and filters an array of latency samples, ensuring positive finite numbers.
 * @param {number[]} samples
 * @returns {number[]} Filtered array of valid numbers
 */
function sanitizeLatencySamples(samples) {
  if (!Array.isArray(samples)) {
    return [];
  }
  const clean = [];
  for (let i = 0; i < samples.length; i++) {
    const val = Number(samples[i]);
    if (Number.isFinite(val) && val >= 0) {
      clean.push(val);
    }
  }
  return clean;
}

/**
 * Computes exact statistical percentiles using linear interpolation between closest ranks.
 * @param {number[]} samples - Unsorted or sorted array of numerical values
 * @param {number[]} percentiles - List of requested percentiles in range [0, 100]
 * @returns {Record<string, number>} Object mapping percentile keys (e.g. "p50", "p99") to values
 */
function computePercentiles(samples, percentiles = [50, 75, 90, 95, 99, 99.9]) {
  const clean = sanitizeLatencySamples(samples);
  if (clean.length === 0) {
    const fallback = {};
    for (const p of percentiles) {
      fallback[`p${String(p).replace('.', '_')}`] = 0;
    }
    return fallback;
  }

  // Sort ascending using native Float64Array for memory locality
  const sorted = new Float64Array(clean).sort();
  const n = sorted.length;
  const result = {};

  for (const p of percentiles) {
    const key = `p${String(p).replace('.', '_')}`;
    if (p <= 0) {
      result[key] = sorted[0];
      continue;
    }
    if (p >= 100) {
      result[key] = sorted[n - 1];
      continue;
    }

    const rank = (p / 100) * (n - 1);
    const low = Math.floor(rank);
    const high = Math.ceil(rank);
    const weight = rank - low;

    result[key] = Number((sorted[low] * (1 - weight) + sorted[high] * weight).toFixed(4));
  }

  return result;
}

/**
 * Computes basic arithmetic mean and sample standard deviation.
 * @param {number[]} samples
 * @returns {{ mean: number, stdDev: number, min: number, max: number, count: number }}
 */
function computeBasicStats(samples) {
  const clean = sanitizeLatencySamples(samples);
  if (clean.length === 0) {
    return { mean: 0, stdDev: 0, min: 0, max: 0, count: 0 };
  }

  let sum = 0;
  let min = clean[0];
  let max = clean[0];

  for (let i = 0; i < clean.length; i++) {
    const v = clean[i];
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }

  const mean = sum / clean.length;
  if (clean.length === 1) {
    return { mean: Number(mean.toFixed(4)), stdDev: 0, min, max, count: 1 };
  }

  let varianceSum = 0;
  for (let i = 0; i < clean.length; i++) {
    const diff = clean[i] - mean;
    varianceSum += diff * diff;
  }

  const stdDev = Math.sqrt(varianceSum / (clean.length - 1));
  return {
    mean: Number(mean.toFixed(4)),
    stdDev: Number(stdDev.toFixed(4)),
    min,
    max,
    count: clean.length,
  };
}

/**
 * Detects the steady-state inflection index using rolling Coefficient of Variation (CV = stdDev / mean).
 * @param {number[]} samples - Chronological latency measurements
 * @param {object} options
 * @param {number} [options.windowSize=20] - Window size for rolling CV
 * @param {number} [options.cvThreshold=0.25] - CV threshold below which system is considered stable
 * @param {number} [options.minConsecutiveStable=3] - Consecutive stable windows needed
 * @returns {{ converged: boolean, inflectionIndex: number, finalCV: number }}
 */
function detectSteadyState(samples, options = {}) {
  const {
    windowSize = 20,
    cvThreshold = 0.25,
    minConsecutiveStable = 3,
  } = options;

  const clean = sanitizeLatencySamples(samples);
  if (clean.length < windowSize) {
    return { converged: false, inflectionIndex: -1, finalCV: 0 };
  }

  let consecutiveStable = 0;
  let inflectionIndex = -1;
  let lastCV = 0;

  for (let i = 0; i <= clean.length - windowSize; i++) {
    const windowSlice = clean.slice(i, i + windowSize);
    const { mean, stdDev } = computeBasicStats(windowSlice);
    const cv = mean > 0 ? stdDev / mean : 0;
    lastCV = cv;

    if (cv <= cvThreshold) {
      consecutiveStable++;
      if (consecutiveStable === minConsecutiveStable && inflectionIndex === -1) {
        // Point where steady state began
        inflectionIndex = Math.max(0, i - (minConsecutiveStable - 1) * Math.floor(windowSize / 2));
      }
    } else {
      consecutiveStable = 0;
    }
  }

  return {
    converged: inflectionIndex !== -1,
    inflectionIndex: inflectionIndex !== -1 ? inflectionIndex : -1,
    finalCV: Number(lastCV.toFixed(4)),
  };
}

/**
 * Computes tail inflation ratio (p99 / p50) and extreme tail penalty (p99.9 / p99).
 * @param {Record<string, number>} percentiles - Output from computePercentiles
 * @returns {{ tailRatio: number, extremeTailRatio: number }}
 */
function computeTailRatios(percentiles) {
  const p50 = percentiles.p50 || 0;
  const p99 = percentiles.p99 || 0;
  const p99_9 = percentiles.p99_9 || 0;

  const tailRatio = p50 > 0 ? Number((p99 / p50).toFixed(2)) : 1.0;
  const extremeTailRatio = p99 > 0 ? Number((p99_9 / p99).toFixed(2)) : 1.0;

  return {
    tailRatio,
    extremeTailRatio,
  };
}

/**
 * Segregates benchmark run into warmup phase and steady-state phase, returning full comparative telemetry.
 * @param {object} params
 * @param {number[]} params.samples - Full chronological sequence of request latencies (ms)
 * @param {number} [params.explicitWarmupCount=0] - Optional explicit sample count to treat as warmup
 * @param {object} [params.detectionOptions={}] - Options passed to detectSteadyState
 * @returns {object} Full benchmark telemetry report
 */
function profileBenchmarkRun(params = {}) {
  const {
    samples = [],
    explicitWarmupCount = 0,
    detectionOptions = {},
  } = params;

  const clean = sanitizeLatencySamples(samples);
  if (clean.length === 0) {
    return {
      status: 'EMPTY_RUN',
      totalSamples: 0,
      warmup: null,
      steadyState: null,
      reductionPercent: 0,
    };
  }

  let warmupCutoff = explicitWarmupCount;
  let detection = null;

  if (warmupCutoff <= 0) {
    detection = detectSteadyState(clean, detectionOptions);
    warmupCutoff = detection.converged ? detection.inflectionIndex : Math.min(clean.length, 50);
  } else {
    warmupCutoff = Math.min(clean.length, Math.max(0, warmupCutoff));
  }

  const warmupSlice = clean.slice(0, warmupCutoff);
  const steadySlice = clean.slice(warmupCutoff);

  const warmupStats = computeBasicStats(warmupSlice);
  const warmupPercentiles = computePercentiles(warmupSlice);
  const warmupRatios = computeTailRatios(warmupPercentiles);

  const steadyStats = computeBasicStats(steadySlice.length > 0 ? steadySlice : clean);
  const steadyPercentiles = computePercentiles(steadySlice.length > 0 ? steadySlice : clean);
  const steadyRatios = computeTailRatios(steadyPercentiles);

  // Compute tail latency reduction between warmup and steady state
  const warmupP99 = warmupPercentiles.p99 || 1;
  const steadyP99 = steadyPercentiles.p99 || 1;
  const reductionPercent = warmupP99 > 0
    ? Number((((warmupP99 - steadyP99) / warmupP99) * 100).toFixed(2))
    : 0;

  return {
    status: 'OPTIMAL',
    totalSamples: clean.length,
    warmupSampleCount: warmupSlice.length,
    steadySampleCount: steadySlice.length > 0 ? steadySlice.length : clean.length,
    converged: detection ? detection.converged : true,
    warmup: {
      stats: warmupStats,
      percentiles: warmupPercentiles,
      ratios: warmupRatios,
    },
    steadyState: {
      stats: steadyStats,
      percentiles: steadyPercentiles,
      ratios: steadyRatios,
    },
    tailLatencyReduction: {
      metric: 'p99_reduction',
      warmupP99,
      steadyP99,
      reductionPercent,
    },
  };
}

/**
 * Formats a comparative benchmark profile into a GitHub Flavored Markdown table.
 * @param {ReturnType<typeof profileBenchmarkRun>} profile
 * @returns {string} Markdown table
 */
function formatProfileMarkdownTable(profile) {
  if (!profile || profile.status === 'EMPTY_RUN') {
    return '_No benchmark samples recorded._';
  }

  const w = profile.warmup;
  const s = profile.steadyState;

  return [
    '| Benchmark Phase | Samples | Mean (ms) | p50 (ms) | p90 (ms) | p95 (ms) | p99 (ms) | p99.9 (ms) | Tail Ratio (p99/p50) |',
    '|:---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|',
    `| **Warmup (Transient)** | ${profile.warmupSampleCount} | ${w.stats.mean} | ${w.percentiles.p50} | ${w.percentiles.p90} | ${w.percentiles.p95} | ${w.percentiles.p99} | ${w.percentiles.p99_9} | ${w.ratios.tailRatio}x |`,
    `| **Steady-State (Stable)** | ${profile.steadySampleCount} | ${s.stats.mean} | ${s.percentiles.p50} | ${s.percentiles.p90} | ${s.percentiles.p95} | ${s.percentiles.p99} | ${s.percentiles.p99_9} | ${s.ratios.tailRatio}x |`,
    `| **Delta / Optimization** | - | - | - | - | - | **-${profile.tailLatencyReduction.reductionPercent}%** | - | **${(w.ratios.tailRatio - s.ratios.tailRatio).toFixed(2)}x** |`,
  ].join('\n');
}

export {
  sanitizeLatencySamples,
  computePercentiles,
  computeBasicStats,
  detectSteadyState,
  computeTailRatios,
  profileBenchmarkRun,
  formatProfileMarkdownTable,
};
