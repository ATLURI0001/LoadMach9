import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { generateCode, getMaxId, resetCacheForTesting } from "../utils.js";

describe("LoadMach9 Utility & Performance Harness", () => {
  beforeEach(() => {
    resetCacheForTesting();
  });

  describe("generateCode", () => {
    it("should generate a string of exactly 500 characters", () => {
      const code = generateCode();
      assert.equal(typeof code, "string");
      assert.equal(code.length, 500);
    });

    it("should only contain valid base64 character set", () => {
      const code = generateCode();
      const base64Regex = /^[A-Za-z0-9+/=]+$/;
      assert.ok(base64Regex.test(code), "Generated code must match base64 character set");
    });

    it("should produce cryptographically distinct codes across invocations", () => {
      const sampleSize = 100;
      const seen = new Set();
      for (let i = 0; i < sampleSize; i++) {
        seen.add(generateCode());
      }
      assert.equal(seen.size, sampleSize, "All generated codes must be unique");
    });

    it("should sustain high-throughput generation without bottlenecks", () => {
      const start = performance.now();
      const iterations = 500;
      for (let i = 0; i < iterations; i++) {
        generateCode();
      }
      const durationMs = performance.now() - start;
      assert.ok(durationMs < 500, `Generating ${iterations} codes took ${durationMs.toFixed(2)}ms, expected < 500ms`);
    });

    it("should support custom lengths when specified and fallback safely on invalid input", () => {
      assert.equal(generateCode(100).length, 100);
      assert.equal(generateCode(64).length, 64);
      assert.equal(generateCode(1).length, 1);

      // Non-positive or non-integer inputs safely default to 500
      assert.equal(generateCode(0).length, 500);
      assert.equal(generateCode(-50).length, 500);
      assert.equal(generateCode(NaN).length, 500);
      assert.equal(generateCode(null).length, 500);
      assert.equal(generateCode("not a number").length, 500);
    });
  });

  describe("getMaxId cache behavior", () => {
    it("should return 0 when mock redis returns null and cache is empty", async () => {
      const mockRedis = {
        get: async () => null,
      };
      const result = await getMaxId(mockRedis, 500);
      assert.equal(result, 0);
    });

    it("should fetch from mock redis and cache the parsed integer value", async () => {
      let callCount = 0;
      const mockRedis = {
        get: async (key) => {
          assert.equal(key, "codes:seq");
          callCount++;
          return "4294967295";
        },
      };

      const first = await getMaxId(mockRedis, 500);
      assert.equal(first, 4294967295);
      assert.equal(callCount, 1);

      // Subsequent call within TTL must return cached value without hitting Redis
      const second = await getMaxId(mockRedis, 500);
      assert.equal(second, 4294967295);
      assert.equal(callCount, 1);
    });

    it("should refresh cache when TTL expires", async () => {
      let value = "100";
      let callCount = 0;
      const mockRedis = {
        get: async () => {
          callCount++;
          return value;
        },
      };

      // Call with 10ms TTL
      const first = await getMaxId(mockRedis, 10);
      assert.equal(first, 100);
      assert.equal(callCount, 1);

      // Sleep 25ms to expire TTL
      await new Promise((resolve) => setTimeout(resolve, 25));

      value = "200";
      const second = await getMaxId(mockRedis, 10);
      assert.equal(second, 200);
      assert.equal(callCount, 2);
    });

    it("should gracefully survive transient redis exceptions and retain cached value", async () => {
      let callCount = 0;
      const mockRedis = {
        get: async () => {
          callCount++;
          if (callCount === 1) {
            return "777";
          }
          throw new Error("ECONNREFUSED: Redis instance offline");
        },
      };

      const first = await getMaxId(mockRedis, 10);
      assert.equal(first, 777);

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 25));

      // Second call fails at redis layer, but should catch and return last known cachedMaxId
      const second = await getMaxId(mockRedis, 10);
      assert.equal(second, 777);
      assert.equal(callCount, 2);
    });

    it("should ignore non-numeric string values from redis without corrupting cache", async () => {
      const mockRedis = {
        get: async () => "invalid_non_numeric_token",
      };
      const result = await getMaxId(mockRedis, 500);
      assert.equal(result, 0);

      // Partial numeric prefix strings (parseInt trap) and negatives must also be rejected
      const partialMock = { get: async () => "42_evil" };
      assert.equal(await getMaxId(partialMock, 500), 0);
      const negMock = { get: async () => "-10" };
      assert.equal(await getMaxId(negMock, 500), 0);
    });

    it("should coalesce concurrent cache-miss fetches into one redis call", async () => {
      let calls = 0;
      const slowRedis = {
        get: async () => {
          calls++;
          await new Promise((r) => setTimeout(r, 20));
          return "999";
        },
      };

      const results = await Promise.all([
        getMaxId(slowRedis, 500),
        getMaxId(slowRedis, 500),
        getMaxId(slowRedis, 500),
      ]);
      assert.deepEqual(results, [999, 999, 999]);
      assert.equal(calls, 1);
    });

    it("should retry immediately after a transient failure rather than locking stale TTL", async () => {
      let attempts = 0;
      const flakyRedis = {
        get: async () => {
          attempts++;
          if (attempts === 1) throw new Error("timeout");
          return "123";
        },
      };

      assert.equal(await getMaxId(flakyRedis, 5000), 0);
      // Even within 5000ms TTL, second call should recover immediately instead of caching failure
      assert.equal(await getMaxId(flakyRedis, 5000), 123);
      assert.equal(attempts, 2);
    });

    it("should bypass cache immediately when ttlMs is 0 even in same millisecond", async () => {
      let seq = 10;
      let calls = 0;
      const client = {
        get: async () => {
          calls++;
          return String(seq);
        },
      };

      assert.equal(await getMaxId(client, 500), 10);
      seq = 20;
      assert.equal(await getMaxId(client, 0), 20);
      assert.equal(calls, 2);
    });

    it("should refresh cache if system clock moves backward relative to lastCacheUpdate", async () => {
      let calls = 0;
      const realNow = Date.now;
      let fakeNow = 10_000;
      Date.now = () => fakeNow;
      try {
        const client = {
          get: async () => {
            calls++;
            return String(calls * 50);
          },
        };
        assert.equal(await getMaxId(client, 500), 50);
        fakeNow = 9_000; // clock jumped backward 1s
        assert.equal(await getMaxId(client, 500), 100);
        assert.equal(calls, 2);
      } finally {
        Date.now = realNow;
      }
    });
  });
});
