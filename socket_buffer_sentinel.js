/**
 * INC-2026-LOAD-7741: Socket Pipe Buffer Overflow & Backpressure Sentinel.
 * 
 * Guards load generation workers against unhandled socket write buffer saturation,
 * missing drain event handling, and memory leakage during downstream throughput throttling.
 */

export const SentinelStatus = {
  HEALTHY: 'HEALTHY',
  WARNING: 'WARNING',
  SATURATED: 'SATURATED',
  TERMINATED: 'TERMINATED',
};

export class SocketBufferSentinel {
  /**
   * @param {Object} options
   * @param {number} [options.highWaterMarkBytes=65536] Socket highWaterMark (default 64KB)
   * @param {number} [options.maxBufferCapBytes=1048576] Absolute memory threshold before hard drop (1MB)
   * @param {number} [options.drainTimeoutMs=3000] Maximum duration socket can remain paused without drain
   */
  constructor(options = {}) {
    this.highWaterMarkBytes = options.highWaterMarkBytes ?? 65536;
    this.maxBufferCapBytes = options.maxBufferCapBytes ?? 1048576;
    this.drainTimeoutMs = options.drainTimeoutMs ?? 3000;

    this.sockets = new Map();
    this.incidentAuditLog = [];
  }

  /**
   * Tracks a socket write attempt.
   * @param {string} socketId
   * @param {number} bytesToWrite
   * @param {number} currentBufferedAmount
   * @param {number} [now=Date.now()]
   * @returns {{allowed: boolean, status: string, backpressureActive: boolean, reason?: string}}
   */
  trackWrite(socketId, bytesToWrite, currentBufferedAmount, now = Date.now()) {
    let state = this.sockets.get(socketId);
    if (!state) {
      state = {
        socketId,
        bufferedBytes: 0,
        backpressureStartTime: 0,
        droppedFrames: 0,
        totalBytesWritten: 0,
        status: SentinelStatus.HEALTHY,
      };
      this.sockets.set(socketId, state);
    }

    const projectedBuffer = currentBufferedAmount + bytesToWrite;
    state.bufferedBytes = projectedBuffer;

    // Check absolute buffer overflow threshold
    if (projectedBuffer > this.maxBufferCapBytes) {
      state.droppedFrames++;
      state.status = SentinelStatus.SATURATED;
      this._logIncident('ERR_BUFFER_OVERFLOW_CEILING', socketId, {
        projectedBuffer,
        cap: this.maxBufferCapBytes,
      });

      return {
        allowed: false,
        status: state.status,
        backpressureActive: true,
        reason: 'ERR_BUFFER_OVERFLOW_CEILING',
      };
    }

    // Check high water mark threshold
    const backpressureActive = projectedBuffer >= this.highWaterMarkBytes;
    if (backpressureActive) {
      if (state.backpressureStartTime === 0) {
        state.backpressureStartTime = now;
      }

      const durationMs = now - state.backpressureStartTime;
      if (durationMs > this.drainTimeoutMs) {
        state.status = SentinelStatus.TERMINATED;
        this._logIncident('ERR_DRAIN_TIMEOUT_EXCEEDED', socketId, { durationMs });
        return {
          allowed: false,
          status: state.status,
          backpressureActive: true,
          reason: 'ERR_DRAIN_TIMEOUT_EXCEEDED',
        };
      }

      state.status = SentinelStatus.WARNING;
    } else {
      state.backpressureStartTime = 0;
      state.status = SentinelStatus.HEALTHY;
    }

    state.totalBytesWritten += bytesToWrite;

    return {
      allowed: true,
      status: state.status,
      backpressureActive,
    };
  }

  /**
   * Records a drain event for a socket, resetting backpressure timer.
   * @param {string} socketId
   */
  recordDrain(socketId) {
    const state = this.sockets.get(socketId);
    if (state) {
      state.bufferedBytes = 0;
      state.backpressureStartTime = 0;
      if (state.status !== SentinelStatus.TERMINATED) {
        state.status = SentinelStatus.HEALTHY;
      }
    }
  }

  /**
   * Cleans up tracking for a closed or destroyed socket.
   * @param {string} socketId
   */
  untrack(socketId) {
    this.sockets.delete(socketId);
  }

  _logIncident(code, socketId, metadata) {
    this.incidentAuditLog.push({
      timestamp: Date.now(),
      code,
      socketId,
      metadata,
    });
  }

  getSnapshot(socketId) {
    return this.sockets.get(socketId);
  }
}
