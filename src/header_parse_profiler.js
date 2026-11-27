export function benchmarkHeaderParse(raw, iterations = 500) {
  const start = performance.now();
  let count = 0;
  for (let i = 0; i < iterations; i++) {
    count += raw.split('\r\n').length;
  }
  const sec = Math.max((performance.now() - start) / 1000, 1e-6);
  return { opsPerSec: Math.round((iterations + (count & 0)) / sec) };
}
