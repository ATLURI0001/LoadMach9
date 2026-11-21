import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WorkerLeaseManager } from '../worker_lease.js';

describe('WorkerLeaseManager & Concurrency Governor', () => {
  it('should initialize with validated defaults and clamp invalid options', () => {
    const manager = new WorkerLeaseManager({ maxConcurrency: -5, defaultTtlMs: 20 });
    assert.equal(manager.maxConcurrency, 10);
    assert.equal(manager.defaultTtlMs, 5000);

    const snap = manager.getSnapshot();
    assert.equal(snap.activeCount, 0);
    assert.equal(snap.availableCapacity, 10);
  });

  it('should acquire lease and return valid lease token and expiration', () => {
    let mockTime = 1000;
    const manager = new WorkerLeaseManager({
      maxConcurrency: 3,
      defaultTtlMs: 2000,
      clockFn: () => mockTime,
    });

    const res = manager.acquireLease('worker-1', { role: 'injector' });
    assert.equal(res.acquired, true);
    assert.ok(typeof res.leaseToken === 'string');
    assert.equal(res.expiresAt, 3000);
    assert.equal(res.activeCount, 1);

    const snap = manager.getSnapshot();
    assert.equal(snap.activeCount, 1);
    assert.equal(snap.availableCapacity, 2);
    assert.equal(snap.activeLeases[0].workerId, 'worker-1');
    assert.equal(snap.activeLeases[0].ttlRemainingMs, 2000);
  });

  it('should reject acquisition when worker already holds active lease', () => {
    let mockTime = 1000;
    const manager = new WorkerLeaseManager({ clockFn: () => mockTime });

    const first = manager.acquireLease('worker-dup');
    assert.equal(first.acquired, true);

    const second = manager.acquireLease('worker-dup');
    assert.equal(second.acquired, false);
    assert.equal(second.reason, 'WORKER_ALREADY_HAS_ACTIVE_LEASE');
  });

  it('should reject acquisition when maxConcurrency capacity is reached', () => {
    const manager = new WorkerLeaseManager({ maxConcurrency: 2 });

    const w1 = manager.acquireLease('worker-1');
    const w2 = manager.acquireLease('worker-2');
    assert.equal(w1.acquired, true);
    assert.equal(w2.acquired, true);

    const w3 = manager.acquireLease('worker-3');
    assert.equal(w3.acquired, false);
    assert.equal(w3.reason, 'CAPACITY_EXCEEDED');

    const snap = manager.getSnapshot();
    assert.equal(snap.rejectedTotal, 1);
  });

  it('should evict expired leases when time elapses', () => {
    let mockTime = 1000;
    const manager = new WorkerLeaseManager({
      maxConcurrency: 2,
      defaultTtlMs: 1000,
      clockFn: () => mockTime,
    });

    manager.acquireLease('worker-expiring', {}, 1000); // expires at 2000
    assert.equal(manager.getSnapshot().activeCount, 1);

    // Fast-forward past expiration
    mockTime = 2500;
    const snap = manager.getSnapshot();
    assert.equal(snap.activeCount, 0);
    assert.equal(snap.expiredTotal, 1);
    assert.equal(snap.availableCapacity, 2);

    // New worker can now acquire
    const wNew = manager.acquireLease('worker-replacement');
    assert.equal(wNew.acquired, true);
  });

  it('should allow heartbeat renewal with valid token and reject invalid tokens', () => {
    let mockTime = 1000;
    const manager = new WorkerLeaseManager({
      defaultTtlMs: 2000,
      clockFn: () => mockTime,
    });

    const { leaseToken } = manager.acquireLease('worker-hb');

    // Advance time by 1000ms
    mockTime = 2000;

    // Reject forged token
    const forged = manager.heartbeat('worker-hb', 'forged-token-xyz');
    assert.equal(forged.renewed, false);
    assert.equal(forged.reason, 'INVALID_LEASE_TOKEN');

    // Reject unknown worker
    const unknown = manager.heartbeat('worker-unknown', leaseToken);
    assert.equal(unknown.renewed, false);
    assert.equal(unknown.reason, 'LEASE_NOT_FOUND_OR_EXPIRED');

    // Valid heartbeat extends lease
    const renewed = manager.heartbeat('worker-hb', leaseToken, 3000);
    assert.equal(renewed.renewed, true);
    assert.equal(renewed.expiresAt, 5000); // 2000 + 3000

    const snap = manager.getSnapshot();
    assert.equal(snap.activeLeases[0].ttlRemainingMs, 3000);
  });

  it('should support voluntary lease release', () => {
    let mockTime = 1000;
    const manager = new WorkerLeaseManager({ clockFn: () => mockTime });

    const { leaseToken } = manager.acquireLease('worker-rel');
    assert.equal(manager.getSnapshot().activeCount, 1);

    // Invalid token cannot release
    const badRel = manager.releaseLease('worker-rel', 'bad-token');
    assert.equal(badRel.released, false);

    // Valid release frees slot
    const goodRel = manager.releaseLease('worker-rel', leaseToken);
    assert.equal(goodRel.released, true);

    const snap = manager.getSnapshot();
    assert.equal(snap.activeCount, 0);
    assert.equal(snap.releasedTotal, 1);
  });

  it('should throw TypeError on invalid workerId', () => {
    const manager = new WorkerLeaseManager();
    assert.throws(() => manager.acquireLease(''), TypeError);
    assert.throws(() => manager.acquireLease(null), TypeError);
    assert.throws(() => manager.acquireLease(123), TypeError);
  });
});
