import { benchmarkReqSerialize } from './req_serialize_profiler.js';
import assert from 'node:assert/strict';

const res = benchmarkReqSerialize({ id: 1, method: 'GET' }, 200);
assert.ok(res.opsPerSec > 0);
console.log('PASS req_serialize_profiler');
