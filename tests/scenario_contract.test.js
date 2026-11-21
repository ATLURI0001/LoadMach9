import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAndValidateDuration,
  validateTargetUrl,
  sanitizeHeaders,
  validateSloThresholds,
  validateScenarioSpec
} from '../scenario_contract.js';

describe('Benchmark Scenario Specification Contract & Ingress Sanitizer', () => {
  describe('parseAndValidateDuration', () => {
    it('should parse valid duration strings across standard units', () => {
      assert.deepEqual(parseAndValidateDuration('500ms'), { valid: true, durationMs: 500 });
      assert.deepEqual(parseAndValidateDuration('30s'), { valid: true, durationMs: 30000 });
      assert.deepEqual(parseAndValidateDuration('5m'), { valid: true, durationMs: 300000 });
      assert.deepEqual(parseAndValidateDuration('1h'), { valid: true, durationMs: 3600000 });
    });

    it('should accept valid numeric milliseconds', () => {
      assert.deepEqual(parseAndValidateDuration(2500), { valid: true, durationMs: 2500 });
    });

    it('should reject durations below minimum threshold (100ms)', () => {
      const res = parseAndValidateDuration('50ms');
      assert.equal(res.valid, false);
      assert.match(res.error, /below minimum/);
    });

    it('should reject durations exceeding maximum boundary (24h)', () => {
      const res = parseAndValidateDuration('25h');
      assert.equal(res.valid, false);
      assert.match(res.error, /exceeds maximum/);
    });

    it('should reject invalid or malformed format strings', () => {
      assert.equal(parseAndValidateDuration('abc').valid, false);
      assert.equal(parseAndValidateDuration('-10s').valid, false);
      assert.equal(parseAndValidateDuration(null).valid, false);
    });
  });

  describe('validateTargetUrl', () => {
    it('should validate and normalize standard http and https targets', () => {
      const res = validateTargetUrl('http://127.0.0.1:8080/api/v1/bench?count=100');
      assert.equal(res.valid, true);
      assert.equal(res.sanitizedUrl, 'http://127.0.0.1:8080/api/v1/bench?count=100');
    });

    it('should reject prohibited protocols (ftp, file, ws, javascript)', () => {
      assert.equal(validateTargetUrl('ftp://bench.local/load').valid, false);
      assert.equal(validateTargetUrl('file:///etc/passwd').valid, false);
      assert.equal(validateTargetUrl('javascript:alert(1)').valid, false);
    });

    it('should reject control characters and CRLF injection sequences', () => {
      const res = validateTargetUrl('http://example.com/api\r\nHost: malicious.com');
      assert.equal(res.valid, false);
      assert.match(res.error, /CRLF sequences/);
    });

    it('should reject out-of-range port numbers', () => {
      assert.equal(validateTargetUrl('http://example.com:70000/').valid, false);
      assert.equal(validateTargetUrl('http://example.com:0/').valid, false);
    });
  });

  describe('sanitizeHeaders', () => {
    it('should sanitize valid headers and normalize keys to lowercase', () => {
      const input = {
        'Content-Type': 'application/json',
        'X-Trace-ID': 'trace-98765'
      };
      const res = sanitizeHeaders(input);
      assert.equal(res.valid, true);
      assert.deepEqual(res.sanitizedHeaders, {
        'content-type': 'application/json',
        'x-trace-id': 'trace-98765'
      });
    });

    it('should reject CRLF injection in header values', () => {
      const input = {
        'X-Custom': 'value\r\nSet-Cookie: stolen=session'
      };
      const res = sanitizeHeaders(input);
      assert.equal(res.valid, false);
      assert.match(res.errors[0], /CRLF injection/);
    });

    it('should reject invalid RFC 7230 header field names', () => {
      const input = {
        'Invalid Header Name': 'value',
        'Test@Bad:Key': 'value'
      };
      const res = sanitizeHeaders(input);
      assert.equal(res.valid, false);
      assert.equal(res.errors.length, 2);
    });
  });

  describe('validateSloThresholds', () => {
    it('should accept valid SLA percentile thresholds and limits', () => {
      const thresholds = {
        maxP99LatencyMs: 150,
        maxP95LatencyMs: 100,
        maxErrorRatePct: 0.5,
        minRps: 1000
      };
      const res = validateSloThresholds(thresholds);
      assert.equal(res.valid, true);
      assert.deepEqual(res.sanitizedThresholds, thresholds);
    });

    it('should reject out-of-range error rate percentages or non-positive latencies', () => {
      const bad = {
        maxP99LatencyMs: -10,
        maxErrorRatePct: 150
      };
      const res = validateSloThresholds(bad);
      assert.equal(res.valid, false);
      assert.equal(res.errors.length, 2);
    });
  });

  describe('validateScenarioSpec', () => {
    it('should validate and construct a complete sanitized scenario spec', () => {
      const spec = {
        url: 'https://service.internal:8443/metrics',
        method: 'post',
        duration: '15s',
        connections: 250,
        pipelining: 4,
        headers: {
          Authorization: 'Bearer token-xyz'
        },
        body: { query: 'SELECT 1' },
        thresholds: {
          maxP99LatencyMs: 200
        }
      };

      const res = validateScenarioSpec(spec);
      assert.equal(res.valid, true);
      assert.equal(res.errors.length, 0);
      assert.equal(res.sanitizedSpec.method, 'POST');
      assert.equal(res.sanitizedSpec.durationMs, 15000);
      assert.equal(res.sanitizedSpec.connections, 250);
      assert.equal(res.sanitizedSpec.pipelining, 4);
      assert.equal(res.sanitizedSpec.headers['content-type'], 'application/json');
      assert.equal(res.sanitizedSpec.body, '{"query":"SELECT 1"}');
      assert.equal(res.sanitizedSpec.thresholds.maxP99LatencyMs, 200);
    });

    it('should aggregate multiple validation failures defensively', () => {
      const invalidSpec = {
        url: 'invalid-url',
        method: 'UNSUPPORTED',
        connections: 999999,
        duration: '5ms'
      };

      const res = validateScenarioSpec(invalidSpec);
      assert.equal(res.valid, false);
      assert.ok(res.errors.length >= 4);
    });
  });
});
