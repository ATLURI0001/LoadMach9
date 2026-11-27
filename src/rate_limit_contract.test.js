import { validateRateLimitConfig } from './rate_limit_contract.js';
import assert from 'node:assert/strict';

assert.equal(validateRateLimitConfig({ maxRps: 100, burst: 200 }), true);
assert.throws(() => validateRateLimitConfig({ maxRps: 100, burst: 50 }));
console.log('PASS rate_limit_contract');
