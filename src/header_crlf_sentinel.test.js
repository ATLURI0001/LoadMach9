import { assertSafeHeaderValue } from './header_crlf_sentinel.js';
import assert from 'node:assert/strict';

assertSafeHeaderValue('application/json');
assert.throws(() => assertSafeHeaderValue('val\r\nX-Injected: true'));
console.log('PASS header_crlf_sentinel');
