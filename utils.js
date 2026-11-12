import crypto from "crypto";

const generateCode = () => {
  // 375 random bytes becomes 500 Base64 characters
  return crypto.randomBytes(375).toString("base64").substring(0, 500);
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

export { generateCode, getMaxId, resetCacheForTesting };
