import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PayloadSizeSentinel } from './payloadSizeSentinel.js';

describe('PayloadSizeSentinel', () => {
  it('flags oversized payloads', () => {
    const s = new PayloadSizeSentinel(100);
    assert.equal(s.check(50), true);
    assert.equal(s.check(200), false);
    assert.equal(s.flaggedCount(), 1);
  });
});
