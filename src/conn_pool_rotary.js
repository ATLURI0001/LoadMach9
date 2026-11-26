const samples = [];
const CAP = 32;

export function recordActiveConns(count) {
  if (count < 0) throw new Error('count must be non-negative');
  if (samples.length >= CAP) samples.shift();
  samples.push(count);
}

export function getAvgActiveConns() {
  if (!samples.length) return 0;
  return samples.reduce((a, b) => a + b, 0) / samples.length;
}
