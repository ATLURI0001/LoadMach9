import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { recordFailure, isOpen, reset } from './requestCircuitBreaker.js';

describe('requestCircuitBreaker', () => {
  it('opens after threshold failures', () => {
    reset();
    recordFailure(); recordFailure(); recordFailure();
    assert.equal(isOpen(), true);
  });
});
