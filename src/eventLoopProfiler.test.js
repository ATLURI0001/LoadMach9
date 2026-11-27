import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventLoopProfiler } from './eventLoopProfiler.js';

describe('EventLoopProfiler', () => {
  it('tracks max event loop lag', () => {
    const p = new EventLoopProfiler();
    p.record(2); p.record(9);
    assert.equal(p.maxLag(), 9);
  });
});
