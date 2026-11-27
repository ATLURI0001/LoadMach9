import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WorkerPoolRotary } from './workerPoolRotary.js';

describe('WorkerPoolRotary', () => {
  it('bounds entries to max size', () => {
    const r = new WorkerPoolRotary(2);
    r.push('w1'); r.push('w2'); r.push('w3');
    assert.equal(r.count(), 2);
  });
});
