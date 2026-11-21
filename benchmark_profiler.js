// Copyright (c) 2026 LoadMach9 Contributors
// SPDX-License-Identifier: MIT
// High-Precision Synthetic Benchmark Load Profile Generator & Stochastic Waveform Sequencer.

/**
 * Phase definition for benchmark load profile stages.
 * @typedef {Object} ProfileStage
 * @property {'ramp-up' | 'sustain' | 'spike' | 'ramp-down'} type
 * @property {number} durationSec - Duration of phase in seconds
 * @property {number} [startRps] - Starting RPS for ramps
 * @property {number} [targetRps] - Target / plateau RPS
 * @property {number} [spikeMultiplier] - Multiplier applied during spike phases (e.g. 2.5x)
 */

export class LoadProfileGenerator {
  /**
   * Validates and constructs a load profile sequencer.
   * @param {Array<ProfileStage>} stages
   */
  constructor(stages = []) {
    this.stages = this._validateStages(stages);
  }

  _validateStages(stages) {
    if (!Array.isArray(stages) || stages.length === 0) {
      throw new Error("Stages must be a non-empty array of stage configurations");
    }

    return stages.map((s, idx) => {
      const type = String(s.type || "").toLowerCase();
      if (!["ramp-up", "sustain", "spike", "ramp-down"].includes(type)) {
        throw new Error(`Invalid stage type '${s.type}' at index ${idx}`);
      }
      const durationSec = Number(s.durationSec);
      if (!Number.isFinite(durationSec) || durationSec <= 0) {
        throw new Error(`Invalid durationSec '${s.durationSec}' at index ${idx}. Must be > 0.`);
      }

      const startRps = Math.max(0, Number(s.startRps ?? 0));
      const targetRps = Math.max(0, Number(s.targetRps ?? 100));
      const spikeMultiplier = Math.max(1.0, Number(s.spikeMultiplier ?? 2.0));

      return {
        type,
        durationSec,
        startRps,
        targetRps,
        spikeMultiplier,
      };
    });
  }

  /**
   * Computes the total duration in seconds across all configured stages.
   * @returns {number}
   */
  getTotalDuration() {
    return this.stages.reduce((acc, s) => acc + s.durationSec, 0);
  }

  /**
   * Calculates instantaneous target RPS at time offset t (in seconds).
   * @param {number} tSec
   * @returns {number}
   */
  getRpsAt(tSec) {
    if (tSec < 0) return 0;
    let accumulatedTime = 0;

    for (const stage of this.stages) {
      const stageStart = accumulatedTime;
      const stageEnd = stageStart + stage.durationSec;

      if (tSec <= stageEnd || stage === this.stages[this.stages.length - 1]) {
        const localT = Math.min(stage.durationSec, Math.max(0, tSec - stageStart));
        const progress = stage.durationSec > 0 ? localT / stage.durationSec : 1.0;

        switch (stage.type) {
          case "ramp-up":
            return Math.round(stage.startRps + progress * (stage.targetRps - stage.startRps));
          case "sustain":
            return stage.targetRps;
          case "spike":
            return Math.round(stage.targetRps * stage.spikeMultiplier);
          case "ramp-down":
            return Math.round(stage.targetRps - progress * (stage.targetRps - stage.startRps));
          default:
            return stage.targetRps;
        }
      }

      accumulatedTime = stageEnd;
    }

    return 0;
  }

  /**
   * Generates a second-by-second RPS schedule table.
   * @param {number} [stepSec=1]
   * @returns {Array<{ timeSec: number, stage: string, rps: number, cumulativeRequests: number }>}
   */
  generateSchedule(stepSec = 1) {
    const totalDuration = this.getTotalDuration();
    const schedule = [];
    let cumulative = 0;
    let currentStageIdx = 0;
    let stageStartTime = 0;

    for (let t = 0; t <= totalDuration; t += stepSec) {
      while (
        currentStageIdx < this.stages.length - 1 &&
        t > stageStartTime + this.stages[currentStageIdx].durationSec
      ) {
        stageStartTime += this.stages[currentStageIdx].durationSec;
        currentStageIdx++;
      }

      const rps = this.getRpsAt(t);
      cumulative += Math.round(rps * stepSec);
      schedule.push({
        timeSec: t,
        stage: this.stages[currentStageIdx].type,
        rps,
        cumulativeRequests: cumulative,
      });
    }

    return schedule;
  }

  /**
   * Simulates Poisson process inter-arrival delay (in milliseconds) for a given RPS.
   * Uses inverse transform sampling: Delta t = -ln(1 - U) / (RPS / 1000)
   * @param {number} rps
   * @param {number} [uniformRandom] - Optional uniform random variable in (0, 1) for deterministic testing
   * @returns {number} Inter-arrival time in milliseconds
   */
  static generatePoissonIntervalMs(rps, uniformRandom = null) {
    if (rps <= 0) return Infinity;
    const u = uniformRandom !== null ? uniformRandom : Math.random();
    // Clamp u to avoid ln(0)
    const safeU = Math.min(0.999999, Math.max(1e-7, u));
    const ratePerMs = rps / 1000.0;
    const deltaMs = -Math.log(1.0 - safeU) / ratePerMs;
    return Math.round(deltaMs * 1e3) / 1e3;
  }

  /**
   * Computes the theoretical area under the load curve (total expected requests).
   * @returns {number}
   */
  computeExpectedTotalRequests() {
    let total = 0;
    for (const stage of this.stages) {
      switch (stage.type) {
        case "ramp-up":
        case "ramp-down":
          total += ((stage.startRps + stage.targetRps) / 2.0) * stage.durationSec;
          break;
        case "sustain":
          total += stage.targetRps * stage.durationSec;
          break;
        case "spike":
          total += stage.targetRps * stage.spikeMultiplier * stage.durationSec;
          break;
      }
    }
    return Math.round(total);
  }
}
