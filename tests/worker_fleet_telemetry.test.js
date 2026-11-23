import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  WorkerFleetTelemetryAggregator,
  NodeHealthStatus,
} from '../worker_fleet_telemetry.js';

describe('WorkerFleetTelemetryAggregator Suite', () => {
  it('initializes with default settings and empty worker map', () => {
    const agg = new WorkerFleetTelemetryAggregator();
    const diag = agg.generateFleetDiagnostic();
    assert.equal(diag.totalWorkers, 0);
    assert.equal(diag.healthyWorkers, 0);
    assert.equal(diag.fleetAchievementRatio, 1.0);
  });

  it('records worker heartbeat and computes achievement ratio', () => {
    const agg = new WorkerFleetTelemetryAggregator();
    const rec = agg.recordHeartbeat({
      workerId: 'worker-node-1',
      assignedRps: 1000,
      actualRps: 950,
      cpuPercent: 45,
      memoryMb: 512,
      p99LatencyMs: 12.5,
      errorCount: 0,
      timestamp: 1000,
    });

    assert.equal(rec.workerId, 'worker-node-1');
    assert.equal(rec.achievementRatio, 0.95);
    assert.equal(agg.evaluateNodeHealth('worker-node-1', 1000), NodeHealthStatus.HEALTHY);
  });

  it('detects STRUGGLING node on high CPU or degraded achievement ratio', () => {
    const agg = new WorkerFleetTelemetryAggregator({ strugglingCpuThreshold: 80 });

    // High CPU node
    agg.recordHeartbeat({
      workerId: 'worker-overload',
      assignedRps: 500,
      actualRps: 490,
      cpuPercent: 88,
      timestamp: 2000,
    });
    assert.equal(agg.evaluateNodeHealth('worker-overload', 2000), NodeHealthStatus.STRUGGLING);

    // Degraded RPS achievement
    agg.recordHeartbeat({
      workerId: 'worker-slow',
      assignedRps: 1000,
      actualRps: 600, // 60% < 80% threshold
      cpuPercent: 50,
      timestamp: 2000,
    });
    assert.equal(agg.evaluateNodeHealth('worker-slow', 2000), NodeHealthStatus.STRUGGLING);
  });

  it('detects STALLED node on heartbeat timeout', () => {
    const agg = new WorkerFleetTelemetryAggregator({ stalledHeartbeatTimeoutMs: 10000 });
    agg.recordHeartbeat({
      workerId: 'worker-dead',
      assignedRps: 100,
      actualRps: 100,
      timestamp: 1000,
    });

    // 15 seconds later -> stalled
    assert.equal(agg.evaluateNodeHealth('worker-dead', 16000), NodeHealthStatus.STALLED);
  });

  it('aggregates fleet-wide metrics, workload skew, and formats markdown', () => {
    const agg = new WorkerFleetTelemetryAggregator();
    const now = 10000;

    agg.recordHeartbeat({
      workerId: 'worker-a',
      assignedRps: 1000,
      actualRps: 1000,
      cpuPercent: 40,
      timestamp: now,
    });
    agg.recordHeartbeat({
      workerId: 'worker-b',
      assignedRps: 1000,
      actualRps: 500, // 2x skew from worker-a
      cpuPercent: 30,
      timestamp: now,
    });

    const diag = agg.generateFleetDiagnostic(now);
    assert.equal(diag.totalWorkers, 2);
    assert.equal(diag.totalAssignedRps, 2000);
    assert.equal(diag.totalActualRps, 1500);
    assert.equal(diag.fleetAchievementRatio, 0.75);
    assert.equal(diag.meanCpuPercent, 35);
    assert.equal(diag.maxCpuPercent, 40);
    assert.equal(diag.workloadSkewRatio, 2.0);

    const md = agg.formatMarkdownReport(now);
    assert.ok(md.includes('Distributed Load Generator Fleet Telemetry'));
    assert.ok(md.includes('**Throughput**: 1500 / 2000 RPS (75.0% target achieved)'));
    assert.ok(md.includes('**Workload Skew Ratio**: 2x'));
  });

  it('rejects invalid heartbeat payload inputs defensively', () => {
    const agg = new WorkerFleetTelemetryAggregator();
    assert.throws(() => agg.recordHeartbeat(null), TypeError);
    assert.throws(() => agg.recordHeartbeat({ workerId: '' }), TypeError);
    assert.equal(agg.evaluateNodeHealth('non-existent'), null);
  });
});
