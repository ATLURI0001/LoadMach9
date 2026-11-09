import crypto from "crypto";

const generateCode = () => {
  // 375 random bytes becomes 500 Base64 characters
  return crypto.randomBytes(375).toString("base64").substring(0, 500);
};

let cachedMaxId = 0;
let lastCacheUpdate = 0;
let defaultRedisClient = null;

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

// Helper to get max ID with caching to improve performance and save Redis calls.
// Only used in /code-fast GET endpoint.
async function getMaxId(client, ttlMs = 500) {
  const now = Date.now();
  // Refresh only if cache is older than ttlMs
  if (now - lastCacheUpdate > ttlMs) {
    lastCacheUpdate = now;
    const redisClient = client !== undefined ? client : await getDefaultRedis();
    if (redisClient && typeof redisClient.get === "function") {
      try {
        const maxIdStr = await redisClient.get("codes:seq");
        if (maxIdStr) {
          const parsed = parseInt(maxIdStr, 10);
          if (!isNaN(parsed)) {
            cachedMaxId = parsed;
          }
        }
      } catch {
        // Fall back to last known cachedMaxId on transient redis error
      }
    }
  }
  return cachedMaxId;
}

function resetCacheForTesting() {
  cachedMaxId = 0;
  lastCacheUpdate = 0;
}

export { generateCode, getMaxId, resetCacheForTesting };
