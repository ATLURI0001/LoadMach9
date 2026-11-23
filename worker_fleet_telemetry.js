/**
 * @file worker_fleet_telemetry.js
 * Distributed Load Testing Worker Fleet Telemetry & Node Degradation Diagnostic.
 *
 * Gathers per-worker load generator metrics, tracks RPS achievement ratios,
 * detects node hot-spotting/skew, and identifies struggling or stalled worker nodes.
 */

export const NodeHealthStatus = Object.freeze({
  HEALTHY: 'HEALTHY',
  STRUGGLING: 'STRUGGLING',
  STALLED: 'STALLED',
});

export class WorkerFleetTelemetryAggregator {
  constructor(options = {}) {
    this.stalledHeartbeatTimeoutMs = Number(options.stalledHeartbeatTimeoutMs) || 15000;
    this.strugglingCpuThreshold = Number(options.strugglingCpuThreshold) || 85.0;
    this.minAchievementRatio = Number(options.minAchievementRatio) || 0.80;

    // Map: workerId -> NodeTelemetry
    this.workers = new Map();
  }

  /**
   * Ingests a telemetry heartbeat from a worker node.
   */
  recordHeartbeat(heartbeat) {
    if (!heartbeat || typeof heartbeat !== 'object') {
      throw new TypeError('Heartbeat must be a non-null object');
    }

    const workerId = String(heartbeat.workerId || '').trim();
    if (!workerId) {
      throw new TypeError('workerId must be a non-empty string');
    }

    const assignedRps = Math.max(0, Number(heartbeat.assignedRps) || 0);
    const actualRps = Math.max(0, Number(heartbeat.actualRps) || 0);
    const cpuPercent = Math.max(0, Math.min(100, Number(heartbeat.cpuPercent) || 0));
    const memoryMb = Math.max(0, Number(heartbeat.memoryMb) || 0);
    const p99LatencyMs = Math.max(0, Number(heartbeat.p99LatencyMs) || 0);
    const errorCount = Math.max(0, Number(heartbeat.errorCount) || 0);
    const timestamp = Number(heartbeat.timestamp) || Date.now();

    const achievementRatio = assignedRps > 0 ? Number((actualRps / assignedRps).toFixed(3)) : 1.0;

    const record = {
      workerId,
      assignedRps,
      actualRps,
      cpuPercent,
      memoryMb,
      p99LatencyMs,
      errorCount,
      achievementRatio,
      lastSeen: timestamp,
    };

    this.workers.set(workerId, record);
    return record;
  }

  /**
   * Evaluates the health status of a specific worker node.
   */
  evaluateNodeHealth(workerId, now = Date.now()) {
    const node = this.workers.get(String(workerId).trim());
    if (!node) {
      return null;
    }

    const elapsedMs = now - node.lastSeen;
    if (elapsedMs > this.stalledHeartbeatTimeoutMs) {
      return NodeHealthStatus.STALLED;
    }

    if (
      node.cpuPercent >= this.strugglingCpuThreshold ||
      (node.assignedRps > 10 && node.achievementRatio < this.minAchievementRatio) ||
      (node.errorCount > 0 && node.actualRps > 0 && (node.errorCount / (node.actualRps * 10)) > 0.05)
    ) {
      return NodeHealthStatus.STRUGGLING;
    }

    return NodeHealthStatus.HEALTHY;
  }

  /**
   * Generates fleet-wide aggregated diagnostic summary.
   */
  generateFleetDiagnostic(now = Date.now()) {
    if (this.workers.size === 0) {
      return {
        totalWorkers: 0,
        healthyWorkers: 0,
        strugglingWorkers: 0,
        stalledWorkers: 0,
        totalAssignedRps: 0,
        totalActualRps: 0,
        fleetAchievementRatio: 1.0,
        meanCpuPercent: 0,
        maxCpuPercent: 0,
        workloadSkewRatio: 1.0,
        nodes: [],
      };
    }

    let totalAssigned = 0;
    let totalActual = 0;
    let sumCpu = 0;
    let maxCpu = 0;
    let minActualRps = Infinity;
    let maxActualRps = 0;

    let healthyCount = 0;
    let strugglingCount = 0;
    let stalledCount = 0;

    const evaluatedNodes = [];

    for (const node of this.workers.values()) {
      const status = this.evaluateNodeHealth(node.workerId, now);

      if (status === NodeHealthStatus.HEALTHY) healthyCount++;
      else if (status === NodeHealthStatus.STRUGGLING) strugglingCount++;
      else if (status === NodeHealthStatus.STALLED) stalledCount++;

      totalAssigned += node.assignedRps;
      totalActual += node.actualRps;
      sumCpu += node.cpuPercent;
      maxCpu = Math.max(maxCpu, node.cpuPercent);

      if (node.actualRps > 0) {
        minActualRps = Math.min(minActualRps, node.actualRps);
        maxActualRps = Math.max(maxActualRps, node.actualRps);
      }

      evaluatedNodes.push({
        ...node,
        status,
      });
    }

    const count = this.workers.size;
    const fleetRatio = totalAssigned > 0 ? Number((totalActual / totalAssigned).toFixed(3)) : 1.0;
    const meanCpu = Number((sumCpu / count).toFixed(1));
    const skew = (minActualRps !== Infinity && minActualRps > 0)
      ? Number((maxActualRps / minActualRps).toFixed(2))
      : 1.0;

    return {
      totalWorkers: count,
      healthyWorkers: healthyCount,
      strugglingWorkers: strugglingCount,
      stalledWorkers: stalledCount,
      totalAssignedRps: totalAssigned,
      totalActualRps: totalActual,
      fleetAchievementRatio: fleetRatio,
      meanCpuPercent: meanCpu,
      maxCpuPercent: maxCpu,
      workloadSkewRatio: skew,
      nodes: evaluatedNodes,
    };
  }

  /**
   * Formats a markdown diagnostic report suitable for operational dashboards.
   */
  formatMarkdownReport(now = Date.now()) {
    const diag = this.generateFleetDiagnostic(now);

    return (
      `### Distributed Load Generator Fleet Telemetry\n\n` +
      `- **Active Workers**: ${diag.totalWorkers} (Healthy: ${diag.healthyWorkers}, Struggling: ${diag.strugglingWorkers}, Stalled: ${diag.stalledWorkers})\n` +
      `- **Throughput**: ${diag.totalActualRps} / ${diag.totalAssignedRps} RPS (${(diag.fleetAchievementRatio * 100).toFixed(1)}% target achieved)\n` +
      `- **CPU Utilization**: Mean ${diag.meanCpuPercent}%, Peak ${diag.maxCpuPercent}%\n` +
      `- **Workload Skew Ratio**: ${diag.workloadSkewRatio}x\n`
    );
  }

  clear() {
    this.workers.clear();
  }
}
