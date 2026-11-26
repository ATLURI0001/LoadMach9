import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  WorkerThreadSentinel,
  ThreadSentinelViolationError,
} from '../worker_thread_sentinel.js';

describe('WorkerThreadSentinel Suite', () => {
  it('registers and manages nominal workers within capacity', () => {
    const sentinel = new WorkerThreadSentinel({ maxActiveWorkers: 5 });

    const w1 = sentinel.registerWorker('worker-1', 1000);
    const w2 = sentinel.registerWorker('worker-2', 1000);

    assert.equal(w1.id, 'worker-1');
    assert.equal(w2.id, 'worker-2');
    assert.equal(sentinel.getActiveWorkerCount(), 2);

    sentinel.recordHeartbeat('worker-1', 1500);
    assert.equal(sentinel.workers.get('worker-1').lastHeartbeat, 1500);

    assert.equal(sentinel.terminateWorker('worker-1'), true);
    assert.equal(sentinel.getActiveWorkerCount(), 1);
  });

  it('detects and reaps silent zombie workers missing heartbeats', () => {
    const sentinel = new WorkerThreadSentinel({
      maxActiveWorkers: 5,
      heartbeatTimeoutMs: 2000,
      autoTerminateZombies: true,
    });

    sentinel.registerWorker('worker-zombie', 1000);
    sentinel.registerWorker('worker-healthy', 1000);

    // Keep healthy worker alive
    sentinel.recordHeartbeat('worker-healthy', 2500);

    // Reap at 3100ms (worker-zombie was silent for 2100ms >= 2000ms threshold)
    const reaped = sentinel.reapZombies(3100);
    assert.equal(reaped.length, 1);
    assert.equal(reaped[0], 'worker-zombie');

    assert.equal(sentinel.getActiveWorkerCount(), 1);
    assert.equal(sentinel.workers.get('worker-zombie').status, 'TERMINATED_FORCIBLY');
  });

  it('blocks worker spawning when capacity limit is breached', () => {
    const sentinel = new WorkerThreadSentinel({ maxActiveWorkers: 2 });

    sentinel.registerWorker('w1', 1000);
    sentinel.registerWorker('w2', 1000);

    assert.throws(
      () => sentinel.registerWorker('w3', 1000),
      ThreadSentinelViolationError
    );
  });

  it('generates forensic postmortem report for INC-2026-LOAD-6612', () => {
    const sentinel = new WorkerThreadSentinel({ maxActiveWorkers: 5, heartbeatTimeoutMs: 1000 });
    sentinel.registerWorker('w-dead', 1000);
    sentinel.reapZombies(2500);

    const postmortem = sentinel.exportForensicPostmortem();
    assert.equal(postmortem.incidentId, 'INC-2026-LOAD-6612');
    assert.equal(postmortem.totalTerminated, 1);
    assert.ok(postmortem.incidentCount >= 1);
    assert.equal(postmortem.incidents[0].alertType, 'ZOMBIE_WORKER_DETECTED');
  });

  it('defensively validates input parameters', () => {
    assert.throws(() => new WorkerThreadSentinel({ maxActiveWorkers: 0 }), /maxActiveWorkers must be >= 1/);
    assert.throws(() => new WorkerThreadSentinel({ heartbeatTimeoutMs: -1 }), /heartbeatTimeoutMs must be positive/);

    const sentinel = new WorkerThreadSentinel();
    assert.throws(() => sentinel.registerWorker(''), /workerId must be a non-empty string/);
    assert.throws(() => sentinel.recordHeartbeat('non-existent'), /Unknown workerId/);
  });
});
