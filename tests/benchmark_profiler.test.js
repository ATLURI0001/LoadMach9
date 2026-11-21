// Copyright (c) 2026 LoadMach9 Contributors
// SPDX-License-Identifier: MIT
// Unit tests for LoadProfileGenerator and Poisson Inter-Arrival Sequencer.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { LoadProfileGenerator } from "../benchmark_profiler.js";

describe("LoadProfileGenerator", () => {
  test("should validate stage schemas and calculate total duration accurately", () => {
    const generator = new LoadProfileGenerator([
      { type: "ramp-up", durationSec: 10, startRps: 0, targetRps: 100 },
      { type: "sustain", durationSec: 30, targetRps: 100 },
      { type: "spike", durationSec: 5, targetRps: 100, spikeMultiplier: 3.0 },
      { type: "ramp-down", durationSec: 10, startRps: 0, targetRps: 100 },
    ]);

    assert.equal(generator.getTotalDuration(), 55);
  });

  test("should calculate instantaneous linear RPS during ramp-up and plateau during sustain", () => {
    const generator = new LoadProfileGenerator([
      { type: "ramp-up", durationSec: 10, startRps: 0, targetRps: 100 },
      { type: "sustain", durationSec: 20, targetRps: 100 },
    ]);

    // At t = 0 -> 0 RPS
    assert.equal(generator.getRpsAt(0), 0);
    // At t = 5 -> 50 RPS (halfway through ramp)
    assert.equal(generator.getRpsAt(5), 50);
    // At t = 10 -> 100 RPS (peak of ramp)
    assert.equal(generator.getRpsAt(10), 100);
    // At t = 20 -> 100 RPS (inside sustain plateau)
    assert.equal(generator.getRpsAt(20), 100);
  });

  test("should apply spike multiplier cleanly during impulse bursts", () => {
    const generator = new LoadProfileGenerator([
      { type: "sustain", durationSec: 10, targetRps: 50 },
      { type: "spike", durationSec: 5, targetRps: 50, spikeMultiplier: 4.0 },
    ]);

    assert.equal(generator.getRpsAt(5), 50);
    assert.equal(generator.getRpsAt(12), 200); // 50 * 4.0 = 200 RPS
  });

  test("should compute integral area under curve for total expected requests", () => {
    const generator = new LoadProfileGenerator([
      // Ramp from 0 to 100 in 10s: average 50 RPS * 10 = 500
      { type: "ramp-up", durationSec: 10, startRps: 0, targetRps: 100 },
      // Sustain 100 RPS for 20s = 2000
      { type: "sustain", durationSec: 20, targetRps: 100 },
    ]);

    const expected = generator.computeExpectedTotalRequests();
    assert.equal(expected, 2500);
  });

  test("should generate discrete second-by-second timeline schedule", () => {
    const generator = new LoadProfileGenerator([
      { type: "sustain", durationSec: 5, targetRps: 10 },
    ]);

    const schedule = generator.generateSchedule(1);
    assert.equal(schedule.length, 6); // t=0, 1, 2, 3, 4, 5
    assert.equal(schedule[0].rps, 10);
    assert.equal(schedule[schedule.length - 1].cumulativeRequests, 60);
  });

  test("should simulate Poisson inter-arrival intervals with exponential distribution", () => {
    const rps = 100; // 0.1 requests per ms -> mean interval = 10ms
    // With U = 0.5 (median): -ln(0.5) / 0.1 = 0.6931 / 0.1 ≈ 6.931 ms
    const medianInterval = LoadProfileGenerator.generatePoissonIntervalMs(rps, 0.5);
    assert.ok(Math.abs(medianInterval - 6.931) < 0.01);

    // RPS <= 0 returns Infinity
    assert.equal(LoadProfileGenerator.generatePoissonIntervalMs(0), Infinity);
  });

  test("should reject invalid stage specifications defensively", () => {
    assert.throws(() => new LoadProfileGenerator([]), /non-empty array/);
    assert.throws(
      () => new LoadProfileGenerator([{ type: "invalid-type", durationSec: 10 }]),
      /Invalid stage type/
    );
    assert.throws(
      () => new LoadProfileGenerator([{ type: "sustain", durationSec: -5 }]),
      /Invalid durationSec/
    );
  });
});
