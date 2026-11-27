import { DnsResolveCircuitBreaker } from './dns_resolve_circuit_breaker.js';
import assert from 'node:assert/strict';

const cb = new DnsResolveCircuitBreaker(2, 5000);
assert.throws(() => cb.call(() => { throw new Error('ENOTFOUND'); }));
assert.throws(() => cb.call(() => { throw new Error('ENOTFOUND'); }));
assert.throws(() => cb.call(() => '127.0.0.1'), /circuit open/);
console.log('PASS dns_resolve_circuit_breaker');
