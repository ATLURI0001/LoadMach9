// rps_latency_rotary.js — bounded RPS & P99 latency telemetry ring
const RING_SIZE = 60;
const ring = new Array(RING_SIZE).fill(null).map(() => ({ rps: 0, p99ms: 0 }));
let head = 0;

export function record(rps, p99ms) {
  if (rps < 0) throw new Error('rps must be >= 0');
  if (p99ms < 0) throw new Error('p99ms must be >= 0');
  ring[head % RING_SIZE] = { rps, p99ms };
  head++;
}

export function snapshot() {
  const filled = ring.slice(0, Math.min(head, RING_SIZE));
  if (!filled.length) return { avgRps: 0, maxP99ms: 0 };
  const avgRps = filled.reduce((s, e) => s + e.rps, 0) / filled.length;
  const maxP99ms = Math.max(...filled.map(e => e.p99ms));
  return { avgRps, maxP99ms };
}
