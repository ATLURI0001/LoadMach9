const samples = [];
const CAP = 32;

export function recordErrorRate(rate) {
  if (rate < 0 || rate > 1) throw new Error('rate must be in [0, 1]');
  if (samples.length >= CAP) samples.shift();
  samples.push(rate);
}

export function getAvgErrorRate() {
  if (!samples.length) return 0;
  return samples.reduce((a, b) => a + b, 0) / samples.length;
}
