import crypto from "crypto";

const generateCode = (length = 500) => {
  const len = Number.isSafeInteger(length) && length > 0 ? length : 500;
  const numBytes = Math.ceil((len * 3) / 4);
  return crypto.randomBytes(numBytes).toString("base64").substring(0, len);
};

const generateBatchCodes = (count = 10, length = 500) => {
  const safeCount = Number.isSafeInteger(count) && count > 0 ? Math.min(count, 10000) : 10;
  const codes = new Array(safeCount);
  for (let i = 0; i < safeCount; i++) {
    codes[i] = generateCode(length);
  }
  return codes;
};

const parsePositiveInteger = (val, fallback = 0) => {
  if (typeof val === "number" && Number.isSafeInteger(val) && val >= 0) {
    return val;
  }
  if (typeof val === "string") {
    const clean = val.trim();
    if (/^\d+$/.test(clean)) {
      const parsed = Number.parseInt(clean, 10);
      if (Number.isSafeInteger(parsed)) return parsed;
    }
  }
  return Number.isSafeInteger(fallback) && fallback >= 0 ? fallback : 0;
};

const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return `${i === 0 ? val : val.toFixed(2)} ${units[i]}`;
};

const computePercentiles = (values, percentiles = [50, 90, 95, 99]) => {
  if (!Array.isArray(values) || values.length === 0) return {};
  const valid = values.filter((v) => typeof v === "number" && Number.isFinite(v) && v >= 0);
  if (valid.length === 0) return {};
  valid.sort((a, b) => a - b);

  const result = {};
  for (const p of percentiles) {
    if (!Number.isFinite(p) || p < 0 || p > 100) continue;
    const rank = Math.max(0, Math.min(valid.length - 1, Math.ceil((p / 100) * valid.length) - 1));
    result[`p${p}`] = valid[rank];
  }
  return result;
};

const parseDurationMs = (str, fallback = 1000) => {
  const safeFallback = Number.isSafeInteger(fallback) && fallback >= 0 ? fallback : 1000;
  if (typeof str === "number" && Number.isFinite(str) && str >= 0) {
    return Math.floor(str);
  }
  if (typeof str !== "string") return safeFallback;
  const match = str.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/);
  if (!match) return safeFallback;
  const val = Number.parseFloat(match[1]);
  if (!Number.isFinite(val) || val < 0) return safeFallback;
  const unit = match[2] || "ms";
  switch (unit) {
    case "h": return Math.floor(val * 3600000);
    case "m": return Math.floor(val * 60000);
    case "s": return Math.floor(val * 1000);
    case "ms":
    default:
      return Math.floor(val);
  }
};

const calculateRps = (requestCount, durationMs) => {
  if (!Number.isFinite(requestCount) || !Number.isFinite(durationMs)) return 0;
  if (requestCount <= 0 || durationMs <= 0) return 0;
  const rps = requestCount / (durationMs / 1000);
  return Number.isFinite(rps) ? Number(rps.toFixed(2)) : 0;
};

