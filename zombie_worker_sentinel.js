/**
 * @file zombie_worker_sentinel.js
 * Distributed Load Testing Worker Lifecycle & Zombie Process Failsafe Sentinel.
 *
 * Tracks worker heartbeats, detects unresponsive child processes / threads,
 * and executes a deterministic termination ladder (SIGTERM -> Grace Period -> SIGKILL)
 * to reclaim leaked memory and compute capacity during load test suite runs.
 */

export const WorkerStatus = Object.freeze({
  HEALTHY: 'HEALTHY',
  STALLED: 'STALLED',
  TERMINATING: 'TERMINATING',
  KILLED: 'KILLED',
  REAPED: 'REAPED',
});

export const TerminationSignal = Object.freeze({
  SIGTERM: 'SIGTERM',
  SIGKILL: 'SIGKILL',
});

export class ZombieWorkerSentinel {
  /**
   * @param {Object} [options]
   * @param {number} [options.heartbeatTimeoutMs=5000] Milliseconds before an uncommunicative worker is deemed STALLED.
   * @param {number} [options.gracePeriodMs=1500] Milliseconds between SIGTERM and forced SIGKILL escalation.
   * @param {number} [options.maxWorkerLifetimeMs=3600000] Maximum allowed lifespan before scheduled worker recycle.
   * @param {Function} [options.onTerminate] Custom callback (worker, signal) invoked when sending kill signals.
   */
  constructor(options = {}) {
    const parsedHeartbeat = options.heartbeatTimeoutMs !== undefined ? Number(options.heartbeatTimeoutMs) : 5000;
    this.heartbeatTimeoutMs = Math.max(100, Number.isFinite(parsedHeartbeat) ? parsedHeartbeat : 5000);

    const parsedGrace = options.gracePeriodMs !== undefined ? Number(options.gracePeriodMs) : 1500;
    this.gracePeriodMs = Math.max(50, Number.isFinite(parsedGrace) ? parsedGrace : 1500);

    const parsedLifetime = options.maxWorkerLifetimeMs !== undefined ? Number(options.maxWorkerLifetimeMs) : 3600000;
    this.maxWorkerLifetimeMs = Math.max(1000, Number.isFinite(parsedLifetime) ? parsedLifetime : 3600000);

    this.onTerminate = typeof options.onTerminate === 'function' ? options.onTerminate : null;

    this.activeWorkers = new Map();
    this.reapedWorkers = [];
    this.incidents = [];
  }

  /**
   * Registers a newly spawned worker process or thread.
   * @param {Object} params
   * @param {string} params.workerId
   * @param {number} params.pid
   * @param {Object} [params.metadata]
   * @param {number} [params.spawnTimeMs]
   */
  registerWorker(params) {
    if (!params || typeof params !== 'object') {
      throw new TypeError('Worker parameters must be a non-null object');
    }

    const workerId = String(params.workerId || '').trim();
    if (!workerId) {
      throw new TypeError('workerId must be a non-empty string');
    }

    const pid = Number(params.pid);
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new TypeError('pid must be a positive integer');
    }

    if (this.activeWorkers.has(workerId)) {
      throw new Error(`Worker with ID '${workerId}' is already registered`);
    }

    const spawnTime = Math.max(0, Number(params.spawnTimeMs) || Date.now());
    const workerEntry = {
      workerId,
      pid,
      metadata: params.metadata && typeof params.metadata === 'object' ? { ...params.metadata } : {},
      spawnTimeMs: spawnTime,
      lastHeartbeatMs: spawnTime,
      status: WorkerStatus.HEALTHY,
      terminationAttempts: 0,
      termSignalSentAt: null,
      terminationReason: null,
      exitCode: null,
    };

