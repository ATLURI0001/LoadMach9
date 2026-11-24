import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ScenarioThresholdContract,
  ScenarioContractError,
  SSRFViolationError,
  ThresholdSyntaxError,
} from '../scenario_threshold_contract.js';

describe('ScenarioThresholdContract Suite', () => {
  it('validates and normalizes compliant load scenario manifest', () => {
    const contract = new ScenarioThresholdContract({ maxVUs: 5000 });
    const manifest = {
      scenarioId: 'checkout_stress_v2',
      targetUrl: 'https://api.production.internal/v1/orders',
      vus: 500,
      duration: '5m',
      thresholds: {
        http_req_duration: ['p(95) < 350', 'p(99) <= 1000', 'avg < 150'],
        http_req_failed: ['rate < 0.01'],
      },
    };

    const verified = contract.validateScenario(manifest);
    assert.equal(verified.scenarioId, 'checkout_stress_v2');
    assert.equal(verified.targetUrl, 'https://api.production.internal/v1/orders');
    assert.equal(verified.vus, 500);
    assert.equal(verified.durationSec, 300);
    assert.equal(verified.thresholds.http_req_duration.length, 3);
    assert.equal(verified.thresholds.http_req_duration[0].operator, '<');
    assert.equal(verified.thresholds.http_req_duration[0].value, 350);
    assert.ok(typeof verified.checksum === 'string' && verified.checksum.length === 64);
  });

  it('rejects SSRF attempts targeting metadata and loopback addresses', () => {
    const contract = new ScenarioThresholdContract({ allowLocalhost: false });

    // AWS metadata
    assert.throws(
      () => contract.validateTargetUrl('http://169.254.169.254/latest/meta-data'),
      (err) => {
        assert.ok(err instanceof SSRFViolationError);
        assert.ok(err.message.includes('SSRF security violation'));
        return true;
      }
    );

    // Loopback localhost
    assert.throws(
      () => contract.validateTargetUrl('http://localhost:8080/admin'),
      SSRFViolationError
    );

    // 127.0.0.1
    assert.throws(
      () => contract.validateTargetUrl('http://127.0.0.1:9000/internal'),
      SSRFViolationError
    );
  });

  it('tolerates localhost when explicitly permitted', () => {
    const contract = new ScenarioThresholdContract({ allowLocalhost: true });
    const url = contract.validateTargetUrl('http://localhost:3000/api');
    assert.equal(url, 'http://localhost:3000/api');
  });

  it('rejects non-http/https protocols', () => {
    const contract = new ScenarioThresholdContract();
    assert.throws(
      () => contract.validateTargetUrl('file:///etc/passwd'),
      ScenarioContractError
    );
    assert.throws(
      () => contract.validateTargetUrl('ftp://internal.server/data'),
      ScenarioContractError
    );
  });

  it('detects and intercepts malformed threshold syntax', () => {
    const contract = new ScenarioThresholdContract();

    // Invalid metric expression
    assert.throws(
      () => contract.validateThresholds({ duration: ['invalid_expression'] }),
      ThresholdSyntaxError
    );

    // Out of bounds percentile (> 100)
    assert.throws(
      () => contract.validateThresholds({ duration: ['p(105) < 500'] }),
      (err) => {
        assert.ok(err instanceof ThresholdSyntaxError);
        assert.ok(err.message.includes('out of bounds'));
        return true;
      }
    );
  });

  it('enforces VUs and duration ceilings', () => {
    const contract = new ScenarioThresholdContract({ maxVUs: 100, maxDurationSec: 3600 });

    assert.throws(
      () => contract.validateScenario({
        scenarioId: 'oversized',
        targetUrl: 'https://example.com',
        vus: 500, // exceeds 100
      }),
      (err) => {
        assert.ok(err instanceof ScenarioContractError);
        assert.ok(err.message.includes('exceeds bounds'));
        return true;
      }
    );
  });

  it('defends against prototype pollution in scenario manifests', () => {
    const contract = new ScenarioThresholdContract();
    const malicious = JSON.parse('{"scenarioId": "attack", "__proto__": {"polluted": true}}');

    assert.throws(
      () => contract.validateScenario(malicious),
      (err) => {
        assert.ok(err instanceof ScenarioContractError);
        assert.ok(err.message.includes('Prototype pollution attempt detected'));
        return true;
      }
    );
  });
});
