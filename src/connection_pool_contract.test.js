import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validatePoolConfig } from './connection_pool_contract.js';

describe('ConnectionPoolContract', () => {
  it('passes valid config', () => {
    validatePoolConfig({ maxConn: 10 });
  });
  it('throws on invalid config', () => {
    assert.throws(() => validatePoolConfig({ maxConn: 0 }), /invalid pool config/);
  });
});