    this.activeWorkers.set(workerId, workerEntry);
    return { ...workerEntry };
  }

  /**
   * Ingests a keep-alive heartbeat ping from a worker.
   * @param {string} workerId
   * @param {number} [timestampMs]
   */
  recordHeartbeat(workerId, timestampMs = Date.now()) {
    const id = String(workerId || '').trim();
    const worker = this.activeWorkers.get(id);
    if (!worker) {
      return false;
    }

    if (worker.status === WorkerStatus.TERMINATING || worker.status === WorkerStatus.KILLED) {
      return false; // Cannot revive a worker undergoing active liquidation
    }

    const ts = Math.max(worker.lastHeartbeatMs, Number(timestampMs) || Date.now());
    worker.lastHeartbeatMs = ts;
    worker.status = WorkerStatus.HEALTHY;
    return true;
  }

  /**
   * Deregisters a worker that exited cleanly.
   * @param {string} workerId
   * @param {string} [reason='NORMAL_COMPLETION']
   * @param {number} [exitCode=0]
   */
  deregisterWorker(workerId, reason = 'NORMAL_COMPLETION', exitCode = 0) {
    const id = String(workerId || '').trim();
    const worker = this.activeWorkers.get(id);
    if (!worker) {
      return false;
    }

    worker.status = WorkerStatus.REAPED;
    worker.terminationReason = reason;
    worker.exitCode = exitCode;

    this.activeWorkers.delete(id);
    this.reapedWorkers.push({ ...worker, reapedAt: Date.now() });
    return true;
  }

  /**
   * Sweeps active workers, identifies stalled or runaway processes, and applies termination escalation.
   * @param {number} [now=Date.now()]
   * @returns {Object} Sweep execution summary
   */
  sweep(now = Date.now()) {
    const currentTime = Number(now) || Date.now();
    let checked = 0;
    let stalled = 0;
    let terminated = 0;
    let killed = 0;
    let reaped = 0;

    for (const [workerId, worker] of this.activeWorkers.entries()) {
      checked++;
      const heartbeatAge = currentTime - worker.lastHeartbeatMs;
      const totalLifetime = currentTime - worker.spawnTimeMs;

      if (worker.status === WorkerStatus.HEALTHY) {
        let isZombie = false;
        let cause = '';

        if (heartbeatAge > this.heartbeatTimeoutMs) {
          isZombie = true;
          cause = `HEARTBEAT_TIMEOUT (${heartbeatAge}ms > ${this.heartbeatTimeoutMs}ms)`;
        } else if (totalLifetime > this.maxWorkerLifetimeMs) {
          isZombie = true;
          cause = `MAX_LIFETIME_EXCEEDED (${totalLifetime}ms > ${this.maxWorkerLifetimeMs}ms)`;
        }

        if (isZombie) {
          stalled++;
          worker.status = WorkerStatus.TERMINATING;
          worker.terminationReason = cause;
          worker.termSignalSentAt = currentTime;
          worker.terminationAttempts = 1;

          this._emitSignal(worker, TerminationSignal.SIGTERM);
          terminated++;

          this.incidents.push({
            incidentId: `INC-${Date.now()}-${worker.pid}`,
            workerId: worker.workerId,
            pid: worker.pid,
            detectedAt: currentTime,
            cause,
            heartbeatAgeMs: heartbeatAge,
            escalation: [
              { signal: TerminationSignal.SIGTERM, timestamp: currentTime, note: 'Soft termination signal sent' }
            ],
            resolved: false,
          });
        }
      } else if (worker.status === WorkerStatus.TERMINATING) {
        const timeSinceTerm = currentTime - worker.termSignalSentAt;
        if (timeSinceTerm >= this.gracePeriodMs) {
          // Grace period elapsed; escalate to hard kill
          worker.status = WorkerStatus.KILLED;
          worker.terminationAttempts++;
          this._emitSignal(worker, TerminationSignal.SIGKILL);
          killed++;

          const incident = this.incidents.find(inc => inc.workerId === workerId && !inc.resolved);
          if (incident) {
            incident.escalation.push({
              signal: TerminationSignal.SIGKILL,
              timestamp: currentTime,
              note: `Grace period exceeded (${timeSinceTerm}ms >= ${this.gracePeriodMs}ms); escalated to SIGKILL`
            });
            incident.resolved = true;
            incident.resolvedAt = currentTime;
          }

          // Mark worker reaped and remove from active list
          worker.status = WorkerStatus.REAPED;
          this.activeWorkers.delete(workerId);
          this.reapedWorkers.push({ ...worker, reapedAt: currentTime });
          reaped++;
        }
      }
    }

    return {
      timestamp: currentTime,
      checked,
      active: this.activeWorkers.size,
      stalled,
      terminated,
      killed,
      reaped,
    };
  }

  /**
   * Internal dispatcher for signal propagation.
   */
  _emitSignal(worker, signal) {
    if (this.onTerminate) {
      try {
        this.onTerminate(worker, signal);
      } catch (err) {
        // Silently capture custom callback faults to avoid sentinel crash
      }
    }
  }

  /**
   * Fetches metadata for a single worker.
   * @param {string} workerId
   */
  getWorker(workerId) {
    const worker = this.activeWorkers.get(String(workerId || '').trim());
    return worker ? { ...worker } : null;
  }

  /**
   * Returns current active worker count.
   */
  getActiveCount() {
    return this.activeWorkers.size;
  }

  /**
   * Returns all recorded incident postmortems.
   */
  getIncidents() {
    return [...this.incidents];
  }

  /**
   * Generates a markdown formatted incident postmortem log.
   */
  generatePostmortemReport() {
    if (this.incidents.length === 0) {
      return '# Incident Postmortem: No Zombie Incidents Detected\n\nAll worker processes operated within nominal heartbeat and lifespan boundaries.';
    }

    const lines = [
      '# Incident Postmortem: Distributed Worker Zombie Failsafe Report',
      '',
      `**Generated:** ${new Date().toISOString()}`,
      `**Total Incidents Logged:** ${this.incidents.length}`,
      `**Active Workers Remaining:** ${this.activeWorkers.size}`,
      `**Total Workers Reaped:** ${this.reapedWorkers.length}`,
      '',
      '## Incident Summary Table',
      '| Incident ID | Worker ID | PID | Root Cause | Heartbeat Age (ms) | Escalation | Status |',
      '|---|---|---|---|---|---|---|',
    ];

    for (const inc of this.incidents) {
      const signals = inc.escalation.map(e => e.signal).join(' -> ');
      const status = inc.resolved ? 'RESOLVED (REAPED)' : 'ESCALATING';
      lines.push(`| ${inc.incidentId} | ${inc.workerId} | ${inc.pid} | ${inc.cause} | ${inc.heartbeatAgeMs} | ${signals} | ${status} |`);
    }

    lines.push('', '## Root Cause & Remediation Logs');
    for (const inc of this.incidents) {
      lines.push(`### ${inc.incidentId} (Worker: ${inc.workerId}, PID: ${inc.pid})`);
      lines.push(`- **Trigger Cause:** ${inc.cause}`);
      lines.push(`- **Heartbeat Silence:** ${inc.heartbeatAgeMs}ms`);
      lines.push('- **Escalation Timeline:**');
      for (const step of inc.escalation) {
        lines.push(`  - \`[+${step.timestamp - inc.detectedAt}ms]\` **${step.signal}**: ${step.note}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }
}
