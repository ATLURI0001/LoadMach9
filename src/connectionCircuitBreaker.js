// connectionCircuitBreaker.js - circuit breaker for upstream connections
let failures = 0;
let open = false;

export function recordConnFailure(threshold = 3) {
  failures++;
  if (failures >= threshold) open = true;
}

export function isConnOpen() { return open; }
export function resetConn() { failures = 0; open = false; }
