import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {
  safeDecompressBuffer,
  createSafeDecompressionStream,
  DecompressionSecurityError,
} from '../decompression_guard.js';

describe('DecompressionGuard Suite', () => {
  it('decompresses nominal gzip payload cleanly', async () => {
    const rawText = 'Hello World from LoadMach9 Distributed Load Test Worker!'.repeat(10);
    const compressed = zlib.gzipSync(Buffer.from(rawText));

    const result = await safeDecompressBuffer(compressed, 'gzip');
    assert.equal(result.toString('utf-8'), rawText);
  });

  it('decompresses nominal deflate payload cleanly', async () => {
    const rawText = 'Deflate payload for micro-benchmarking load scenario.'.repeat(5);
    const compressed = zlib.deflateSync(Buffer.from(rawText));

    const result = await safeDecompressBuffer(compressed, 'deflate');
    assert.equal(result.toString('utf-8'), rawText);
  });

  it('passes through identity encoding without modification', async () => {
    const rawBuffer = Buffer.from('Plain uncompressed bytes.');
    const result = await safeDecompressBuffer(rawBuffer, 'identity');
    assert.equal(result.toString('utf-8'), 'Plain uncompressed bytes.');
  });

  it('rejects unsupported encodings', async () => {
    await assert.rejects(
      async () => safeDecompressBuffer(Buffer.from('data'), 'lz4'),
      (err) => err instanceof DecompressionSecurityError && err.code === 'ERR_UNSUPPORTED_ENCODING'
    );
  });

  it('rejects non-buffer input', async () => {
    await assert.rejects(
      async () => safeDecompressBuffer('not a buffer', 'gzip'),
      (err) => err instanceof DecompressionSecurityError && err.code === 'ERR_INVALID_BUFFER'
    );
  });

  it('intercepts compressed payload exceeding maxCompressedBytes', async () => {
    const raw = Buffer.alloc(5000, 0x41);
    const compressed = zlib.gzipSync(raw); // ~41 bytes

    await assert.rejects(
      async () => safeDecompressBuffer(compressed, 'gzip', { maxCompressedBytes: 20 }),
      (err) => err.code === 'ERR_COMPRESSED_PAYLOAD_TOO_LARGE'
    );
  });

  it('intercepts decompression bomb exceeding uncompressed ceiling', async () => {
    // 50KB of zeros compresses to ~60 bytes in gzip
    const zeros = Buffer.alloc(50 * 1024, 0);
    const bomb = zlib.gzipSync(zeros);

    await assert.rejects(
      async () => safeDecompressBuffer(bomb, 'gzip', {
        maxUncompressedBytes: 10 * 1024, // 10KB limit
        maxExpansionRatio: 2000.0,       // ratio high so ceiling trips first
      }),
      (err) => err.code === 'ERR_DECOMPRESSION_BOMB_CEILING'
    );
  });

  it('intercepts decompression bomb exceeding expansion ratio', async () => {
    // 20KB of repetitive zeros compresses to ~40 bytes (ratio > 400:1)
    const repetitive = Buffer.alloc(20 * 1024, 0x42);
    const bomb = zlib.gzipSync(repetitive);

    await assert.rejects(
      async () => safeDecompressBuffer(bomb, 'gzip', {
        maxUncompressedBytes: 100 * 1024,
        maxExpansionRatio: 50.0, // max 50:1 ratio
        minBytesForRatioCheck: 500,
      }),
      (err) => err.code === 'ERR_DECOMPRESSION_BOMB_RATIO'
    );
  });

  it('tracks compression and expansion stats in stream', () => {
    const stream = createSafeDecompressionStream('gzip');
    const stats = stream.getStats();
    assert.equal(stats.compressedBytes, 0);
    assert.equal(stats.uncompressedBytes, 0);
  });
});
