/**
 * High-Dynamic-Range (HDR) Logarithmic Latency Recorder for LoadMach9.
 *
 * Uses a flat BigUint64Array with binary-magnitude buckets and linear sub-buckets
 * for O(1), zero-GC latency recording, distributed worker merging, and coordinated
 * omission correction across 6+ orders of magnitude.
 */

export class HdrLatencyRecorder {
  /**
   * @param {object} [options]
   * @param {number} [options.maxValue=3600000] Highest trackable integer latency unit (e.g. microseconds).
   * @param {number} [options.significantDigits=2] Precision digits (1..3); 2 gives <=1% relative error.
   */
  constructor({ maxValue = 3_600_000, significantDigits = 2 } = {}) {
    if (!Number.isFinite(maxValue) || maxValue < 2) {
      throw new RangeError("maxValue must be a finite number >= 2");
    }
    const sigDigits = Math.max(1, Math.min(3, Math.floor(significantDigits)));
    this.significantDigits = sigDigits;
    this.maxValue = Math.floor(maxValue);

    // Sub-bucket count is next power of two >= 2 * 10^sigDigits
    const largestWithSingleUnit = 2 * Math.pow(10, sigDigits);
    this.subBucketHalfCountMagnitude = Math.ceil(Math.log2(largestWithSingleUnit)) - 1;
    this.subBucketCount = 1 << (this.subBucketHalfCountMagnitude + 1);
    this.subBucketHalfCount = this.subBucketCount >> 1;
    this.subBucketMask = this.subBucketCount - 1;

    // Determine number of magnitude buckets needed to cover maxValue
    let smallestUntrackable = this.subBucketCount;
    let bucketCount = 1;
    while (smallestUntrackable <= this.maxValue) {
      smallestUntrackable *= 2;
      bucketCount += 1;
    }
    this.bucketCount = bucketCount;
    this.countsLen = (bucketCount + 1) * this.subBucketHalfCount;
    this.counts = new BigUint64Array(this.countsLen);

    this.totalCount = 0n;
    this.sum = 0;
    this.minValue = Infinity;
    this.maxObserved = 0;
    this.clampedHigh = 0;
  }

  _bucketIndex(value) {
    if (value < this.subBucketCount) return 0;
    const pow2 = Math.floor(Math.log2(value));
    return Math.max(0, pow2 - this.subBucketHalfCountMagnitude);
  }

  _countsIndex(value) {
    const bucketIdx = this._bucketIndex(value);
    const subBucketIdx = Math.floor(value / Math.pow(2, bucketIdx));
    const idx = ((bucketIdx + 1) << this.subBucketHalfCountMagnitude) + (subBucketIdx - this.subBucketHalfCount);
    return Math.max(0, Math.min(this.countsLen - 1, idx));
  }

  _valueFromIndex(index) {
    let bucketIdx = (index >> this.subBucketHalfCountMagnitude) - 1;
    let subBucketIdx = (index & (this.subBucketHalfCount - 1)) + this.subBucketHalfCount;
    if (bucketIdx < 0) {
      subBucketIdx -= this.subBucketHalfCount;
      bucketIdx = 0;
    }
    return subBucketIdx * Math.pow(2, bucketIdx);
  }

  /**
   * Record a single non-negative latency sample in O(1) without heap allocation.
   */
  record(rawValue, count = 1) {
    if (!Number.isFinite(rawValue) || rawValue < 0) return false;
    const n = Number.isInteger(count) && count > 0 ? count : 1;
    let value = Math.round(rawValue);
    if (value > this.maxValue) {
      value = this.maxValue;
      this.clampedHigh += n;
    }

    const idx = this._countsIndex(value);
    this.counts[idx] += BigInt(n);
    this.totalCount += BigInt(n);
    this.sum += value * n;
    if (value < this.minValue) this.minValue = value;
    if (value > this.maxObserved) this.maxObserved = value;
    return true;
  }

  /**
   * Record a latency sample with Gil Tene coordinated-omission backfill when a pause
   * exceeds the expected inter-arrival interval between scheduled requests.
   */
  recordWithExpectedInterval(rawValue, expectedInterval) {
    if (!this.record(rawValue)) return 0;
    let recorded = 1;
    if (Number.isFinite(expectedInterval) && expectedInterval > 0 && rawValue > expectedInterval) {
      for (let missing = rawValue - expectedInterval; missing >= expectedInterval; missing -= expectedInterval) {
        this.record(missing);
        recorded += 1;
      }
    }
    return recorded;
  }

  /**
   * Extract latency value at a given percentile in [0, 100] (e.g. 99 or 99.9).
   */
  getPercentile(percentile) {
    if (this.totalCount === 0n) return 0;
    const p = Math.max(0, Math.min(100, Number(percentile) || 0));
    if (p === 0) return this.minValue === Infinity ? 0 : this.minValue;

    const target = BigInt(Math.max(1, Math.ceil((p / 100) * Number(this.totalCount))));
    let running = 0n;
    for (let i = 0; i < this.countsLen; i++) {
      const c = this.counts[i];
      if (c === 0n) continue;
      running += c;
      if (running >= target) {
        return Math.min(this.maxObserved, this._valueFromIndex(i));
      }
    }
    return this.maxObserved;
  }

  /**
   * Merge another identically configured HdrLatencyRecorder into this recorder.
   */
  merge(other) {
    if (!(other instanceof HdrLatencyRecorder)) {
      throw new TypeError("merge target must be an HdrLatencyRecorder instance");
    }
    if (
      other.maxValue !== this.maxValue ||
      other.significantDigits !== this.significantDigits ||
      other.countsLen !== this.countsLen
    ) {
      throw new RangeError("Cannot merge HdrLatencyRecorder instances with incompatible bucket geometry");
    }
    for (let i = 0; i < this.countsLen; i++) {
      this.counts[i] += other.counts[i];
    }
    this.totalCount += other.totalCount;
    this.sum += other.sum;
    this.clampedHigh += other.clampedHigh;
    if (other.minValue < this.minValue) this.minValue = other.minValue;
    if (other.maxObserved > this.maxObserved) this.maxObserved = other.maxObserved;
  }

  reset() {
    this.counts.fill(0n);
    this.totalCount = 0n;
    this.sum = 0;
    this.minValue = Infinity;
    this.maxObserved = 0;
    this.clampedHigh = 0;
  }

  getSummary() {
    const count = Number(this.totalCount);
    return {
      count,
      min: count > 0 ? this.minValue : 0,
      max: this.maxObserved,
      mean: count > 0 ? Number((this.sum / count).toFixed(3)) : 0,
      p50: this.getPercentile(50),
      p90: this.getPercentile(90),
      p95: this.getPercentile(95),
      p99: this.getPercentile(99),
      p999: this.getPercentile(99.9),
      clampedHigh: this.clampedHigh,
    };
  }
}
