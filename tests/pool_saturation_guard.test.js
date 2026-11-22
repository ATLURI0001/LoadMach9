import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PoolSaturationGuard, PoolSaturationError } from '../pool_saturation_guard.js';

describe('PoolSaturationGuard Suite', () => {
  test('initializes with verified parameter defaults and boundary clamps', () => {
    const guard = new PoolSaturationGuard();
    const metrics = guard.getMetrics();

    assert.equal(metrics.maxPoolSize, 50);
    assert.equal(metrics.availableSlots, 50);
    assert.equal(metrics.activeConnections, 0);
    assert.equal(metrics.queuedRequests, 0);
    assert.equal(metrics.utilizationRate, 0.0);
    assert.equal(metrics.isSaturated, false);

    // Custom clamped boundaries
    const custom = new PoolSaturationGuard({
      maxPoolSize: -5,
      saturationThreshold: 2.5,
      maxQueueSize: -10,
      queueTimeoutMs: 10,
    });
    assert.equal(custom.maxPoolSize, 50);
    assert.equal(custom.saturationThreshold, 0.8);
    assert.equal(custom.maxQueueSize, 100);
    assert.equal(custom.queueTimeoutMs, 3000);
  });

  test('acquires connection leases within pool capacity and calculates utilization', async () => {
    const guard = new PoolSaturationGuard({ maxPoolSize: 4, saturationThreshold: 0.75 });

    const l1 = await guard.acquire('db-client-1');
    assert.ok(l1.token);
    assert.equal(l1.waitMs, 0);
    assert.equal(l1.isSaturated, false);

    const l2 = await guard.acquire('db-client-2');
    assert.equal(l2.isSaturated, false);

    // 3/4 = 0.75, should hit saturation threshold
    const l3 = await guard.acquire('db-client-3');
    assert.equal(l3.isSaturated, true);

    const m = guard.getMetrics();
    assert.equal(m.activeConnections, 3);
    assert.equal(m.availableSlots, 1);
    assert.equal(m.utilizationRate, 0.75);
    assert.equal(m.isSaturated, true);
    assert.equal(m.stats.saturationEventsTotal, 1);
  });

  test('queues callers when pool is exhausted and resolves FIFO on release', async () => {
    let mockTime = 1000;
    const guard = new PoolSaturationGuard({
      maxPoolSize: 2,
      queueTimeoutMs: 2000,
      clockFn: () => mockTime,
    });

    const l1 = await guard.acquire('c1');
    const l2 = await guard.acquire('c2');
    assert.equal(guard.getMetrics().activeConnections, 2);

    // Third caller must wait in queue
    let resolvedL3 = null;
    const p3 = guard.acquire('c3').then((res) => {
      resolvedL3 = res;
    });

    assert.equal(guard.getMetrics().queuedRequests, 1);
    assert.equal(resolvedL3, null);

    // Advance clock by 150ms and release l1
    mockTime += 150;
    const released = guard.release(l1.token);
    assert.equal(released, true);

    await p3;
    assert.ok(resolvedL3);
    assert.ok(resolvedL3.token);
    assert.equal(resolvedL3.waitMs, 150);
    assert.equal(guard.getMetrics().queuedRequests, 0);
    assert.equal(guard.getMetrics().activeConnections, 2);
  });

  test('enforces load shedding when queue capacity ceiling is exceeded', async () => {
    const guard = new PoolSaturationGuard({
      maxPoolSize: 1,
      maxQueueSize: 2,
    });

    const l1 = await guard.acquire('c1');
    const p1 = guard.acquire('c2');
    const p2 = guard.acquire('c3');

    assert.equal(guard.getMetrics().queuedRequests, 2);

    // Fourth request exceeds queue capacity -> shed immediately
    await assert.rejects(
      async () => {
        await guard.acquire('c4');
      },
      (err) => {
        assert.ok(err instanceof PoolSaturationError);
        assert.equal(err.code, 'POOL_SHED');
        return true;
      }
    );

    assert.equal(guard.getMetrics().stats.shedTotal, 1);

    // Cleanup queue
    guard.release(l1.token);
    const g2 = await p1;
    guard.release(g2.token);
    const g3 = await p2;
    guard.release(g3.token);
  });

  test('aborts queued callers with QUEUE_TIMEOUT when deadline expires', async () => {
    const guard = new PoolSaturationGuard({
      maxPoolSize: 1,
      queueTimeoutMs: 80,
    });

    const l1 = await guard.acquire('c1');

    await assert.rejects(
      async () => {
        await guard.acquire('c2');
      },
      (err) => {
        assert.ok(err instanceof PoolSaturationError);
        assert.equal(err.code, 'QUEUE_TIMEOUT');
        return true;
      }
    );

    assert.equal(guard.getMetrics().stats.queueTimeoutsTotal, 1);
    guard.release(l1.token);
  });

  test('handles unrecognized or duplicate token releases safely', () => {
    const guard = new PoolSaturationGuard();
    assert.equal(guard.release('non-existent-token'), false);
    assert.equal(guard.release(''), false);
    assert.equal(guard.release(null), false);
  });

  test('resets state and flushes active/pending queues cleanly', async () => {
    const guard = new PoolSaturationGuard({ maxPoolSize: 1, maxQueueSize: 5 });
    await guard.acquire('c1');

    let rejectErr = null;
    guard.acquire('c2').catch((err) => {
      rejectErr = err;
    });

    guard.reset();

    const m = guard.getMetrics();
    assert.equal(m.activeConnections, 0);
    assert.equal(m.queuedRequests, 0);
    assert.equal(m.stats.acquiredTotal, 0);

    // Yield tick to verify queue rejection
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(rejectErr instanceof PoolSaturationError);
    assert.equal(rejectErr.code, 'POOL_RESET');
  });

  test('middleware handles normal requests, backpressure headers, and shedding', async () => {
    const guard = new PoolSaturationGuard({
      maxPoolSize: 1,
      maxQueueSize: 0,
    });
    const middleware = guard.createMiddleware();

    // 1. Successful request
    const headers1 = {};
    let nextCalled1 = false;
    let finishHandler1 = null;

    const req1 = { path: '/api/items' };
    const res1 = {
      setHeader: (k, v) => {
        headers1[k] = v;
      },
      once: (event, handler) => {
        if (event === 'finish') finishHandler1 = handler;
      },
    };

    await middleware(req1, res1, () => {
      nextCalled1 = true;
    });

    assert.equal(nextCalled1, true);
    assert.equal(headers1['x-pool-utilization'], '1.00');
    assert.equal(headers1['x-pool-saturated'], 'true');

    // 2. Second request immediately sheds because queue size is 0
    let shedStatus = 0;
    let shedBody = null;
    const shedHeaders = {};

    const req2 = { path: '/api/items' };
    const res2 = {
      setHeader: (k, v) => {
        shedHeaders[k] = v;
      },
      status: (code) => {
        shedStatus = code;
        return {
          json: (data) => {
            shedBody = data;
          },
        };
      },
      once: () => {},
    };

    await middleware(req2, res2, () => {});
    assert.equal(shedStatus, 503);
    assert.equal(shedBody.code, 'POOL_SHED');
    assert.equal(shedHeaders['Retry-After'], '2');

    // Finish first request to release connection
    finishHandler1();
    assert.equal(guard.getMetrics().activeConnections, 0);
  });
});
