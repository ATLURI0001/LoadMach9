import test from 'node:test';
import assert from 'node:assert/strict';
import { SocketBufferSentinel, SentinelStatus } from '../socket_buffer_sentinel.js';

test('SocketBufferSentinel - healthy writes without backpressure', () => {
  const sentinel = new SocketBufferSentinel({ highWaterMarkBytes: 1024, maxBufferCapBytes: 4096 });
  const res = sentinel.trackWrite('sock-1', 512, 0);

  assert.equal(res.allowed, true);
  assert.equal(res.status, SentinelStatus.HEALTHY);
  assert.equal(res.backpressureActive, false);
});

test('SocketBufferSentinel - activates backpressure when highWaterMark exceeded', () => {
  const sentinel = new SocketBufferSentinel({ highWaterMarkBytes: 1024, maxBufferCapBytes: 4096 });
  const res = sentinel.trackWrite('sock-1', 1024, 0);

  assert.equal(res.allowed, true);
  assert.equal(res.status, SentinelStatus.WARNING);
  assert.equal(res.backpressureActive, true);
});

test('SocketBufferSentinel - rejects write exceeding maxBufferCapBytes', () => {
  const sentinel = new SocketBufferSentinel({ highWaterMarkBytes: 1024, maxBufferCapBytes: 2048 });
  const res = sentinel.trackWrite('sock-1', 2500, 0);

  assert.equal(res.allowed, false);
  assert.equal(res.status, SentinelStatus.SATURATED);
  assert.equal(res.reason, 'ERR_BUFFER_OVERFLOW_CEILING');
});

test('SocketBufferSentinel - terminates socket on prolonged drain timeout', () => {
  const sentinel = new SocketBufferSentinel({
    highWaterMarkBytes: 500,
    maxBufferCapBytes: 5000,
    drainTimeoutMs: 1000,
  });

  const t0 = 10000;
  // Frame 1 exceeds highWaterMark
  const res1 = sentinel.trackWrite('sock-timeout', 600, 0, t0);
  assert.equal(res1.allowed, true);
  assert.equal(res1.backpressureActive, true);

  // Frame 2 at t0 + 1500ms > 1000ms drain timeout
  const res2 = sentinel.trackWrite('sock-timeout', 100, 600, t0 + 1500);
  assert.equal(res2.allowed, false);
  assert.equal(res2.status, SentinelStatus.TERMINATED);
  assert.equal(res2.reason, 'ERR_DRAIN_TIMEOUT_EXCEEDED');
});

test('SocketBufferSentinel - drain event resets status to healthy', () => {
  const sentinel = new SocketBufferSentinel({ highWaterMarkBytes: 1000 });
  sentinel.trackWrite('sock-drain', 1200, 0);
  assert.equal(sentinel.getSnapshot('sock-drain').status, SentinelStatus.WARNING);

  sentinel.recordDrain('sock-drain');
  assert.equal(sentinel.getSnapshot('sock-drain').status, SentinelStatus.HEALTHY);
  assert.equal(sentinel.getSnapshot('sock-drain').bufferedBytes, 0);
});
