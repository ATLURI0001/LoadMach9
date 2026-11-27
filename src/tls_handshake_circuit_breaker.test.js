import { TlsHandshakeCircuitBreaker } from './tls_handshake_circuit_breaker.js';
import assert from 'node:assert/strict';

const cb = new TlsHandshakeCircuitBreaker(2, 5000);
assert.throws(() => cb.call(() => { throw new Error('CERT_EXPIRED'); }));
assert.throws(() => cb.call(() => { throw new Error('CERT_EXPIRED'); }));
assert.throws(() => cb.call(() => 'ok'), /circuit open/);
console.log('PASS tls_handshake_circuit_breaker');
