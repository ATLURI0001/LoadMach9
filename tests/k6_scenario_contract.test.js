import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateAndSanitizeK6Scenario,
  parseScenarioDurationMs,
  ScenarioContractError,
} from '../k6_scenario_contract.js';

describe('k6 Scenario Ingress Contract & Threshold Sanitizer', () => {
  test('parses duration strings accurately across units', () => {
    assert.equal(parseScenarioDurationMs('250ms'), 250);
    assert.equal(parseScenarioDurationMs('45s'), 45000);
    assert.equal(parseScenarioDurationMs('2.5m'), 150000);
    assert.equal(parseScenarioDurationMs('1h'), 3600000);

    assert.throws(() => parseScenarioDurationMs('invalid'), /Invalid duration format/);
    assert.throws(() => parseScenarioDurationMs(-50), /positive finite/);
  });

  test('validates and sanitizes standard constant-vus and ramping-vus scenarios', () => {
    const raw = {
      targetUrl: 'https://api.example.com/load',
      scenarios: {
        baseline: {
          executor: 'constant-vus',
          vus: 20,
          duration: '30s',
        },
        stress: {
          executor: 'ramping-vus',
          stages: [
            { duration: '10s', target: 50 },
            { duration: '30s', target: 200 },
          ],
        },
      },
      thresholds: {
        http_req_duration: ['p(95)<400', 'p(99)<800'],
        http_req_failed: ['rate<0.01'],
      },
    };

    const sanitized = validateAndSanitizeK6Scenario(raw);

    assert.equal(sanitized.targetUrl, 'https://api.example.com/load');
    assert.equal(sanitized.scenarios.baseline.executor, 'constant-vus');
    assert.equal(sanitized.scenarios.baseline.vus, 20);
    assert.equal(sanitized.scenarios.baseline.durationMs, 30000);

    assert.equal(sanitized.scenarios.stress.executor, 'ramping-vus');
    assert.equal(sanitized.scenarios.stress.durationMs, 40000);
    assert.equal(sanitized.scenarios.stress.stages.length, 2);

    assert.deepEqual(sanitized.thresholds.http_req_duration, ['p(95)<400', 'p(99)<800']);
  });

  test('rejects non-http target protocols', () => {
    assert.throws(
      () => validateAndSanitizeK6Scenario({ targetUrl: 'ftp://files.example.com' }),
      /protocol must be http or https/
    );
  });

  test('rejects unsupported executor types', () => {
    assert.throws(
      () =>
        validateAndSanitizeK6Scenario({
          targetUrl: 'https://api.example.com',
          scenarios: {
            bad: { executor: 'super-hyper-burst' },
          },
        }),
      /Unsupported executor/
    );
  });

  test('rejects malformed threshold expressions', () => {
    assert.throws(
      () =>
        validateAndSanitizeK6Scenario({
          targetUrl: 'https://api.example.com',
          thresholds: {
            http_req_duration: ['invalid-threshold-format'],
          },
        }),
      /Invalid threshold expression/
    );
  });

  test('detects and blocks prototype pollution keys', () => {
    const malicious = JSON.parse('{"targetUrl": "https://api.example.com", "__proto__": {"injected": true}}');
    assert.throws(() => validateAndSanitizeK6Scenario(malicious), /Forbidden prototype/);
  });
});
