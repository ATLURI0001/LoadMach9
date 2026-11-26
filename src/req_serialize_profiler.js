export function benchmarkReqSerialize(obj, iterations = 1000) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) JSON.stringify(obj);
  const sec = Math.max((performance.now() - start) / 1000, 1e-6);
  return { opsPerSec: Math.round(iterations / sec) };
}
