// rps_latency_rotary.test.js
import { record, snapshot } from './rps_latency_rotary.js';
import assert from 'assert';

record(100, 45);
record(200, 90);
const s = snapshot();
assert.ok(s.avgRps > 0, 'avgRps should be positive');
assert.strictEqual(s.maxP99ms, 90, 'maxP99ms should be 90');
console.log('PASS rps_latency_rotary');
