// Copyright 2026 LoadMach9 Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Coordinated Omission Compensator & RFC 3550 Inter-Arrival Jitter Profiler.
//
// Corrects benchmark measurements for un-sampled delay periods in open-model load testing
// and evaluates continuous network/application jitter.

/**
 * Compensate an array of raw latency measurements for Coordinated Omission.
 *
 * When an observed service time L exceeds the expected inter-arrival interval T,
 * requests that should have been sent during that window were delayed by the client runner.
 * This function injects the missing virtual request latencies: L_j = L - j * T.
 *
 * @param {number[]} latenciesMs - Array of observed latency measurements in milliseconds
 * @param {number} expectedIntervalMs - Expected inter-arrival time in milliseconds (1000 / targetRps)
 * @returns {{ compensatedLatenciesMs: number[], omittedCount: number, meanCompensated: number }}
 */
export function compensateCoordinatedOmission(latenciesMs, expectedIntervalMs) {
  if (!Array.isArray(latenciesMs)) {
    throw new TypeError('latenciesMs must be an array of numbers');
  }
  if (typeof expectedIntervalMs !== 'number' || !Number.isFinite(expectedIntervalMs) || expectedIntervalMs <= 0) {
    throw new RangeError(`expectedIntervalMs must be a positive finite number, received: ${expectedIntervalMs}`);
  }

  const compensated = [];
  let omittedCount = 0;
  let sum = 0.0;

  for (let i = 0; i < latenciesMs.length; i++) {
    const lat = latenciesMs[i];
    if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < 0) {
      continue; // Skip invalid or negative measurements
    }

    compensated.push(lat);
    sum += lat;

    // Check if latency spans multiple expected request intervals
    if (lat > expectedIntervalMs) {
      let remaining = lat - expectedIntervalMs;
      while (remaining > 0) {
        compensated.push(remaining);
        sum += remaining;
        omittedCount++;
        remaining -= expectedIntervalMs;
      }
    }
  }

  const meanCompensated = compensated.length > 0 ? sum / compensated.length : 0.0;
  return {
    compensatedLatenciesMs: compensated,
    omittedCount,
    meanCompensated,
  };
}

/**
 * RFC 3550 Inter-Arrival Jitter Profiler.
 *
 * Computes statistical variance of inter-arrival delays using exponential smoothing:
 *   D(i, j) = (R_j - S_j) - (R_i - S_i)
 *   J(i) = J(i - 1) + (|D(i - 1, i)| - J(i - 1)) / 16
 */
export class Rfc3550JitterProfiler {
  /**
   * @param {object} [options]
   * @param {number} [options.smoothingFactor=16] - RFC 3550 standard smoothing divisor
   */
  constructor(options = {}) {
    const { smoothingFactor = 16 } = options;
    if (typeof smoothingFactor !== 'number' || smoothingFactor <= 0) {
      throw new RangeError('smoothingFactor must be a positive number');
    }
    this.smoothingFactor = smoothingFactor;
    this.reset();
  }

  reset() {
    this.jitterMs = 0.0;
    this.prevTransitMs = null;
    this.sampleCount = 0;
    this.maxJitterMs = 0.0;
    this.sumDeltas = 0.0;
  }

  /**
   * Record a transit measurement: transit time = receiveTime - sendTime.
   *
   * @param {number} sendTimestampMs - Client send timestamp
   * @param {number} receiveTimestampMs - Client or server receive timestamp
   * @returns {{ currentJitterMs: number, deltaMs: number, maxJitterMs: number }}
   */
  record(sendTimestampMs, receiveTimestampMs) {
    if (typeof sendTimestampMs !== 'number' || !Number.isFinite(sendTimestampMs) ||
        typeof receiveTimestampMs !== 'number' || !Number.isFinite(receiveTimestampMs)) {
      throw new TypeError('Timestamps must be finite numbers');
    }

    const transitMs = receiveTimestampMs - sendTimestampMs;
    this.sampleCount++;

    if (this.prevTransitMs === null) {
      this.prevTransitMs = transitMs;
      return {
        currentJitterMs: 0.0,
        deltaMs: 0.0,
        maxJitterMs: 0.0,
      };
    }

    // Transit difference: D(i-1, i)
    const deltaMs = Math.abs(transitMs - this.prevTransitMs);
    this.sumDeltas += deltaMs;

    // RFC 3550 recurrence relation
    this.jitterMs = this.jitterMs + (deltaMs - this.jitterMs) / this.smoothingFactor;
    if (this.jitterMs > this.maxJitterMs) {
      this.maxJitterMs = this.jitterMs;
    }

    this.prevTransitMs = transitMs;

    return {
      currentJitterMs: this.jitterMs,
      deltaMs,
      maxJitterMs: this.maxJitterMs,
    };
  }

  /**
   * Retrieve statistical summary.
   */
  getSummary() {
    return {
      samples: this.sampleCount,
      jitterMs: this.jitterMs,
      maxJitterMs: this.maxJitterMs,
      meanAbsoluteDeltaMs: this.sampleCount > 1 ? this.sumDeltas / (this.sampleCount - 1) : 0.0,
    };
  }
}
