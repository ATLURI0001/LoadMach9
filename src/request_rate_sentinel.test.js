import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RequestRateSentinel } from './request_rate_sentinel.js';

describe('RequestRateSentinel', () => {
  it('throws when over limit', () => {
    const s = new RequestRateSentinel(1);
    s.check();
    assert.throws(() => s.check(), /rate limit exceeded/);
  });
});
