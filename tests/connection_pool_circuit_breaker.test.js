import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ConnectionPoolCircuitBreaker,
  MultiPoolCircuitRegistry,
  CIRCUIT_STATES,
  ROUTE_DECISIONS,
} from '../connection_pool_circuit_breaker.js';

test('ConnectionPoolCircuitBreaker: normal checkouts and releases within capacity', () => {
  const breaker = new ConnectionPoolCircuitBreaker({ maxConnections: 2 });
  assert.equal(breaker.state, CIRCUIT_STATES.CLOSED);

  const res1 = breaker.evaluateCheckout();
  assert.equal(res1.decision, ROUTE_DECISIONS.ALLOW_PRIMARY);
  assert.ok(res1.leaseToken.startsWith('conn-'));
  assert.equal(breaker.activeConnections, 1);

  const res2 = breaker.evaluateCheckout();
  assert.equal(res2.decision, ROUTE_DECISIONS.ALLOW_PRIMARY);
  assert.equal(breaker.activeConnections, 2);

  // Release 1
  breaker.releaseCheckout(res1.leaseToken);
  assert.equal(breaker.activeConnections, 1);
});

test('ConnectionPoolCircuitBreaker: trips to OPEN after consecutive starvation events', () => {
  let simulatedTime = 10000;
  const breaker = new ConnectionPoolCircuitBreaker({
    maxConnections: 1,
    consecutiveTimeoutsToOpen: 2,
    baseCooldownMs: 5000,
    clockFn: () => simulatedTime,
  });

  // Acquire only connection
  const res1 = breaker.evaluateCheckout();
  assert.equal(res1.decision, ROUTE_DECISIONS.ALLOW_PRIMARY);

  // Starvation 1
  const resStarve1 = breaker.evaluateCheckout();
  assert.equal(resStarve1.decision, ROUTE_DECISIONS.SHED_REQUEST);
  assert.equal(breaker.state, CIRCUIT_STATES.CLOSED);

  // Starvation 2 -> trips to OPEN
  const resStarve2 = breaker.evaluateCheckout({ useCache: true });
  assert.equal(resStarve2.decision, ROUTE_DECISIONS.ROUTE_FALLBACK);
  assert.equal(breaker.state, CIRCUIT_STATES.OPEN);

  // When OPEN, fast fails / routes fallback immediately
  const resOpen = breaker.evaluateCheckout({ useCache: true });
  assert.equal(resOpen.decision, ROUTE_DECISIONS.ROUTE_FALLBACK);
  assert.ok(resOpen.retryAfterMs > 0);
});

test('ConnectionPoolCircuitBreaker: HALF_OPEN recovery via canary probing', () => {
  let simulatedTime = 10000;
  const breaker = new ConnectionPoolCircuitBreaker({
    maxConnections: 5,
    consecutiveTimeoutsToOpen: 1,
    baseCooldownMs: 5000,
    canaryProbeLimit: 2,
    clockFn: () => simulatedTime,
  });

  // Force fill capacity and starve
  for (let i = 0; i < 5; i++) {
    breaker.evaluateCheckout();
  }
  breaker.evaluateCheckout(); // Trips to OPEN
  assert.equal(breaker.state, CIRCUIT_STATES.OPEN);

  // Advance time past cooldown
  simulatedTime += 6000;

  // First checkout transitions to HALF_OPEN and issues canary token
  const c1 = breaker.evaluateCheckout();
  assert.equal(breaker.state, CIRCUIT_STATES.HALF_OPEN);
  assert.equal(c1.decision, ROUTE_DECISIONS.ALLOW_PRIMARY);
  assert.ok(c1.leaseToken.startsWith('canary-'));

  // Canary 1 succeeds
  breaker.releaseCheckout(c1.leaseToken);
  assert.equal(breaker.state, CIRCUIT_STATES.HALF_OPEN);

  // Canary 2
  const c2 = breaker.evaluateCheckout();
  breaker.releaseCheckout(c2.leaseToken);

  // Reaches canary probe limit -> recovers to CLOSED
  assert.equal(breaker.state, CIRCUIT_STATES.CLOSED);
});

test('ConnectionPoolCircuitBreaker: MultiPoolCircuitRegistry isolation', () => {
  const registry = new MultiPoolCircuitRegistry();
  const poolA = registry.getOrCreate('pool-auth', { maxConnections: 1, consecutiveTimeoutsToOpen: 1 });
  const poolB = registry.getOrCreate('pool-catalog', { maxConnections: 10 });

  // Saturate and trip poolA
  poolA.evaluateCheckout();
  poolA.evaluateCheckout();
  assert.equal(poolA.state, CIRCUIT_STATES.OPEN);

  // poolB remains unaffected and CLOSED
  const resB = poolB.evaluateCheckout();
  assert.equal(poolB.state, CIRCUIT_STATES.CLOSED);
  assert.equal(resB.decision, ROUTE_DECISIONS.ALLOW_PRIMARY);
});
