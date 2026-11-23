/**
 * LoadMach9 Ingress HTTP Payload Decompression Bomb & Memory Exhaustion Defense Guard
 * 
 * Protects load-testing workers and mock ingest servers against zip bombs,
 * pathological expansion ratios, and memory exhaustion from gzip, deflate, and brotli streams.
 */

import zlib from 'node:zlib';
import { Transform } from 'node:stream';

export class DecompressionSecurityError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'DecompressionSecurityError';
    this.code = code;
    this.details = details;
  }
}

export const SUPPORTED_ENCODINGS = new Set(['gzip', 'deflate', 'br', 'identity']);

export const DEFAULT_DECOMPRESSION_OPTIONS = Object.freeze({
  maxCompressedBytes: 10 * 1024 * 1024,      // 10 MB compressed
  maxUncompressedBytes: 50 * 1024 * 1024,    // 50 MB uncompressed limit
  maxExpansionRatio: 100.0,                   // 100:1 max ratio
  minBytesForRatioCheck: 1024,               // only check ratio after 1KB decompressed
  timeoutMs: 10_000,                          // 10s execution deadline
});

/**
 * Creates a stream-level metering and boundary-enforcing Transform stream.
 */
export function createSafeDecompressionStream(encoding, customOptions = {}) {
  const options = { ...DEFAULT_DECOMPRESSION_OPTIONS, ...customOptions };
  const enc = (encoding || 'identity').toLowerCase().trim();

  if (!SUPPORTED_ENCODINGS.has(enc)) {
    throw new DecompressionSecurityError(
      `Unsupported content-encoding: '${encoding}'. Supported: ${Array.from(SUPPORTED_ENCODINGS).join(', ')}`,
      'ERR_UNSUPPORTED_ENCODING',
      { encoding }
    );
  }

  let compressedBytes = 0;
  let uncompressedBytes = 0;

  // Metering input stream
  const inputMeter = new Transform({
    transform(chunk, _encoding, callback) {
      compressedBytes += chunk.length;
      if (compressedBytes > options.maxCompressedBytes) {
        return callback(
          new DecompressionSecurityError(
            `Compressed payload exceeds limit of ${options.maxCompressedBytes} bytes`,
            'ERR_COMPRESSED_PAYLOAD_TOO_LARGE',
            { compressedBytes, maxCompressedBytes: options.maxCompressedBytes }
          )
        );
      }
      callback(null, chunk);
    },
  });

  // Native decompressor
  let decompressor;
  if (enc === 'gzip') {
    decompressor = zlib.createGunzip();
  } else if (enc === 'deflate') {
    decompressor = zlib.createInflate();
  } else if (enc === 'br') {
    decompressor = zlib.createBrotliDecompress();
  } else {
    decompressor = new Transform({
      transform(chunk, _encoding, cb) {
        cb(null, chunk);
      },
    });
  }

  // Metering output guard stream
  const outputGuard = new Transform({
    transform(chunk, _encoding, callback) {
      uncompressedBytes += chunk.length;

      // 1. Total uncompressed ceiling
      if (uncompressedBytes > options.maxUncompressedBytes) {
        return callback(
          new DecompressionSecurityError(
            `Decompressed payload size (${uncompressedBytes} bytes) exceeded maximum ceiling of ${options.maxUncompressedBytes} bytes`,
            'ERR_DECOMPRESSION_BOMB_CEILING',
            { uncompressedBytes, maxUncompressedBytes: options.maxUncompressedBytes }
          )
        );
      }

      // 2. Expansion ratio check (only after minimum byte threshold)
      if (uncompressedBytes > options.minBytesForRatioCheck && compressedBytes > 0) {
        const ratio = uncompressedBytes / compressedBytes;
        if (ratio > options.maxExpansionRatio) {
          return callback(
            new DecompressionSecurityError(
              `Decompression expansion ratio (${ratio.toFixed(1)}:1) exceeds maximum threshold of ${options.maxExpansionRatio}:1`,
              'ERR_DECOMPRESSION_BOMB_RATIO',
              { ratio, uncompressedBytes, compressedBytes, maxExpansionRatio: options.maxExpansionRatio }
            )
          );
        }
      }

      callback(null, chunk);
    },
  });

  // Pipeline links
  inputMeter.pipe(decompressor).pipe(outputGuard);

  // Return composite stream
  return {
    input: inputMeter,
    output: outputGuard,
    getStats: () => ({
      compressedBytes,
      uncompressedBytes,
      expansionRatio: compressedBytes > 0 ? uncompressedBytes / compressedBytes : 0,
    }),
  };
}

/**
 * Safely decompresses a static in-memory Buffer with expansion bounds and ratio checking.
 */
export async function safeDecompressBuffer(buffer, encoding = 'gzip', customOptions = {}) {
  const options = { ...DEFAULT_DECOMPRESSION_OPTIONS, ...customOptions };
  const enc = (encoding || 'identity').toLowerCase().trim();

  if (!Buffer.isBuffer(buffer)) {
    throw new DecompressionSecurityError('Input must be a valid Buffer', 'ERR_INVALID_BUFFER');
  }

  if (buffer.length > options.maxCompressedBytes) {
    throw new DecompressionSecurityError(
      `Compressed buffer size (${buffer.length} bytes) exceeds limit (${options.maxCompressedBytes} bytes)`,
      'ERR_COMPRESSED_PAYLOAD_TOO_LARGE',
      { compressedBytes: buffer.length }
    );
  }

  if (enc === 'identity' || !enc) {
    return buffer;
  }

  return new Promise((resolve, reject) => {
    let uncompressedBytes = 0;
    const chunks = [];

    const streamBundle = createSafeDecompressionStream(enc, options);

    streamBundle.output.on('data', (chunk) => {
      chunks.push(chunk);
      uncompressedBytes += chunk.length;
    });

    streamBundle.output.on('end', () => {
      resolve(Buffer.concat(chunks, uncompressedBytes));
    });

    const errorHandler = (err) => {
      reject(err);
    };

    streamBundle.input.on('error', errorHandler);
    streamBundle.output.on('error', errorHandler);

    streamBundle.input.end(buffer);
  });
}
