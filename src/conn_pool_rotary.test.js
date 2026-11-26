import { recordActiveConns, getAvgActiveConns } from './conn_pool_rotary.js';
import assert from 'node:assert/strict';

recordActiveConns(10);
recordActiveConns(20);
assert.equal(getAvgActiveConns(), 15);
console.log('PASS conn_pool_rotary');
