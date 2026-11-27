import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ResponseTimeRotary } from './response_time_rotary.js';

describe('ResponseTimeRotary', () => {
  it('caps at capacity', () => {
    const r = new ResponseTimeRotary(3);
    for (let i = 0; i < 5; i++) r.record(i * 10);
    assert.equal(r.length, 3);
  });
});
