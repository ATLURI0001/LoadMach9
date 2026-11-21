import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { VuRateGovernor } from '../rate_governor.js';

describe('VuRateGovernor', () => {
  it('should initialize with validated parameter defaults and burst capacity', () => {
    const gov = new VuRateGovernor({ targetRps: 50, maxConcurrency: 10 });
    const telemetry = gov.getTelemetry();

    assert.equal(telemetry.targetRps, 50);
    assert.equal(telemetry.maxConcurrency, 10);
    assert.equal(telemetry.activeWorkers, 0);
    assert.equal(telemetry.throttleFactor, 1.0);
    assert.equal(telemetry.availableTokens, 100); // 2 * targetRps
  });

  it('should acquire tokens within burst capacity and release active workers', () => {
    const gov = new VuRateGovernor({ targetRps: 10, burstCapacity: 5, maxConcurrency: 3 });

    // Acquire up to concurrency limit
    assert.equal(gov.tryAcquire(), true);
    assert.equal(gov.tryAcquire(), true);
    assert.equal(gov.tryAcquire(), true);

    // Concurrency limit reached
    assert.equal(gov.tryAcquire(), false);
    assert.equal(gov.getTelemetry().activeWorkers, 3);
    assert.equal(gov.getTelemetry().stats.rejected, 1);

    // Release one worker
    gov.release();
    assert.equal(gov.getTelemetry().activeWorkers, 2);
    assert.equal(gov.getTelemetry().stats.completed, 1);

    // Now another acquire can succeed
    assert.equal(gov.tryAcquire(), true);
    assert.equal(gov.getTelemetry().activeWorkers, 3);
  });

  it('should throttle throughput when tokens are depleted', () => {
    const gov = new VuRateGovernor({ targetRps: 10, burstCapacity: 2, maxConcurrency: 10 });

    assert.equal(gov.tryAcquire(), true); // tokens: 1
    gov.release();
    assert.equal(gov.tryAcquire(), true); // tokens: 0
    gov.release();

    // Now out of tokens
    assert.equal(gov.tryAcquire(), false);
    assert.equal(gov.getTelemetry().stats.throttled, 1);
  });

  it('should engage adaptive backpressure when latency breaches SLA threshold', () => {
    const gov = new VuRateGovernor({
      targetRps: 100,
      slaThresholdMs: 150,
      backpressureStep: 0.1,
    });

    // Record high latencies
    for (let i = 0; i < 20; i++) {
      gov.recordLatency(300); // SLA breach (> 150ms)
    }

    const telemetry = gov.getTelemetry();
    assert.ok(telemetry.throttleFactor < 1.0, 'throttleFactor should have decreased');
    assert.ok(telemetry.stats.slaBreaches > 0, 'SLA breaches should have been recorded');
    assert.ok(telemetry.effectiveRps < telemetry.targetRps, 'effective RPS should be throttled');

    // Record low latencies to push out old spike and trigger recovery
    for (let i = 0; i < 260; i++) {
      gov.recordLatency(50); // Under SLA
    }

    const recovered = gov.getTelemetry();
    assert.ok(recovered.throttleFactor > telemetry.throttleFactor, 'throttleFactor should recover');
  });

  it('should reset telemetry state and counters cleanly', () => {
    const gov = new VuRateGovernor({ targetRps: 20 });
    gov.tryAcquire();
    gov.recordLatency(500);

    gov.reset();
    const telemetry = gov.getTelemetry();
    assert.equal(telemetry.activeWorkers, 0);
    assert.equal(telemetry.throttleFactor, 1.0);
    assert.equal(telemetry.stats.admitted, 0);
    assert.equal(telemetry.stats.slaBreaches, 0);
    assert.equal(telemetry.p99LatencyMs, 0);
  });
});
