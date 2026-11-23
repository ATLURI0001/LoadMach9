/**
 * @file load_test_plan_contract.js
 * Ingress contract validation and defensive parameter normalization for distributed load test plans.
 */

export class LoadTestPlanContractError extends Error {
  constructor(code, message) {
    super(`[${code}] ${message}`);
    this.name = 'LoadTestPlanContractError';
    this.code = code;
  }
}

const SUPPORTED_VERSIONS = new Set(['loadmach9/v1', 'loadmach9/v2']);
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const PLAN_ID_REGEX = /^[a-zA-Z0-9_\-\.]{3,64}$/;
const THRESHOLD_METRICS = new Set(['p50', 'p90', 'p95', 'p99', 'p999', 'error_rate', 'min_rps', 'mean_latency']);
const THRESHOLD_OPERATORS = new Set(['<', '<=', '>', '>=', '==']);

const DEFAULT_OPTIONS = {
  maxAllowedConcurrency: 10000,
  maxAllowedDurationSec: 7200,
  maxAllowedPipelining: 64,
  disallowLoopback: true,
  allowedTargetHosts: null, // null allows any public host
};

/**
 * Validates, normalizes, and sanitizes an inbound load test plan manifest.
 *
 * @param {object} rawPlan - Raw manifest payload
 * @param {object} [options] - Custom contract constraint overrides
 * @returns {object} Canonical sanitized load test plan specification
 */
