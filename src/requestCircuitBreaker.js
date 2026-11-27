// requestCircuitBreaker.js - ESM circuit breaker for HTTP requests
let failures = 0;
const THRESHOLD = 3;
let open = false;

export function recordFailure() {
  failures++;
  if (failures >= THRESHOLD) open = true;
}

export function isOpen() { return open; }

export function reset() { failures = 0; open = false; }
