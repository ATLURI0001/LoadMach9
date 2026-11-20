import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveConcurrencyGovernor } from '../concurrency_governor.js';

describe('AdaptiveConcurrencyGovernor', () => {
  it('should initialize with validated parameter defaults', () => {
    const gov = new AdaptiveConcurrencyGovernor({
      initialLimit: 15,
      minLimit: 2,
      maxLimit: 100
    });

    const diag = gov.getDiagnostics();
    assert.strictEqual(diag.limit, 15);
    assert.strictEqual(diag.effectiveLimit, 15);
    assert.strictEqual(diag.inFlight, 0);
    assert.strictEqual(diag.totalAcquired, 0);
    assert.strictEqual(diag.totalDropped, 0);
  });

  it('should enforce concurrency ceiling and track dropped requests', () => {
    const gov = new AdaptiveConcurrencyGovernor({
      initialLimit: 3
    });

    assert.strictEqual(gov.tryAcquire(), true);
    assert.strictEqual(gov.tryAcquire(), true);
    assert.strictEqual(gov.tryAcquire(), true);

    // 4th acquisition should fail and be recorded as dropped
    assert.strictEqual(gov.tryAcquire(), false);

    const diag = gov.getDiagnostics();
    assert.strictEqual(diag.inFlight, 3);
    assert.strictEqual(diag.totalAcquired, 3);
    assert.strictEqual(diag.totalDropped, 1);
    assert.strictEqual(diag.saturationRatio, 1.0);

    // Release one slot
    gov.release(10.0, true);
    assert.strictEqual(gov.getDiagnostics().inFlight, 2);

    // Now acquisition succeeds again
    assert.strictEqual(gov.tryAcquire(), true);
    assert.strictEqual(gov.getDiagnostics().inFlight, 3);
  });

  it('should additively increase limit under low latency / low queue conditions', () => {
    const gov = new AdaptiveConcurrencyGovernor({
      initialLimit: 10,
      windowSize: 5,
      beta: 2,
      alpha: 3
    });

    // Provide 5 samples at baseline minimum RTT (10ms) -> gradient = 1.0 -> queueEstimate = 0 <= alpha
    for (let i = 0; i < 5; i++) {
      gov.tryAcquire();
      gov.release(10.0, true);
    }

    const diag = gov.getDiagnostics();
    // Limit should have increased by beta (2) -> 12
    assert.strictEqual(diag.limit, 12);
    assert.strictEqual(diag.effectiveLimit, 12);
    assert.strictEqual(diag.minRttMs, 10);
  });

  it('should multiplicatively decrease limit under elevated latency / congestion', () => {
    const gov = new AdaptiveConcurrencyGovernor({
      initialLimit: 20,
      windowSize: 5,
      alpha: 2,
      gamma: 5,
      backoffRatio: 0.8
    });

    // Seed baseline min RTT = 5ms
    gov.tryAcquire();
    gov.release(5.0, true);

    // Trigger severe queue latency spike = 50ms
    // smoothedRtt will grow, gradient = 5 / 50 = 0.1 -> queue = 20 * (1 - 0.1) = 18 >= gamma (5)
    for (let i = 0; i < 10; i++) {
      gov.tryAcquire();
      gov.release(100.0, true);
    }

    const diag = gov.getDiagnostics();
    // Limit should backoff below 20
    assert.ok(diag.limit < 20, `expected limit < 20, got ${diag.limit}`);
  });

  it('should immediately back off on execution failures', () => {
    const gov = new AdaptiveConcurrencyGovernor({
      initialLimit: 10,
      backoffRatio: 0.5
    });

    gov.tryAcquire();
    gov.release(20.0, false); // Hard failure

    const diag = gov.getDiagnostics();
    assert.strictEqual(diag.limit, 5);
    assert.strictEqual(diag.totalFailed, 1);
  });

  it('should safely clamp non-positive options and handle reset', () => {
    const gov = new AdaptiveConcurrencyGovernor({
      initialLimit: -5,
      minLimit: -1,
      maxLimit: -10,
      backoffRatio: 2.5
    });

    assert.ok(gov.limit >= 1);
    assert.ok(gov.backoffRatio <= 0.99);

    gov.tryAcquire();
    gov.release(10.0, true);
    assert.strictEqual(gov.totalCompleted, 1);

    gov.reset();
    assert.strictEqual(gov.totalCompleted, 0);
    assert.strictEqual(gov.inFlight, 0);
  });
});