export function validateAndSanitizeLoadTestPlan(rawPlan, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  if (!rawPlan || typeof rawPlan !== 'object' || Array.isArray(rawPlan)) {
    throw new LoadTestPlanContractError('ERR_INVALID_SCHEMA', 'Load test plan manifest must be a non-null object');
  }

  // Prototype pollution guard
  for (const dangerousKey of ['__proto__', 'constructor', 'prototype']) {
    if (Object.prototype.hasOwnProperty.call(rawPlan, dangerousKey)) {
      throw new LoadTestPlanContractError('ERR_PROTOTYPE_POLLUTION', `Disallowed prototype modification key: ${dangerousKey}`);
    }
  }

  // 1. Version enforcement & schema evolution
  const rawVersion = rawPlan.version || 'loadmach9/v1';
  if (typeof rawVersion !== 'string' || !SUPPORTED_VERSIONS.has(rawVersion)) {
    throw new LoadTestPlanContractError(
      'ERR_INVALID_VERSION',
      `Unsupported schema version '${rawVersion}'. Expected one of: ${[...SUPPORTED_VERSIONS].join(', ')}`
    );
  }

  // 2. Plan ID validation
  const planId = String(rawPlan.planId || '').trim();
  if (!PLAN_ID_REGEX.test(planId)) {
    throw new LoadTestPlanContractError(
      'ERR_INVALID_PLAN_ID',
      `Invalid planId '${planId}'. Must be 3-64 alphanumeric characters, dashes, dots, or underscores.`
    );
  }

  // 3. Target URL validation & SSRF defense
  const targetUrlStr = String(rawPlan.target || '').trim();
  let parsedUrl;
  try {
    parsedUrl = new URL(targetUrlStr);
  } catch {
    throw new LoadTestPlanContractError('ERR_DISALLOWED_TARGET', `Malformed target URL: '${targetUrlStr}'`);
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new LoadTestPlanContractError('ERR_DISALLOWED_TARGET', `Unsupported target protocol '${parsedUrl.protocol}'. Only http: and https: are allowed.`);
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  if (opts.disallowLoopback) {
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '169.254.169.254' ||
      hostname.endsWith('.localhost')
    ) {
      throw new LoadTestPlanContractError('ERR_DISALLOWED_TARGET', `Target host '${hostname}' is prohibited (loopback / cloud metadata protection).`);
    }
  }

  if (opts.allowedTargetHosts && Array.isArray(opts.allowedTargetHosts) && opts.allowedTargetHosts.length > 0) {
    const isAllowed = opts.allowedTargetHosts.some(allowed => hostname === allowed || hostname.endsWith(`.${allowed}`));
    if (!isAllowed) {
      throw new LoadTestPlanContractError('ERR_DISALLOWED_TARGET', `Target host '${hostname}' is not in the authorized targets whitelist.`);
    }
  }

  // 4. HTTP Method
  const method = String(rawPlan.method || 'GET').toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    throw new LoadTestPlanContractError('ERR_INVALID_METHOD', `Unsupported HTTP method '${method}'. Allowed: ${[...ALLOWED_METHODS].join(', ')}`);
  }

  // 5. Execution parameters (concurrency, duration, pipelining)
  const rawConcurrency = Number(rawPlan.concurrency ?? 10);
  if (!Number.isInteger(rawConcurrency) || rawConcurrency < 1 || rawConcurrency > opts.maxAllowedConcurrency) {
    throw new LoadTestPlanContractError(
      'ERR_BOUNDARY_EXCEEDED',
      `Concurrency must be an integer between 1 and ${opts.maxAllowedConcurrency}; received ${rawPlan.concurrency}`
    );
  }

  const rawDuration = Number(rawPlan.durationSec ?? 60);
  if (!Number.isFinite(rawDuration) || rawDuration < 1 || rawDuration > opts.maxAllowedDurationSec) {
    throw new LoadTestPlanContractError(
      'ERR_BOUNDARY_EXCEEDED',
      `DurationSec must be between 1 and ${opts.maxAllowedDurationSec} seconds; received ${rawPlan.durationSec}`
    );
  }

  const rawPipelining = Number(rawPlan.pipelining ?? 1);
  if (!Number.isInteger(rawPipelining) || rawPipelining < 1 || rawPipelining > opts.maxAllowedPipelining) {
    throw new LoadTestPlanContractError(
      'ERR_BOUNDARY_EXCEEDED',
      `Pipelining must be an integer between 1 and ${opts.maxAllowedPipelining}; received ${rawPlan.pipelining}`
    );
  }

  // 6. Headers sanitization & CRLF injection defense
  const sanitizedHeaders = {};
  if (rawPlan.headers && typeof rawPlan.headers === 'object' && !Array.isArray(rawPlan.headers)) {
    for (const [k, v] of Object.entries(rawPlan.headers)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') {
        throw new LoadTestPlanContractError('ERR_PROTOTYPE_POLLUTION', `Disallowed header key '${k}'`);
      }
      const keyStr = String(k).trim();
      const valStr = String(v).trim();
      if (/[\r\n]/.test(keyStr) || /[\r\n]/.test(valStr)) {
        throw new LoadTestPlanContractError('ERR_HEADER_INJECTION', `CRLF characters detected in header '${keyStr}'`);
      }
      if (keyStr.length > 0) {
        sanitizedHeaders[keyStr.toLowerCase()] = valStr;
      }
    }
  }

  // 7. Thresholds specification
  const sanitizedThresholds = [];
  if (rawPlan.thresholds && Array.isArray(rawPlan.thresholds)) {
    for (const t of rawPlan.thresholds) {
      if (!t || typeof t !== 'object') continue;
      const metric = String(t.metric || '').toLowerCase();
      const op = String(t.operator || '');
      const value = Number(t.value);

      if (!THRESHOLD_METRICS.has(metric)) {
        throw new LoadTestPlanContractError('ERR_INVALID_THRESHOLD', `Invalid threshold metric '${metric}'`);
      }
      if (!THRESHOLD_OPERATORS.has(op)) {
        throw new LoadTestPlanContractError('ERR_INVALID_THRESHOLD', `Invalid threshold operator '${op}'`);
      }
      if (!Number.isFinite(value) || value < 0) {
        throw new LoadTestPlanContractError('ERR_INVALID_THRESHOLD', `Invalid threshold value '${t.value}'`);
      }

      sanitizedThresholds.push({ metric, operator: op, value });
    }
  }

  // 8. Stages specification (if multi-stage profile defined)
  const sanitizedStages = [];
  if (rawPlan.stages && Array.isArray(rawPlan.stages)) {
    for (let idx = 0; idx < rawPlan.stages.length; idx++) {
      const stage = rawPlan.stages[idx];
      if (!stage || typeof stage !== 'object') {
        throw new LoadTestPlanContractError('ERR_INVALID_STAGE', `Stage at index ${idx} must be an object`);
      }
      const targetRps = Number(stage.targetRps ?? 0);
      const stageDurationSec = Number(stage.durationSec ?? 0);

      if (!Number.isFinite(targetRps) || targetRps < 0 || targetRps > 1000000) {
        throw new LoadTestPlanContractError('ERR_INVALID_STAGE', `Stage ${idx} targetRps out of bounds [0, 1000000]`);
      }
      if (!Number.isFinite(stageDurationSec) || stageDurationSec <= 0 || stageDurationSec > opts.maxAllowedDurationSec) {
        throw new LoadTestPlanContractError('ERR_INVALID_STAGE', `Stage ${idx} durationSec out of bounds (1, ${opts.maxAllowedDurationSec}]`);
      }

      sanitizedStages.push({
        stageIndex: idx,
        targetRps: Math.round(targetRps),
        durationSec: Math.round(stageDurationSec),
      });
    }
  }

  return {
    version: rawVersion,
    planId,
    target: parsedUrl.origin + parsedUrl.pathname + parsedUrl.search,
    method,
    concurrency: rawConcurrency,
    durationSec: rawDuration,
    pipelining: rawPipelining,
    headers: sanitizedHeaders,
    thresholds: sanitizedThresholds,
    stages: sanitizedStages,
    validatedAt: new Date().toISOString(),
  };
}
