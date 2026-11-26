/**
 * HTTP Payload Buffer Pool & Zero-Copy Reuse Benchmark Profiler.
 * 
 * Benchmarks pre-allocated Uint8Array buffer pooling vs dynamic Buffer.alloc
 * under high-RPS load generation bursts.
 */

export class PayloadPoolProfiler {
  constructor(poolSize = 128, bufferSize = 4096) {
    this.poolSize = poolSize;
    this.bufferSize = bufferSize;
    this.pool = [];
    for (let i = 0; i < poolSize; i++) {
      this.pool.push(new Uint8Array(bufferSize));
    }
    this.hits = 0;
    this.misses = 0;
  }

  acquire() {
    if (this.pool.length > 0) {
      this.hits++;
      return this.pool.pop();
    }
    this.misses++;
    return new Uint8Array(this.bufferSize);
  }

  release(buf) {
    if (this.pool.length < this.poolSize && buf.byteLength === this.bufferSize) {
      this.pool.push(buf);
    }
  }

  runBenchmark(batchSize = 100, iterations = 50) {
    const latenciesMicros = [];
    const tStart = performance.now();

    for (let iter = 0; iter < iterations; iter++) {
      const start = performance.now();
      const acquired = [];
      for (let i = 0; i < batchSize; i++) {
        acquired.push(this.acquire());
      }
      for (let i = 0; i < batchSize; i++) {
        this.release(acquired[i]);
      }
      latenciesMicros.push(((performance.now() - start) * 1000) / batchSize);
    }

    const totalSec = (performance.now() - tStart) / 1000;
    latenciesMicros.sort((a, b) => a - b);

    return {
      batchSize,
      iterations,
      poolHitRatePct: Number(((this.hits / (this.hits + this.misses)) * 100).toFixed(2)),
      p50Microseconds: Number(latenciesMicros[Math.floor(iterations * 0.5)].toFixed(3)),
      p90Microseconds: Number(latenciesMicros[Math.floor(iterations * 0.9)].toFixed(3)),
      throughputOpsSec: Math.round((batchSize * iterations) / Math.max(1e-6, totalSec)),
    };
  }
}
