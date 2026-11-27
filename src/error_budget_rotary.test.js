import { recordErrorRate, getAvgErrorRate } from './error_budget_rotary.js';
import assert from 'node:assert/strict';

recordErrorRate(0.01);
recordErrorRate(0.03);
assert.equal(getAvgErrorRate(), 0.02);
console.log('PASS error_budget_rotary');
