/**
 * Benchmark Scenario Specification Contract & Ingress Sanitizer
 *
 * Enforces strict RFC-compliant HTTP method validation, CRLF injection defense,
 * duration parsing with lower/upper bounding, connection concurrency guardrails,
 * and SLA threshold specification verification.
 */

const ALLOWED_HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);
const MIN_DURATION_MS = 100; // 100 milliseconds
const MAX_DURATION_MS = 86_400_000; // 24 hours
const MAX_CONCURRENT_CONNECTIONS = 50_000;
const MAX_PIPELINING = 100;
const MAX_WORKERS = 64;
const MAX_HEADERS_COUNT = 100;
const MAX_HEADER_LENGTH = 8_192; // 8 KB
const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

// RFC 7230 token validation regex for header field names
const HEADER_FIELD_NAME_REGEX = /^[a-zA-Z0-9!#$%&'*+\-.^_`|~]+$/;

/**
 * Parses duration expression (e.g. "500ms", "10s", "5m", "1h") or raw milliseconds into bounded integer ms.
 *
 * @param {string|number} input
 * @returns {{ valid: boolean, durationMs?: number, error?: string }}
 */
export function parseAndValidateDuration(input) {
  if (input === undefined || input === null) {
    return { valid: false, error: 'Duration is required' };
  }

  let ms;
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input <= 0) {
      return { valid: false, error: 'Numeric duration must be positive and finite' };
    }
    ms = Math.floor(input);
  } else if (typeof input === 'string') {
    const trimmed = input.trim().toLowerCase();
    const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/);
    if (!match) {
      return { valid: false, error: `Invalid duration string format: "${input}"` };
    }

    const val = parseFloat(match[1]);
    const unit = match[2] || 's';

    switch (unit) {
      case 'ms':
        ms = Math.floor(val);
        break;
      case 's':
        ms = Math.floor(val * 1000);
        break;
      case 'm':
        ms = Math.floor(val * 60_000);
        break;
      case 'h':
        ms = Math.floor(val * 3_600_000);
        break;
      default:
        return { valid: false, error: `Unsupported duration unit: ${unit}` };
    }
  } else {
    return { valid: false, error: 'Duration must be a number or string expression' };
  }

  if (ms < MIN_DURATION_MS) {
    return { valid: false, error: `Duration (${ms}ms) is below minimum allowed (${MIN_DURATION_MS}ms)` };
  }
  if (ms > MAX_DURATION_MS) {
    return { valid: false, error: `Duration (${ms}ms) exceeds maximum allowed (${MAX_DURATION_MS}ms)` };
  }

  return { valid: true, durationMs: ms };
}

/**
 * Validates and normalizes target URL against protocol injection and invalid ports.
 *
 * @param {string} rawUrl
 * @returns {{ valid: boolean, sanitizedUrl?: string, error?: string }}
 */
export function validateTargetUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { valid: false, error: 'Target URL is required and must be a non-empty string' };
  }

  const trimmed = rawUrl.trim();
  if (/[\r\n\0]/.test(trimmed)) {
    return { valid: false, error: 'Target URL contains prohibited control characters or CRLF sequences' };
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (err) {
    return { valid: false, error: `Malformed URL: ${err.message}` };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, error: `Unsupported protocol "${parsed.protocol}": only http: and https: are allowed` };
  }

  if (!parsed.hostname || parsed.hostname.length === 0) {
    return { valid: false, error: 'Target URL hostname is missing or empty' };
  }

  if (parsed.port) {
    const portNum = parseInt(parsed.port, 10);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      return { valid: false, error: `Target URL port ${parsed.port} is outside valid port range [1, 65535]` };
    }
  }

  return { valid: true, sanitizedUrl: parsed.toString() };
}

/**
 * Sanitizes HTTP header dictionary, defending against CRLF injection and malformed field names.
 *
 * @param {Record<string, string|number>} headers
 * @returns {{ valid: boolean, sanitizedHeaders?: Record<string, string>, errors?: string[] }}
 */
export function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    return { valid: true, sanitizedHeaders: {} };
  }

  const sanitized = {};
  const errors = [];
  const entries = Object.entries(headers);

  if (entries.length > MAX_HEADERS_COUNT) {
    return {
      valid: false,
      errors: [`Header count (${entries.length}) exceeds maximum allowable (${MAX_HEADERS_COUNT})`]
    };
  }

  for (const [key, val] of entries) {
    const trimmedKey = String(key).trim();
    if (!HEADER_FIELD_NAME_REGEX.test(trimmedKey)) {
      errors.push(`Invalid header field name: "${key}" contains prohibited characters`);
      continue;
    }

    const valStr = String(val);
    if (/[\r\n\0]/.test(valStr)) {
      errors.push(`Header "${key}" value contains prohibited control or CRLF injection characters`);
      continue;
    }

    if (trimmedKey.length + valStr.length > MAX_HEADER_LENGTH) {
      errors.push(`Header "${key}" exceeds size boundary (${MAX_HEADER_LENGTH} bytes)`);
      continue;
    }

    sanitized[trimmedKey.toLowerCase()] = valStr.trim();
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, sanitizedHeaders: sanitized };
}

/**
 * Validates and sanitizes Service Level Objective (SLO) thresholds.
 *
 * @param {object} thresholds
 * @returns {{ valid: boolean, sanitizedThresholds?: object, errors?: string[] }}
 */
