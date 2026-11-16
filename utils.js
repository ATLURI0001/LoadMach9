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
  getMaxId,
  resetCacheForTesting,
};
