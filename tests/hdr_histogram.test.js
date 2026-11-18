import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HdrLatencyRecorder } from "../hdr_histogram.js";

describe("HdrLatencyRecorder", () => {
  it("should record across multiple orders of magnitude within 1% relative error", () => {
    const hdr = new HdrLatencyRecorder({ maxValue: 1_000_000, significantDigits: 2 });
    for (let i = 1; i <= 1000; i++) {
      hdr.record(i * 10); // 10 .. 10,000 us uniformly
    }

    const summary = hdr.getSummary();
    assert.equal(summary.count, 1000);
    assert.equal(summary.min, 10);
    assert.equal(summary.max, 10000);
    // p50 should be ~5000 (within 1%), p99 should be ~9900 (within 1%)
    assert.ok(Math.abs(summary.p50 - 5000) <= 50, `p50=${summary.p50}`);
    assert.ok(Math.abs(summary.p99 - 9900) <= 100, `p99=${summary.p99}`);
    assert.ok(Math.abs(summary.p999 - 9990) <= 100, `p999=${summary.p999}`);
  });

  it("should backfill omitted samples under coordinated omission stalls", () => {
    const hdr = new HdrLatencyRecorder({ maxValue: 100_000, significantDigits: 2 });
    // Expected interval = 10ms, actual stall = 50ms -> records 50, 40, 30, 20, 10 (5 samples)
    const count = hdr.recordWithExpectedInterval(50, 10);
    assert.equal(count, 5);
    assert.equal(hdr.getSummary().count, 5);
    assert.equal(hdr.getSummary().min, 10);
    assert.equal(hdr.getSummary().max, 50);
  });

  it("should merge distributed worker histograms losslessly and guard mismatched geometry", () => {
    const workerA = new HdrLatencyRecorder({ maxValue: 100_000, significantDigits: 2 });
    const workerB = new HdrLatencyRecorder({ maxValue: 100_000, significantDigits: 2 });

    for (let i = 0; i < 90; i++) workerA.record(50);
    for (let i = 0; i < 10; i++) workerB.record(5000);

    workerA.merge(workerB);
    const merged = workerA.getSummary();
    assert.equal(merged.count, 100);
    assert.equal(merged.min, 50);
    assert.equal(merged.max, 5000);
    assert.equal(merged.p50, 50);
    assert.ok(merged.p95 >= 4900 && merged.p95 <= 5000);

    const incompatible = new HdrLatencyRecorder({ maxValue: 50_000, significantDigits: 2 });
    assert.throws(() => workerA.merge(incompatible), RangeError);
  });

  it("should clamp high values and ignore negative/NaN samples safely", () => {
    const hdr = new HdrLatencyRecorder({ maxValue: 1000, significantDigits: 2 });
    assert.equal(hdr.record(-5), false);
    assert.equal(hdr.record(NaN), false);
    assert.equal(hdr.record(5000), true);
    const s = hdr.getSummary();
    assert.equal(s.count, 1);
    assert.equal(s.max, 1000);
    assert.equal(s.clampedHigh, 1);

    hdr.reset();
    assert.equal(hdr.getSummary().count, 0);
  });
});
