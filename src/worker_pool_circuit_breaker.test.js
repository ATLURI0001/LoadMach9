import { WorkerPoolCircuitBreaker } from './worker_pool_circuit_breaker.js';
import assert from 'node:assert/strict';

const cb = new WorkerPoolCircuitBreaker(2, 5000);
assert.throws(() => cb.call(() => { throw new Error('boom'); }));
assert.throws(() => cb.call(() => { throw new Error('boom'); }));
assert.throws(() => cb.call(() => 'ok'), /circuit breaker open/);
console.log('PASS worker_pool_circuit_breaker');
