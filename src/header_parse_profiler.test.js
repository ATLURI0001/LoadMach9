import { benchmarkHeaderParse } from './header_parse_profiler.js';
import assert from 'node:assert/strict';

const res = benchmarkHeaderParse('Host: localhost\r\nAccept: */*', 100);
assert.ok(res.opsPerSec > 0);
console.log('PASS header_parse_profiler');
