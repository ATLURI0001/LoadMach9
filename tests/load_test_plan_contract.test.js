import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateAndSanitizeLoadTestPlan,
  LoadTestPlanContractError,
} from '../load_test_plan_contract.js';

describe('LoadTestPlanContract Suite', () => {
  test('validates and normalizes nominal load test plan', () => {
    const raw = {
      version: 'loadmach9/v1',
      planId: 'plan-benchmark-auth-service.v1',
      target: 'https://gateway.example.com/api/v1/auth?region=us-east',
      method: 'post',
      concurrency: 50,
      durationSec: 120,
      pipelining: 4,
      headers: {
        'Authorization': 'Bearer test-token',
        'X-Client-ID': 'load-runner-1',
      },
      thresholds: [
        { metric: 'p99', operator: '<', value: 250 },
        { metric: 'error_rate', operator: '<=', value: 0.01 },
      ],
      stages: [
        { targetRps: 100, durationSec: 30 },
        { targetRps: 500, durationSec: 60 },
        { targetRps: 0, durationSec: 30 },
      ],
    };

    const sanitized = validateAndSanitizeLoadTestPlan(raw);
    assert.equal(sanitized.version, 'loadmach9/v1');
    assert.equal(sanitized.planId, 'plan-benchmark-auth-service.v1');
    assert.equal(sanitized.target, 'https://gateway.example.com/api/v1/auth?region=us-east');
    assert.equal(sanitized.method, 'POST');
    assert.equal(sanitized.concurrency, 50);
    assert.equal(sanitized.durationSec, 120);
    assert.equal(sanitized.pipelining, 4);
    assert.equal(sanitized.headers['authorization'], 'Bearer test-token');
    assert.equal(sanitized.thresholds.length, 2);
    assert.equal(sanitized.stages.length, 3);
    assert.ok(sanitized.validatedAt);
  });

  test('rejects invalid schema version', () => {
    assert.throws(
      () => validateAndSanitizeLoadTestPlan({ version: 'v3-unsupported', planId: 'p1', target: 'http://api.com' }),
      (err) => err instanceof LoadTestPlanContractError && err.code === 'ERR_INVALID_VERSION'
    );
  });

  test('validates planId constraints', () => {
    assert.throws(
      () => validateAndSanitizeLoadTestPlan({ planId: 'ab', target: 'http://api.com' }), // too short
      (err) => err instanceof LoadTestPlanContractError && err.code === 'ERR_INVALID_PLAN_ID'
    );
    assert.throws(
      () => validateAndSanitizeLoadTestPlan({ planId: 'plan with spaces!', target: 'http://api.com' }),
      (err) => err instanceof LoadTestPlanContractError && err.code === 'ERR_INVALID_PLAN_ID'
    );
  });

  test('enforces SSRF and loopback protection', () => {
    assert.throws(
      () => validateAndSanitizeLoadTestPlan({ planId: 'valid-id', target: 'http://localhost:8080/drain' }),
      (err) => err instanceof LoadTestPlanContractError && err.code === 'ERR_DISALLOWED_TARGET'
    );
    assert.throws(
      () => validateAndSanitizeLoadTestPlan({ planId: 'valid-id', target: 'http://169.254.169.254/latest/meta-data' }),
      (err) => err instanceof LoadTestPlanContractError && err.code === 'ERR_DISALLOWED_TARGET'
    );
    assert.throws(
      () => validateAndSanitizeLoadTestPlan({ planId: 'valid-id', target: 'ftp://api.example.com' }),
      (err) => err instanceof LoadTestPlanContractError && err.code === 'ERR_DISALLOWED_TARGET'
    );
  });

  test('enforces allowedTargetHosts whitelist when configured', () => {
    const opts = { allowedTargetHosts: ['staging.example.com'] };
    assert.throws(
      () => validateAndSanitizeLoadTestPlan({ planId: 'valid-id', target: 'https://production.example.com' }, opts),
      (err) => err instanceof LoadTestPlanContractError && err.code === 'ERR_DISALLOWED_TARGET'
    );

    const allowed = validateAndSanitizeLoadTestPlan({ planId: 'valid-id', target: 'https://sub.staging.example.com/test' }, opts);
    assert.ok(allowed.target.includes('sub.staging.example.com'));
  });

  test('enforces boundary ceilings for concurrency and duration', () => {
    assert.throws(
      () => validateAndSanitizeLoadTestPlan({ planId: 'valid-id', target: 'https://api.com', concurrency: 50000 }, { maxAllowedConcurrency: 1000 }),
      (err) => err instanceof LoadTestPlanContractError && err.code === 'ERR_BOUNDARY_EXCEEDED'
    );
    assert.throws(
      () => validateAndSanitizeLoadTestPlan({ planId: 'valid-id', target: 'https://api.com', durationSec: 999999 }, { maxAllowedDurationSec: 3600 }),
      (err) => err instanceof LoadTestPlanContractError && err.code === 'ERR_BOUNDARY_EXCEEDED'
    );
  });

  test('blocks header CRLF injection attacks', () => {
    const maliciousHeaders = {
      'X-Injected\r\nSet-Cookie: admin=true': 'value',
    };
    assert.throws(
      () => validateAndSanitizeLoadTestPlan({ planId: 'valid-id', target: 'https://api.com', headers: maliciousHeaders }),
      (err) => err instanceof LoadTestPlanContractError && err.code === 'ERR_HEADER_INJECTION'
    );
  });

  test('blocks prototype pollution keys in root and headers', () => {
    const poisonedPlan = JSON.parse('{"planId": "valid-id", "target": "https://api.com", "__proto__": {"polluted": true}}');
    assert.throws(
      () => validateAndSanitizeLoadTestPlan(poisonedPlan),
      (err) => err instanceof LoadTestPlanContractError && err.code === 'ERR_PROTOTYPE_POLLUTION'
    );

    const poisonedHeaderPlan = JSON.parse('{"planId": "valid-id", "target": "https://api.com", "headers": {"__proto__": "attack"}}');
    assert.throws(
      () => validateAndSanitizeLoadTestPlan(poisonedHeaderPlan),
      (err) => err instanceof LoadTestPlanContractError && err.code === 'ERR_PROTOTYPE_POLLUTION'
    );
  });

  test('validates threshold metrics and operators', () => {
    assert.throws(
      () => validateAndSanitizeLoadTestPlan({
        planId: 'valid-id',
        target: 'https://api.com',
        thresholds: [{ metric: 'unknown_metric', operator: '<', value: 100 }],
      }),
      (err) => err instanceof LoadTestPlanContractError && err.code === 'ERR_INVALID_THRESHOLD'
    );

    assert.throws(
      () => validateAndSanitizeLoadTestPlan({
        planId: 'valid-id',
        target: 'https://api.com',
        thresholds: [{ metric: 'p95', operator: '~=', value: 100 }],
      }),
      (err) => err instanceof LoadTestPlanContractError && err.code === 'ERR_INVALID_THRESHOLD'
    );
  });
});
