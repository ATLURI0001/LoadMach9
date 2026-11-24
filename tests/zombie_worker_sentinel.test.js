import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ZombieWorkerSentinel,
  WorkerStatus,
  TerminationSignal,
} from '../zombie_worker_sentinel.js';

describe('ZombieWorkerSentinel Core Suite', () => {
  it('initializes with default options and empty fleet', () => {
    const sentinel = new ZombieWorkerSentinel();
    assert.equal(sentinel.heartbeatTimeoutMs, 5000);
    assert.equal(sentinel.gracePeriodMs, 1500);
    assert.equal(sentinel.maxWorkerLifetimeMs, 3600000);
    assert.equal(sentinel.getActiveCount(), 0);
    assert.equal(sentinel.getIncidents().length, 0);
  });

  it('clamps invalid options to safe positive boundaries', () => {
    const sentinel = new ZombieWorkerSentinel({
      heartbeatTimeoutMs: -100,
      gracePeriodMs: 0,
      maxWorkerLifetimeMs: 'bad',
    });
    assert.equal(sentinel.heartbeatTimeoutMs, 100);
    assert.equal(sentinel.gracePeriodMs, 50);
    assert.equal(sentinel.maxWorkerLifetimeMs, 3600000);
  });

  it('registers workers cleanly and rejects malformed inputs or duplicates', () => {
    const sentinel = new ZombieWorkerSentinel();

    assert.throws(() => sentinel.registerWorker(null), /TypeError/);
    assert.throws(() => sentinel.registerWorker({ workerId: '', pid: 123 }), /TypeError/);
    assert.throws(() => sentinel.registerWorker({ workerId: 'w1', pid: -5 }), /TypeError/);
    assert.throws(() => sentinel.registerWorker({ workerId: 'w1', pid: 'invalid' }), /TypeError/);

    const reg = sentinel.registerWorker({ workerId: 'worker-1', pid: 1042, spawnTimeMs: 1000 });
    assert.equal(reg.workerId, 'worker-1');
    assert.equal(reg.pid, 1042);
    assert.equal(reg.status, WorkerStatus.HEALTHY);
    assert.equal(sentinel.getActiveCount(), 1);

    // Duplicate check
    assert.throws(
      () => sentinel.registerWorker({ workerId: 'worker-1', pid: 1043 }),
      /already registered/
    );
  });

  it('records heartbeats and ignores nonexistent or terminating workers', () => {
    const sentinel = new ZombieWorkerSentinel({ heartbeatTimeoutMs: 1000 });
    sentinel.registerWorker({ workerId: 'worker-a', pid: 2001, spawnTimeMs: 1000 });

    assert.equal(sentinel.recordHeartbeat('nonexistent'), false);
    assert.equal(sentinel.recordHeartbeat('worker-a', 1500), true);

    const w = sentinel.getWorker('worker-a');
    assert.equal(w.lastHeartbeatMs, 1500);
    assert.equal(w.status, WorkerStatus.HEALTHY);
  });

  it('deregisters cleanly exiting workers and records reaped state', () => {
    const sentinel = new ZombieWorkerSentinel();
    sentinel.registerWorker({ workerId: 'worker-clean', pid: 3001 });

    assert.equal(sentinel.deregisterWorker('nonexistent'), false);
    assert.equal(sentinel.deregisterWorker('worker-clean', 'EXIT_SUCCESS', 0), true);
    assert.equal(sentinel.getActiveCount(), 0);
    assert.equal(sentinel.getWorker('worker-clean'), null);
  });

  it('detects stalled heartbeat and triggers SIGTERM escalation', () => {
    const signals = [];
    const sentinel = new ZombieWorkerSentinel({
      heartbeatTimeoutMs: 2000,
      onTerminate: (worker, sig) => signals.push({ id: worker.workerId, sig }),
    });

    sentinel.registerWorker({ workerId: 'worker-zombie', pid: 4001, spawnTimeMs: 1000 });

    // Step forward 1000ms: still within 2000ms heartbeat window
    const sweep1 = sentinel.sweep(2500);
    assert.equal(sweep1.stalled, 0);
    assert.equal(sweep1.terminated, 0);
    assert.equal(signals.length, 0);

    // Step forward past heartbeat window: 1000 + 2000 < 3500
    const sweep2 = sentinel.sweep(3500);
    assert.equal(sweep2.stalled, 1);
    assert.equal(sweep2.terminated, 1);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].id, 'worker-zombie');
    assert.equal(signals[0].sig, TerminationSignal.SIGTERM);

    const worker = sentinel.getWorker('worker-zombie');
    assert.equal(worker.status, WorkerStatus.TERMINATING);
    assert.equal(worker.terminationAttempts, 1);
  });

  it('escalates to SIGKILL after grace period elapses and reaps worker', () => {
    const signals = [];
    const sentinel = new ZombieWorkerSentinel({
      heartbeatTimeoutMs: 1000,
      gracePeriodMs: 500,
      onTerminate: (worker, sig) => signals.push({ id: worker.workerId, sig }),
    });

    sentinel.registerWorker({ workerId: 'worker-hard', pid: 5001, spawnTimeMs: 1000 });

    // Trigger SIGTERM at t=2500
    sentinel.sweep(2500);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].sig, TerminationSignal.SIGTERM);

    // Cannot send heartbeat to terminating worker
    assert.equal(sentinel.recordHeartbeat('worker-hard', 2600), false);

    // Sweep before grace period (e.g. t=2800, only 300ms elapsed < 500ms grace)
    const sweepGrace = sentinel.sweep(2800);
    assert.equal(sweepGrace.killed, 0);
    assert.equal(signals.length, 1);

    // Sweep after grace period (e.g. t=3100, 600ms elapsed >= 500ms grace)
    const sweepKill = sentinel.sweep(3100);
    assert.equal(sweepKill.killed, 1);
    assert.equal(sweepKill.reaped, 1);
    assert.equal(signals.length, 2);
    assert.equal(signals[1].sig, TerminationSignal.SIGKILL);
    assert.equal(sentinel.getActiveCount(), 0);
  });

  it('detects runaway worker exceeding maxWorkerLifetimeMs', () => {
    const sentinel = new ZombieWorkerSentinel({
      heartbeatTimeoutMs: 10000,
      maxWorkerLifetimeMs: 5000,
    });

    sentinel.registerWorker({ workerId: 'worker-old', pid: 6001, spawnTimeMs: 1000 });

    // Keeps pinging heartbeat at t=5000
    sentinel.recordHeartbeat('worker-old', 5000);

    // But at t=6500, lifetime (5500ms) exceeds 5000ms max
    const sweep = sentinel.sweep(6500);
    assert.equal(sweep.stalled, 1);
    assert.equal(sweep.terminated, 1);
    const worker = sentinel.getWorker('worker-old');
    assert.match(worker.terminationReason, /MAX_LIFETIME_EXCEEDED/);
  });

  it('resiliently handles onTerminate callback throwing exceptions', () => {
    const sentinel = new ZombieWorkerSentinel({
      heartbeatTimeoutMs: 500,
      gracePeriodMs: 200,
      onTerminate: () => {
        throw new Error('OS kill syscall failed');
      },
    });

    sentinel.registerWorker({ workerId: 'worker-err', pid: 7001, spawnTimeMs: 1000 });
    assert.doesNotThrow(() => sentinel.sweep(2000));
    assert.doesNotThrow(() => sentinel.sweep(2500));
  });

  it('generates informative incident postmortem markdown report', () => {
    const sentinel = new ZombieWorkerSentinel({
      heartbeatTimeoutMs: 1000,
      gracePeriodMs: 500,
    });

    // Empty state report
    assert.match(sentinel.generatePostmortemReport(), /No Zombie Incidents Detected/);

    sentinel.registerWorker({ workerId: 'worker-rep-1', pid: 8001, spawnTimeMs: 1000 });
    sentinel.sweep(2500); // SIGTERM
    sentinel.sweep(3100); // SIGKILL

    const report = sentinel.generatePostmortemReport();
    assert.match(report, /Incident Postmortem: Distributed Worker Zombie Failsafe Report/);
    assert.match(report, /worker-rep-1/);
    assert.match(report, /8001/);
    assert.match(report, /SIGTERM -> SIGKILL/);
    assert.match(report, /RESOLVED \(REAPED\)/);
  });
});