export function validateSloThresholds(thresholds) {
  if (!thresholds || typeof thresholds !== 'object' || Array.isArray(thresholds)) {
    return { valid: true, sanitizedThresholds: {} };
  }

  const sanitized = {};
  const errors = [];

  if (thresholds.maxP99LatencyMs !== undefined) {
    const val = Number(thresholds.maxP99LatencyMs);
    if (!Number.isFinite(val) || val <= 0) {
      errors.push('maxP99LatencyMs must be a positive finite number');
    } else {
      sanitized.maxP99LatencyMs = val;
    }
  }

  if (thresholds.maxP95LatencyMs !== undefined) {
    const val = Number(thresholds.maxP95LatencyMs);
    if (!Number.isFinite(val) || val <= 0) {
      errors.push('maxP95LatencyMs must be a positive finite number');
    } else {
      sanitized.maxP95LatencyMs = val;
    }
  }

  if (thresholds.maxErrorRatePct !== undefined) {
    const val = Number(thresholds.maxErrorRatePct);
    if (!Number.isFinite(val) || val < 0 || val > 100) {
      errors.push('maxErrorRatePct must be a number between 0 and 100');
    } else {
      sanitized.maxErrorRatePct = val;
    }
  }

  if (thresholds.minRps !== undefined) {
    const val = Number(thresholds.minRps);
    if (!Number.isFinite(val) || val <= 0) {
      errors.push('minRps must be a positive finite number');
    } else {
      sanitized.minRps = val;
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, sanitizedThresholds: sanitized };
}

/**
 * Comprehensive Benchmark Scenario Ingress Validator & Sanitizer.
 *
 * @param {object} spec
 * @returns {{ valid: boolean, sanitizedSpec?: object, errors: string[] }}
 */
export function validateScenarioSpec(spec) {
  const errors = [];
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return { valid: false, errors: ['Scenario spec must be a non-null object'] };
  }

  // 1. Target URL
  const urlRes = validateTargetUrl(spec.url);
  if (!urlRes.valid) {
    errors.push(urlRes.error);
  }

  // 2. HTTP Method
  let method = 'GET';
  if (spec.method !== undefined) {
    if (typeof spec.method !== 'string') {
      errors.push('HTTP method must be a string');
    } else {
      const upper = spec.method.trim().toUpperCase();
      if (!ALLOWED_HTTP_METHODS.has(upper)) {
        errors.push(`Unsupported HTTP method "${spec.method}": must be one of ${Array.from(ALLOWED_HTTP_METHODS).join(', ')}`);
      } else {
        method = upper;
      }
    }
  }

  // 3. Duration
  const durationRes = parseAndValidateDuration(spec.duration !== undefined ? spec.duration : '10s');
  if (!durationRes.valid) {
    errors.push(durationRes.error);
  }

  // 4. Concurrency / Connections
  let connections = 10;
  if (spec.connections !== undefined) {
    const num = Number(spec.connections);
    if (!Number.isInteger(num) || num < 1 || num > MAX_CONCURRENT_CONNECTIONS) {
      errors.push(`Connections (${spec.connections}) must be an integer between 1 and ${MAX_CONCURRENT_CONNECTIONS}`);
    } else {
      connections = num;
    }
  }

  // 5. Pipelining
  let pipelining = 1;
  if (spec.pipelining !== undefined) {
    const num = Number(spec.pipelining);
    if (!Number.isInteger(num) || num < 1 || num > MAX_PIPELINING) {
      errors.push(`Pipelining factor (${spec.pipelining}) must be an integer between 1 and ${MAX_PIPELINING}`);
    } else {
      pipelining = num;
    }
  }

  // 6. Workers
  let workers = 1;
  if (spec.workers !== undefined) {
    const num = Number(spec.workers);
    if (!Number.isInteger(num) || num < 1 || num > MAX_WORKERS) {
      errors.push(`Workers (${spec.workers}) must be an integer between 1 and ${MAX_WORKERS}`);
    } else {
      workers = num;
    }
  }

  // 7. Headers
  let headers = {};
  if (spec.headers !== undefined) {
    const headerRes = sanitizeHeaders(spec.headers);
    if (!headerRes.valid) {
      errors.push(...headerRes.errors);
    } else {
      headers = headerRes.sanitizedHeaders;
    }
  }

  // 8. Body
  let body = undefined;
  if (spec.body !== undefined) {
    if (typeof spec.body === 'string') {
      const byteLen = Buffer.byteLength(spec.body, 'utf8');
      if (byteLen > MAX_BODY_BYTES) {
        errors.push(`Body payload size (${byteLen} bytes) exceeds limit (${MAX_BODY_BYTES} bytes)`);
      } else {
        body = spec.body;
      }
    } else if (typeof spec.body === 'object' && spec.body !== null) {
      try {
        const jsonStr = JSON.stringify(spec.body);
        const byteLen = Buffer.byteLength(jsonStr, 'utf8');
        if (byteLen > MAX_BODY_BYTES) {
          errors.push(`Serialized JSON body size (${byteLen} bytes) exceeds limit (${MAX_BODY_BYTES} bytes)`);
        } else {
          body = jsonStr;
          if (!headers['content-type']) {
            headers['content-type'] = 'application/json';
          }
        }
      } catch (err) {
        errors.push(`Failed serializing body object to JSON: ${err.message}`);
      }
    } else {
      errors.push('Body must be a string or JSON object');
    }
  }

  // 9. Thresholds
  let thresholds = {};
  if (spec.thresholds !== undefined) {
    const threshRes = validateSloThresholds(spec.thresholds);
    if (!threshRes.valid) {
      errors.push(...threshRes.errors);
    } else {
      thresholds = threshRes.sanitizedThresholds;
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    errors: [],
    sanitizedSpec: {
      url: urlRes.sanitizedUrl,
      method,
      durationMs: durationRes.durationMs,
      connections,
      pipelining,
      workers,
      headers,
      body,
      thresholds
    }
  };
}
