import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { recordConnFailure, isConnOpen, resetConn } from './connectionCircuitBreaker.js';

describe('connectionCircuitBreaker', () => {
  it('opens after threshold failures', () => {
    resetConn();
    recordConnFailure(2); recordConnFailure(2);
    assert.equal(isConnOpen(), true);
  });
});
