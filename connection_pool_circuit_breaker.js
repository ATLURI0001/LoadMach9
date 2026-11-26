import crypto from 'node:crypto';

export const CIRCUIT_STATES = Object.freeze({
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN',
});

export const ROUTE_DECISIONS = Object.freeze({
  ALLOW_PRIMARY: 'ALLOW_PRIMARY',
  ROUTE_FALLBACK: 'ROUTE_FALLBACK',
  SHED_REQUEST: 'SHED_REQUEST',
});

export class PoolCircuitBreakerError extends Error {
  constructor(message, code) {
    super(`[PoolCircuitBreaker][${code}] ${message}`);
    this.name = 'PoolCircuitBreakerError';
    this.code = code;
  }
}

/**
 * ConnectionPoolCircuitBreaker guards HTTP/database connection pools against starvation cascades.
 */
export class ConnectionPoolCircuitBreaker {
  /**
   * @param {Object} [options={}]
   * @param {string} [options.poolName='default-pool']
   * @param {number} [options.maxConnections=20]
   * @param {number} [options.checkoutTimeoutMs=1000]
   * @param {number} [options.consecutiveTimeoutsToOpen=2]
   * @param {number} [options.baseCooldownMs=5000]
   * @param {number} [options.maxCooldownMs=60000]
   * @param {number} [options.canaryProbeLimit=2]
   * @param {Function} [options.clockFn=Date.now]
   */
  constructor(options = {}) {
    this.poolName = String(options.poolName || 'default-pool');
    this.maxConnections = Math.max(1, Number(options.maxConnections) || 20);
    this.checkoutTimeoutMs = Math.max(50, Number(options.checkoutTimeoutMs) || 1000);
    this.consecutiveTimeoutsToOpen = Math.max(1, Number(options.consecutiveTimeoutsToOpen) || 2);
    this.baseCooldownMs = Math.max(500, Number(options.baseCooldownMs) || 5000);
    this.maxCooldownMs = Math.max(this.baseCooldownMs, Number(options.maxCooldownMs) || 60000);
    this.canaryProbeLimit = Math.max(1, Number(options.canaryProbeLimit) || 2);
    this.clockFn = typeof options.clockFn === 'function' ? options.clockFn : Date.now;

    this.state = CIRCUIT_STATES.CLOSED;
    this.activeConnections = 0;
    this.consecutiveTimeouts = 0;
    this.backoffStep = 0;
    this.openedAt = null;
    this.cooldownDuration = this.baseCooldownMs;
    this.probesInFlight = 0;
    this.successfulCanaries = 0;

    this.metrics = {
      totalRequests: 0,
      primaryAllowed: 0,
      fallbackRouted: 0,
      shedRequests: 0,
      starvationTrips: 0,
    };
  }

  _calculateCooldown() {
    const mult = Math.pow(2, Math.min(this.backoffStep, 5));
    const raw = Math.min(this.maxCooldownMs, this.baseCooldownMs * mult);
    const jitter = raw * 0.1;
    return raw + (Math.random() * (jitter * 2) - jitter);
  }