const computeThroughputStats = (latencies, durationMs = 0) => {
  if (!Array.isArray(latencies) || latencies.length === 0) {
    return {
      totalRequests: 0,
      rps: 0,
      min: 0,
      max: 0,
      mean: 0,
      percentiles: {},
    };
  }
  const valid = latencies.filter((v) => typeof v === "number" && Number.isFinite(v) && v >= 0);
  if (valid.length === 0) {
    return {
      totalRequests: 0,
      rps: 0,
      min: 0,
      max: 0,
      mean: 0,
      percentiles: {},
    };
  }
  let sum = 0;
  let min = valid[0];
  let max = valid[0];
  for (let i = 0; i < valid.length; i++) {
    const v = valid[i];
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const mean = Number((sum / valid.length).toFixed(2));
  const rps = calculateRps(valid.length, durationMs);
  const percentiles = computePercentiles(valid);
  return {
    totalRequests: valid.length,
    rps,
    min,
    max,
    mean,
    percentiles,
  };
};

const sanitizeRedisKey = (key, defaultKey = "codes:seq") => {
  if (typeof key !== "string" || !key.trim()) return defaultKey;
  const clean = key
    .replace(/[\r\n\x00-\x1f\x7f]/g, "")
    .trim()
    .replace(/\s+/g, ":");
  if (!clean) return defaultKey;
  return clean.substring(0, 256);
};

const DEFAULT_HISTOGRAM_BUCKETS = Object.freeze([1, 5, 10, 25, 50, 100, 250, 500, 1000]);

const buildLatencyHistogram = (latencies, customBuckets) => {
  if (!Array.isArray(latencies) || latencies.length === 0) {
    return {
      total: 0,
      buckets: {},
      overflow: 0,
    };
  }
  const valid = latencies.filter((v) => typeof v === "number" && Number.isFinite(v) && v >= 0);
  if (valid.length === 0) {
    return {
      total: 0,
      buckets: {},
      overflow: 0,
    };
  }

  let buckets = DEFAULT_HISTOGRAM_BUCKETS;
  if (Array.isArray(customBuckets) && customBuckets.length > 0) {
    const candidate = customBuckets.filter((b) => typeof b === "number" && Number.isFinite(b) && b > 0);
    if (candidate.length > 0) {
      buckets = Array.from(new Set(candidate)).sort((a, b) => a - b);
    }
  }

  const counts = {};
  for (const b of buckets) {
    counts[`le_${b}`] = 0;
  }
  let overflow = 0;

  for (const lat of valid) {
    let matched = false;
    for (const b of buckets) {
      if (lat <= b) {
        counts[`le_${b}`]++;
        matched = true;
      }
    }
    if (!matched) {
      overflow++;
    }
  }

  return {
    total: valid.length,
    buckets: counts,
    overflow,
  };
};

const computeJitter = (latencies) => {
  if (!Array.isArray(latencies) || latencies.length === 0) {
    return {
      count: 0,
      meanJitter: 0,
      maxJitter: 0,
      variance: 0,
      stdDev: 0,
    };
  }
  const valid = latencies.filter((v) => typeof v === "number" && Number.isFinite(v) && v >= 0);
  if (valid.length <= 1) {
    return {
      count: valid.length,
      meanJitter: 0,
      maxJitter: 0,
      variance: 0,
      stdDev: 0,
    };
  }

  let totalDiff = 0;
  let maxDiff = 0;
  let sum = valid[0];

  for (let i = 1; i < valid.length; i++) {
    const diff = Math.abs(valid[i] - valid[i - 1]);
    totalDiff += diff;
    if (diff > maxDiff) maxDiff = diff;
    sum += valid[i];
  }

  const meanJitter = Number((totalDiff / (valid.length - 1)).toFixed(2));
  const maxJitter = Number(maxDiff.toFixed(2));
  const mean = sum / valid.length;

  let sumSquares = 0;
  for (let i = 0; i < valid.length; i++) {
    const delta = valid[i] - mean;
    sumSquares += delta * delta;
  }
  const variance = Number((sumSquares / valid.length).toFixed(2));
  const stdDev = Number(Math.sqrt(variance).toFixed(2));

  return {
    count: valid.length,
    meanJitter,
    maxJitter,
    variance,
    stdDev,
  };
};

let cachedMaxId = 0;
let lastCacheUpdate = 0;
let defaultRedisClient = null;
let inFlightFetch = null;

async function getDefaultRedis() {
  if (!defaultRedisClient) {
    try {
      const mod = await import("./database/redis.js");
      defaultRedisClient = mod.redis;
    } catch {
      // redis module or connection not available
    }
  }
  return defaultRedisClient;
}

// Helper to get max ID with caching and singleflight coalescing to prevent
// stampedes and avoid advancing the cache timestamp on failed lookups.
async function getMaxId(client, ttlMs = 500) {
  const now = Date.now();
  const effectiveTtl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 0;

  if (
    effectiveTtl > 0 &&
    lastCacheUpdate > 0 &&
    now >= lastCacheUpdate &&
    now - lastCacheUpdate < effectiveTtl
  ) {
    return cachedMaxId;
  }

  if (inFlightFetch) {
    return inFlightFetch;
  }

  inFlightFetch = (async () => {
    try {
      const redisClient = client !== undefined ? client : await getDefaultRedis();
      if (redisClient && typeof redisClient.get === "function") {
        const maxIdStr = await redisClient.get("codes:seq");
        if (typeof maxIdStr === "string" || typeof maxIdStr === "number") {
          const clean = String(maxIdStr).trim();
          if (/^\d+$/.test(clean)) {
            const parsed = Number.parseInt(clean, 10);
            if (Number.isSafeInteger(parsed)) {
              cachedMaxId = parsed;
              lastCacheUpdate = Date.now();
            }
          }
        }
      }
    } catch {
      // Fall back to last known cachedMaxId on transient redis error
    } finally {
      inFlightFetch = null;
    }
    return cachedMaxId;
  })();

  return inFlightFetch;
}

function resetCacheForTesting() {
  cachedMaxId = 0;
  lastCacheUpdate = 0;
  inFlightFetch = null;
}

const calculateAmdahlSpeedup = (concurrency = 1, parallelPortion = 0.95) => {
  const s = typeof concurrency === "number" && Number.isFinite(concurrency) && concurrency > 0
    ? concurrency
    : 1;
  const p = typeof parallelPortion === "number" && Number.isFinite(parallelPortion)
    ? Math.max(0, Math.min(1, parallelPortion))
    : 0.95;
  const speedup = 1 / ((1 - p) + (p / s));
  const efficiency = speedup / s;
  return {
    concurrency: s,
    parallelPortion: p,
    speedup: Number(speedup.toFixed(4)),
    efficiency: Number(efficiency.toFixed(4)),
  };
};

const computeMovingAverage = (values, windowSize = 5) => {
  if (!Array.isArray(values) || values.length === 0) return [];
  const valid = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  const w = Number.isSafeInteger(windowSize) && windowSize > 0 ? Math.min(windowSize, valid.length) : 1;
  if (valid.length === 0) return [];
  const result = [];
  for (let i = 0; i <= valid.length - w; i++) {
    const sum = valid.slice(i, i + w).reduce((acc, curr) => acc + curr, 0);
    result.push(Number((sum / w).toFixed(2)));
  }
  return result;
};

const computeEMA = (values, alpha = 0.3) => {
  if (!Array.isArray(values) || values.length === 0) return [];
  const valid = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (valid.length === 0) return [];
  const a = typeof alpha === "number" && Number.isFinite(alpha) && alpha > 0 && alpha <= 1 ? alpha : 0.3;
  let ema = valid[0];
  const result = [Number(ema.toFixed(2))];
  for (let i = 1; i < valid.length; i++) {
    ema = a * valid[i] + (1 - a) * ema;
    result.push(Number(ema.toFixed(2)));
  }
  return result;
};


const generateBackoffSchedule = (opts = {}) => {
  const o = opts && typeof opts === "object" ? opts : {};
  const base = Number.isFinite(o.baseMs) && o.baseMs > 0 ? o.baseMs : 100;
  const max = Number.isFinite(o.maxMs) && o.maxMs >= base ? o.maxMs : 5000;
  const f = Number.isFinite(o.factor) && o.factor >= 1 ? o.factor : 2;
  const retries = Number.isSafeInteger(o.maxRetries) && o.maxRetries > 0 ? Math.min(o.maxRetries, 20) : 5;
  const schedule = [];
  for (let attempt = 0; attempt < retries; attempt++) {
    const calculated = Math.min(max, base * Math.pow(f, attempt));
    const delay = o.jitter === "full" ? Math.floor(Math.random() * calculated) : calculated;
    schedule.push(delay);
  }
  return { baseMs: base, maxMs: max, retries, schedule };
};

const validatePayloadSize = (contentLength, maxSizeBytes = 1048576) => {
  const max = Number.isSafeInteger(maxSizeBytes) && maxSizeBytes > 0 ? maxSizeBytes : 1048576;
  const len = typeof contentLength === "number" ? contentLength : Number.parseInt(String(contentLength).trim(), 10);
  if (!Number.isFinite(len) || len < 0) {
    return { valid: false, bytes: 0, maxBytes: max, error: "INVALID_LENGTH" };
  }
  if (len > max) {
    return { valid: false, bytes: len, maxBytes: max, error: "PAYLOAD_TOO_LARGE" };
  }
  return { valid: true, bytes: len, maxBytes: max, error: null };
};

const evaluateSloCompliance = (latencies, opts = {}) => {
  const o = opts && typeof opts === "object" ? opts : {};
  const targetP95Ms = o.targetP95Ms ?? 50;
  const targetP99Ms = o.targetP99Ms ?? 100;
  if (!Array.isArray(latencies) || latencies.length === 0) {
    return { compliant: false, total: 0, p95: 0, p99: 0, violations: [] };
  }
  const percentiles = computePercentiles(latencies, [95, 99]);
  const p95 = percentiles.p95 ?? 0;
  const p99 = percentiles.p99 ?? 0;
  const violations = [];
  if (p95 > targetP95Ms) violations.push("p95 exceeded: " + p95 + "ms > " + targetP95Ms + "ms");
  if (p99 > targetP99Ms) violations.push("p99 exceeded: " + p99 + "ms > " + targetP99Ms + "ms");
  return {
    compliant: violations.length === 0,
    total: latencies.length,
    p95,
    p99,
    violations,
  };
};
export {
  generateCode,
  generateBatchCodes,
  parsePositiveInteger,
  formatBytes,
  computePercentiles,
  parseDurationMs,
  calculateRps,
  computeThroughputStats,
  sanitizeRedisKey,
  DEFAULT_HISTOGRAM_BUCKETS,
  buildLatencyHistogram,
  computeJitter,
  calculateAmdahlSpeedup,
  computeMovingAverage,
  computeEMA,
  generateBackoffSchedule,
  validatePayloadSize,
  evaluateSloCompliance,
  getMaxId,
  resetCacheForTesting,
};
