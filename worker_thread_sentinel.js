/**
 * Zombie Worker Thread Leak & Pipe Exhaustion Sentinel for LoadMach9.
 *
 * Resolves INC-2026-LOAD-6612: Intercepts hanging worker threads, uncollected IPC pipes,
 * and thread allocation storms to prevent OS file descriptor (EMFILE) exhaustion.
 */

export class ThreadSentinelViolationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ThreadSentinelViolationError';
  }
}

export class WorkerThreadSentinel {
  static INCIDENT_ID = 'INC-2026-LOAD-6612';

  constructor({
    maxActiveWorkers = 32,
    heartbeatTimeoutMs = 3000,
    maxZombieThreshold = 3,
    autoTerminateZombies = true,
  } = {}) {
    if (maxActiveWorkers < 1) {
      throw new Error(`maxActiveWorkers must be >= 1, got ${maxActiveWorkers}`);
    }
    if (heartbeatTimeoutMs <= 0) {
      throw new Error(`heartbeatTimeoutMs must be positive, got ${heartbeatTimeoutMs}`);
    }

    this.maxActiveWorkers = maxActiveWorkers;
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
    this.maxZombieThreshold = maxZombieThreshold;
    this.autoTerminateZombies = autoTerminateZombies;

    this.workers = new Map(); // workerId -> { id, spawnedAt, lastHeartbeat, status, terminationSignal }
    this.incidentAuditTrail = [];
    this.totalSpawned = 0;
    this.totalTerminated = 0;
  }

  /**
   * Register a newly allocated worker thread with capacity guard.
   */
  registerWorker(workerId, now = Date.now()) {
    if (!workerId || typeof workerId !== 'string') {
      throw new Error(`workerId must be a non-empty string, got: ${workerId}`);
    }

    // Clean up any dead/zombie threads first
    this.reapZombies(now);

    const activeCount = this.getActiveWorkerCount();
    if (activeCount >= this.maxActiveWorkers) {
      this._recordIncident(
        'CAPACITY_EXHAUSTION',
        `Worker allocation blocked: active count ${activeCount} reached ceiling ${this.maxActiveWorkers}`,
        now
      );
      throw new ThreadSentinelViolationError(
        `Worker capacity exhausted: cannot spawn '${workerId}', limit is ${this.maxActiveWorkers}`
      );
    }

    this.workers.set(workerId, {
      id: workerId,
      spawnedAt: now,
      lastHeartbeat: now,
      status: 'ACTIVE',
      terminated: false,
    });
    this.totalSpawned++;

    return this.workers.get(workerId);
  }

  /**
   * Record periodic heartbeat from an active worker thread.
   */
  recordHeartbeat(workerId, now = Date.now()) {
    const worker = this.workers.get(workerId);
    if (!worker) {
      throw new Error(`Unknown workerId: ${workerId}`);
    }
    if (worker.terminated) {
      throw new ThreadSentinelViolationError(`Worker '${workerId}' is already marked terminated`);
    }

    worker.lastHeartbeat = now;
  }

  /**
   * Scan for zombie workers that missed heartbeat deadlines and terminate if configured.
   */
  reapZombies(now = Date.now()) {
    const reaped = [];

    for (const [id, worker] of this.workers.entries()) {
      if (worker.terminated) continue;

      const idleDuration = now - worker.lastHeartbeat;
      if (idleDuration >= this.heartbeatTimeoutMs) {
        worker.status = 'ZOMBIE';

        this._recordIncident(
          'ZOMBIE_WORKER_DETECTED',
          `Worker '${id}' silent for ${idleDuration}ms (threshold: ${this.heartbeatTimeoutMs}ms)`,
          now
        );

        if (this.autoTerminateZombies) {
          worker.terminated = true;
          worker.status = 'TERMINATED_FORCIBLY';
          this.totalTerminated++;
          reaped.push(id);
        }
      }
    }

    return reaped;
  }

  /**
   * Gracefully terminate a worker thread.
   */
  terminateWorker(workerId, now = Date.now()) {
    const worker = this.workers.get(workerId);
    if (!worker) return false;

    if (!worker.terminated) {
      worker.terminated = true;
      worker.status = 'TERMINATED_GRACEFUL';
      this.totalTerminated++;
      return true;
    }
    return false;
  }

  getActiveWorkerCount() {
    let count = 0;
    for (const worker of this.workers.values()) {
      if (!worker.terminated) count++;
    }
    return count;
  }

  _recordIncident(alertType, details, timestamp) {
    this.incidentAuditTrail.push({
      incidentId: WorkerThreadSentinel.INCIDENT_ID,
      alertType,
      details,
      timestamp,
    });
  }

  exportForensicPostmortem() {
    return {
      incidentId: WorkerThreadSentinel.INCIDENT_ID,
      totalSpawned: this.totalSpawned,
      totalTerminated: this.totalTerminated,
      activeWorkers: this.getActiveWorkerCount(),
      incidentCount: this.incidentAuditTrail.length,
      incidents: [...this.incidentAuditTrail],
    };
  }

  reset() {
    this.workers.clear();
    this.incidentAuditTrail = [];
    this.totalSpawned = 0;
    this.totalTerminated = 0;
  }
}
