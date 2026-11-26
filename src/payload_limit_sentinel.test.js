import { assertPayloadWithinLimit } from './payload_limit_sentinel.js';
import assert from 'node:assert/strict';

assertPayloadWithinLimit(512, 1024);
assert.throws(() => assertPayloadWithinLimit(2048, 1024));
console.log('PASS payload_limit_sentinel');
