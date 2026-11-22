import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ChaosFaultInjector } from '../chaos_injector.js';

describe('ChaosFaultInjector Core Suite', () => {
  test('initializes with default options and inactive state when faultRate is 0', () => {
    const injector = new ChaosFaultInjector({ faultRate: 0.0 });
    const decision = injector.decide('/api/v1/resource');

    assert.equal(decision.shouldInject, false);
    assert.equal(decision.latencyMs, 0);
    assert.equal(decision.error, null);
    assert.equal(decision.abort, false);

    const telemetry = injector.getTelemetry();
    assert.equal(telemetry.totalRequests, 1);
    assert.equal(telemetry.injectedFaults, 0);
  });

  test('respects master switch enabled: false', () => {
    const injector = new ChaosFaultInjector({ enabled: false, faultRate: 1.0 });
    const decision = injector.decide('/test');
    assert.equal(decision.shouldInject, false);
    assert.equal(injector.getTelemetry().injectedFaults, 0);
  });

  test('injects errors predictably when faultRate is 1.0 and abortRate is 0.0', () => {
    const injector = new ChaosFaultInjector({
      faultRate: 1.0,
      abortRate: 0.0,
      errorFaults: [{ status: 503, weight: 1, message: 'Service Unavailable' }]
    });

    const decision = injector.decide('/items');
    assert.equal(decision.shouldInject, true);
    assert.equal(decision.abort, false);
    assert.ok(decision.error);
    assert.equal(decision.error.status, 503);
    assert.equal(decision.error.message, 'Service Unavailable');

    const telemetry = injector.getTelemetry();
    assert.equal(telemetry.injectedFaults, 1);
    assert.equal(telemetry.errorsInjectedCount, 1);
  });

  test('injects simulated connection abort when abortRate is 1.0', () => {
    const injector = new ChaosFaultInjector({
      faultRate: 1.0,
      abortRate: 1.0
    });

    const decision = injector.decide('/data');
    assert.equal(decision.shouldInject, true);
    assert.equal(decision.abort, true);
    assert.equal(decision.error, null);
    assert.equal(injector.getTelemetry().abortsInjectedCount, 1);
  });

  test('generates valid latency within bounds across distributions', () => {
    const uniformInjector = new ChaosFaultInjector({
      latencyJitter: { minMs: 50, maxMs: 150, distribution: 'uniform' }
    });
    for (let i = 0; i < 20; i++) {
      const lat = uniformInjector.calculateLatency();
      assert.ok(lat >= 50 && lat <= 150, `Uniform latency out of bounds: ${lat}`);
    }

    const gaussianInjector = new ChaosFaultInjector({
      latencyJitter: { minMs: 100, maxMs: 300, distribution: 'gaussian' }
    });
    for (let i = 0; i < 20; i++) {
      const lat = gaussianInjector.calculateLatency();
      assert.ok(lat >= 100 && lat <= 300, `Gaussian latency out of bounds: ${lat}`);
    }

    const paretoInjector = new ChaosFaultInjector({
      latencyJitter: { minMs: 20, maxMs: 80, distribution: 'pareto' }
    });
    for (let i = 0; i < 20; i++) {
      const lat = paretoInjector.calculateLatency();
      assert.ok(lat >= 20 && lat <= 80, `Pareto latency out of bounds: ${lat}`);
    }
  });

  test('enforces blast radius maxFaultsPerWindow limit', () => {
    const injector = new ChaosFaultInjector({
      faultRate: 1.0,
      maxFaultsPerWindow: 5,
      windowMs: 10000
    });

    for (let i = 0; i < 5; i++) {
      const decision = injector.decide('/query');
      assert.equal(decision.shouldInject, true);
    }

    // 6th request should hit the blast radius budget exhaustion
    const overflow = injector.decide('/query');
    assert.equal(overflow.shouldInject, false);

    const telemetry = injector.getTelemetry();
    assert.equal(telemetry.injectedFaults, 5);
    assert.equal(telemetry.budgetExhaustedCount, 1);
    assert.equal(telemetry.activeBudgetRemaining, 0);
  });

  test('filters requests by targetPaths and excludePaths', () => {
    const injector = new ChaosFaultInjector({
      faultRate: 1.0,
      targetPaths: ['/api', /^\/checkout/],
      excludePaths: ['/api/health']
    });

    assert.equal(injector.matchesPath('/api/health'), false);
    assert.equal(injector.matchesPath('/api/users'), true);
    assert.equal(injector.matchesPath('/checkout/pay'), true);
    assert.equal(injector.matchesPath('/static/main.css'), false);

    assert.equal(injector.decide('/api/health').shouldInject, false);
    assert.equal(injector.decide('/api/users').shouldInject, true);
  });

  test('resets telemetry and budgets accurately', () => {
    const injector = new ChaosFaultInjector({ faultRate: 1.0 });
    injector.decide('/test');
    assert.equal(injector.getTelemetry().totalRequests, 1);

    injector.reset();
    const clean = injector.getTelemetry();
    assert.equal(clean.totalRequests, 0);
    assert.equal(clean.injectedFaults, 0);
    assert.equal(clean.activeBudgetRemaining, 100);
  });

  test('Express middleware seamlessly intercepts and injects chaos', async () => {
    const injector = new ChaosFaultInjector({
      faultRate: 1.0,
      errorFaults: [{ status: 504, message: 'Gateway Timeout' }]
    });

    const middleware = injector.expressMiddleware();

    let nextCalled = false;
    let sentStatus = null;
    let sentJson = null;

    const req = { path: '/orders' };
    const res = {
      status(code) {
        sentStatus = code;
        return this;
      },
      json(data) {
        sentJson = data;
        return this;
      }
    };
    const next = () => { nextCalled = true; };

    await middleware(req, res, next);

    assert.equal(nextCalled, false);
    assert.equal(sentStatus, 504);
    assert.equal(sentJson.error, 'ChaosFaultInjected');
    assert.equal(sentJson.message, 'Gateway Timeout');
  });

  test('Fastify hook seamlessly intercepts and injects chaos', async () => {
    const injector = new ChaosFaultInjector({
      faultRate: 1.0,
      errorFaults: [{ status: 500, message: 'Chaos Boom' }]
    });

    const hook = injector.fastifyHook();

    let codeSent = null;
    let bodySent = null;

    const request = { url: '/payments' };
    const reply = {
      code(c) {
        codeSent = c;
        return this;
      },
      send(b) {
        bodySent = b;
        return this;
      }
    };

    await hook(request, reply);

    assert.equal(codeSent, 500);
    assert.equal(bodySent.error, 'ChaosFaultInjected');
    assert.equal(bodySent.message, 'Chaos Boom');
  });
});
