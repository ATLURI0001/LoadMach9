import test from 'node:test';
import assert from 'node:assert/strict';
import { LoadProfileContract } from '../load_profile_contract.js';

test('LoadProfileContract - validates compliant load profile', () => {
  const res = LoadProfileContract.validate({
    targetUrl: 'https://api.example.com/health',
    virtualUsers: 500,
    durationSec: 60,
    rampUpSec: 10,
  });
  assert.equal(res.valid, true);
  assert.equal(res.errors.length, 0);
});

test('LoadProfileContract - rejects unsafe VU counts and invalid URLs', () => {
  const res = LoadProfileContract.validate({
    targetUrl: 'ftp://bad-scheme',
    virtualUsers: 50000,
    durationSec: -5,
  }, 10000);

  assert.equal(res.valid, false);
  assert.ok(res.errors.includes('ERR_INVALID_TARGET_URL'));
  assert.ok(res.errors.some((e) => e.includes('ERR_VUS_OUT_OF_BOUNDS')));
  assert.ok(res.errors.includes('ERR_INVALID_DURATION'));
});