  /**
   * Evaluates request against connection pool availability and circuit state.
   * @param {Object} [fallbackConfig] - Optional fallback payload/handler
   * @returns {{ decision: string, leaseToken: string|null, retryAfterMs: number|null }}
   */
  evaluateCheckout(fallbackConfig = null) {
    const now = this.clockFn();
    this.metrics.totalRequests += 1;

    // State transition: Check if OPEN cooldown has elapsed
    if (this.state === CIRCUIT_STATES.OPEN) {
      if (now >= this.openedAt + this.cooldownDuration) {
        this.state = CIRCUIT_STATES.HALF_OPEN;
        this.probesInFlight = 0;
        this.successfulCanaries = 0;
      }
    }

    // Branch according to circuit state
    if (this.state === CIRCUIT_STATES.OPEN) {
      const remainingCooldown = Math.max(0, this.openedAt + this.cooldownDuration - now);
      return this._handleFallbackOrShed(fallbackConfig, remainingCooldown);
    }

    if (this.state === CIRCUIT_STATES.HALF_OPEN) {
      if (this.probesInFlight >= this.canaryProbeLimit) {
        return this._handleFallbackOrShed(fallbackConfig, 1000);
      }
      this.probesInFlight += 1;
      this.activeConnections += 1;
      this.metrics.primaryAllowed += 1;
      const leaseToken = `canary-${crypto.randomBytes(6).toString('hex')}`;
      return { decision: ROUTE_DECISIONS.ALLOW_PRIMARY, leaseToken, retryAfterMs: null };
    }

    // CLOSED state: Verify physical connection capacity
    if (this.activeConnections < this.maxConnections) {
      this.activeConnections += 1;
      this.metrics.primaryAllowed += 1;
      const leaseToken = `conn-${crypto.randomBytes(6).toString('hex')}`;
      return { decision: ROUTE_DECISIONS.ALLOW_PRIMARY, leaseToken, retryAfterMs: null };
    }

    // Starvation: Pool capacity exhausted -> record starvation timeout and evaluate trip
    this._recordStarvationTimeout(now);
    return this._handleFallbackOrShed(fallbackConfig, this.checkoutTimeoutMs);
  }

  _handleFallbackOrShed(fallbackConfig, retryAfterMs) {
    if (fallbackConfig) {
      this.metrics.fallbackRouted += 1;
      return { decision: ROUTE_DECISIONS.ROUTE_FALLBACK, leaseToken: null, retryAfterMs };
    }
    this.metrics.shedRequests += 1;
    return { decision: ROUTE_DECISIONS.SHED_REQUEST, leaseToken: null, retryAfterMs };
  }

  _recordStarvationTimeout(now) {
    this.consecutiveTimeouts += 1;
    this.metrics.starvationTrips += 1;

    if (this.state === CIRCUIT_STATES.HALF_OPEN) {
      // Canary probe failed -> immediately trip back to OPEN
      this.state = CIRCUIT_STATES.OPEN;
      this.backoffStep += 1;
      this.openedAt = now;
      this.cooldownDuration = this._calculateCooldown();
      this.probesInFlight = 0;
    } else if (this.state === CIRCUIT_STATES.CLOSED) {
      if (this.consecutiveTimeouts >= this.consecutiveTimeoutsToOpen) {
        this.state = CIRCUIT_STATES.OPEN;
        this.openedAt = now;
        this.cooldownDuration = this._calculateCooldown();
      }
    }
  }

  /**
   * Releases an active connection lease.
   * @param {string} leaseToken
   */
  releaseCheckout(leaseToken) {
    if (!leaseToken || typeof leaseToken !== 'string') {
      throw new PoolCircuitBreakerError('Invalid lease token provided', 'ERR_INVALID_TOKEN');
    }

    this.activeConnections = Math.max(0, this.activeConnections - 1);
    this.consecutiveTimeouts = 0;

    if (this.state === CIRCUIT_STATES.HALF_OPEN && leaseToken.startsWith('canary-')) {
      this.successfulCanaries += 1;
      if (this.successfulCanaries >= this.canaryProbeLimit) {
        // Recovery
        this.state = CIRCUIT_STATES.CLOSED;
        this.backoffStep = 0;
        this.openedAt = null;
        this.probesInFlight = 0;
      }
    }
  }

  /**
   * Force reset of the circuit breaker state and active connections.
   */
  reset() {
    this.state = CIRCUIT_STATES.CLOSED;
    this.activeConnections = 0;
    this.consecutiveTimeouts = 0;
    this.backoffStep = 0;
    this.openedAt = null;
    this.probesInFlight = 0;
    this.successfulCanaries = 0;
  }
}

/**
 * MultiPoolCircuitRegistry isolates connection pool circuit breakers across distinct upstream endpoints.
 */
export class MultiPoolCircuitRegistry {
  constructor() {
    this._breakers = new Map();
  }

  getOrCreate(poolName, options = {}) {
    if (!this._breakers.has(poolName)) {
      this._breakers.set(poolName, new ConnectionPoolCircuitBreaker({ ...options, poolName }));
    }
    return this._breakers.get(poolName);
  }
}
