import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { TelemetryRotary } from '../telemetry_rotary.js';

describe('TelemetryRotary & SLA Violation Engine', () => {
  let rotary;

  beforeEach(() => {
    rotary = new TelemetryRotary({
      maxErrorRate: 0.05,
      maxP99LatencyMs: 200,
      minThroughputRps: 50,
      warningThresholdRatio: 0.8
    });
  });

  describe('Recording and basic metrics', () => {
    it('should initialize with clean default state', () => {
      assert.equal(rotary.totalRequests, 0);
      assert.equal(rotary.getErrorCount(), 0);
      assert.equal(rotary.getErrorRate(), 0.0);
      assert.equal(rotary.getPercentile(50), 0);
    });

    it('should track status code distributions and latencies', () => {
      rotary.recordRequest(200, 10);
      rotary.recordRequest(200, 20);
      rotary.recordRequest(201, 30);
      rotary.recordRequest(500, 100);

      assert.equal(rotary.totalRequests, 4);
      assert.equal(rotary.getErrorCount(), 1);
      assert.equal(rotary.getErrorRate(), 0.25);
      assert.equal(rotary.statusCodes.get(200), 2);
      assert.equal(rotary.statusCodes.get(201), 1);
      assert.equal(rotary.statusCodes.get(500), 1);
    });

    it('should treat code 0 (network/timeout) as error', () => {
      rotary.recordRequest(0, 5000);
      assert.equal(rotary.getErrorCount(), 1);
      assert.equal(rotary.getErrorRate(), 1.0);
    });
  });

  describe('Percentile calculations', () => {
    it('should compute exact percentiles across sorted distributions', () => {
      for (let i = 1; i <= 100; i++) {
        rotary.recordRequest(200, i);
      }

      assert.equal(rotary.getPercentile(50), 50);
      assert.equal(rotary.getPercentile(90), 90);
      assert.equal(rotary.getPercentile(95), 95);
      assert.equal(rotary.getPercentile(99), 99);
      assert.equal(rotary.getPercentile(100), 100);
    });
  });

  describe('SLA Compliance and Violation Engine', () => {
    it('should evaluate as COMPLIANT when all metrics are within safe limits', () => {
      const baseTime = 1000000;
      for (let i = 0; i < 50; i++) {
        rotary.recordRequest(200, 30, baseTime + i * 10); // 100 req/s
      }

      const evalResult = rotary.evaluateSLA();
      assert.equal(evalResult.status, 'COMPLIANT');
      assert.equal(evalResult.isCompliant, true);
      assert.equal(evalResult.violations.length, 0);
      assert.equal(evalResult.metrics.totalRequests, 50);
      assert.equal(evalResult.metrics.errorRate, 0);
    });

    it('should flag AT_RISK when latency approaches warning threshold (80% of limit)', () => {
      const baseTime = 1000000;
      for (let i = 0; i < 98; i++) {
        rotary.recordRequest(200, 50, baseTime + i * 10);
      }
      rotary.recordRequest(200, 170, baseTime + 980); // 170ms >= 0.8 * 200 = 160ms
      rotary.recordRequest(200, 180, baseTime + 990);

      const evalResult = rotary.evaluateSLA();
      assert.equal(evalResult.status, 'AT_RISK');
      assert.equal(evalResult.isCompliant, true);
      assert.equal(evalResult.violations.length, 1);
      assert.equal(evalResult.violations[0].severity, 'WARNING');
      assert.equal(evalResult.violations[0].metric, 'p99_latency_ms');
    });

    it('should flag BREACHED when error rate exceeds threshold', () => {
      for (let i = 0; i < 90; i++) {
        rotary.recordRequest(200, 20);
      }
      for (let i = 0; i < 10; i++) {
        rotary.recordRequest(503, 20); // 10% error rate > 5% max
      }

      const evalResult = rotary.evaluateSLA();
      assert.equal(evalResult.status, 'BREACHED');
      assert.equal(evalResult.isCompliant, false);
      assert.ok(evalResult.violations.some(v => v.metric === 'error_rate' && v.severity === 'CRITICAL'));
    });

    it('should flag BREACHED when p99 latency breaches limit', () => {
      for (let i = 0; i < 98; i++) {
        rotary.recordRequest(200, 10);
      }
      rotary.recordRequest(200, 250); // 250ms > 200ms
      rotary.recordRequest(200, 300);

      const evalResult = rotary.evaluateSLA();
      assert.equal(evalResult.status, 'BREACHED');
      assert.equal(evalResult.isCompliant, false);
      assert.ok(evalResult.violations.some(v => v.metric === 'p99_latency_ms' && v.severity === 'CRITICAL'));
    });

    it('should flag BREACHED when sustained throughput drops below minimum', () => {
      const baseTime = 1000000;
      // 25 requests over 2.5 seconds = 10 req/s < 50 req/s
      for (let i = 0; i < 25; i++) {
        rotary.recordRequest(200, 15, baseTime + i * 100);
      }

      const evalResult = rotary.evaluateSLA();
      assert.equal(evalResult.status, 'BREACHED');
      assert.equal(evalResult.isCompliant, false);
      assert.ok(evalResult.violations.some(v => v.metric === 'throughput_rps' && v.severity === 'CRITICAL'));
    });
  });

  describe('Prometheus Exposition Export', () => {
    it('should generate valid Prometheus text format', () => {
      rotary.recordRequest(200, 25);
      rotary.recordRequest(500, 150);

      const text = rotary.exportPrometheus('loadmach9_prod');
      assert.ok(text.includes('loadmach9_requests_total{job="loadmach9_prod"} 2'));
      assert.ok(text.includes('loadmach9_errors_total{job="loadmach9_prod"} 1'));
      assert.ok(text.includes('loadmach9_latency_ms{job="loadmach9_prod",quantile="0.99"} 150'));
      assert.ok(text.includes('loadmach9_http_status_total{job="loadmach9_prod",status="200"} 1'));
      assert.ok(text.includes('loadmach9_http_status_total{job="loadmach9_prod",status="500"} 1'));
      assert.ok(text.includes('loadmach9_sla_compliant{job="loadmach9_prod"}'));
    });
  });
});
