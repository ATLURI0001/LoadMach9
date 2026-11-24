/**
 * Load Scenario Execution Threshold & Target URL Ingress Contract.
 * 
 * Enforces strict boundary defenses, SSRF prevention, prototype pollution guards,
 * and mathematical validation across automated load test scenario manifests.
 */

import crypto from 'node:crypto';

export class ScenarioContractError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ScenarioContractError';
    this.details = details;
  }
}

export class SSRFViolationError extends ScenarioContractError {
  constructor(message, details = {}) {
    super(message, details);
    this.name = 'SSRFViolationError';
  }
}

export class ThresholdSyntaxError extends ScenarioContractError {
  constructor(message, details = {}) {
    super(message, details);
    this.name = 'ThresholdSyntaxError';
  }
}

const FORBIDDEN_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '169.254.169.254', // AWS/GCP/Azure link-local instance metadata
  'metadata.google.internal',
]);

const THRESHOLD_PATTERN = /^(p\(\d+(\.\d+)?\)|avg|min|max|med|rate|count)\s*(<=|>=|<|>|==)\s*(\d+(\.\d+)?)$/;

export class ScenarioThresholdContract {
  /**
   * @param {Object} [options]
   * @param {boolean} [options.allowLocalhost=false] - Whether local loopback destinations are permitted
   * @param {number} [options.maxVUs=10000] - Ceiling on maximum virtual users
   * @param {number} [options.maxDurationSec=86400] - Ceiling on scenario execution duration (default: 24h)
   */
  constructor(options = {}) {
    this.allowLocalhost = Boolean(options.allowLocalhost ?? false);
    this.maxVUs = Number(options.maxVUs) > 0 ? Number(options.maxVUs) : 10000;
    this.maxDurationSec = Number(options.maxDurationSec) > 0 ? Number(options.maxDurationSec) : 86400;
  }

  /**
   * Validates and canonicalizes a raw scenario manifest.
   *
   * @param {Object} manifest
   * @returns {Object} Canonicalized, verified scenario contract
   */
  validateScenario(manifest) {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw new ScenarioContractError('Scenario manifest must be a non-null object');
    }

    // Prototype pollution defense
    this._guardPrototypePollution(manifest);

    const scenarioId = String(manifest.scenarioId || '').trim();
    if (!scenarioId || !/^[a-zA-Z0-9_\-]{2,64}$/.test(scenarioId)) {
      throw new ScenarioContractError(
        `Invalid scenarioId '${scenarioId}': must be 2-64 alphanumeric, dash, or underscore characters`
      );
    }

    // Target URL & SSRF defense
    const targetUrl = this.validateTargetUrl(manifest.targetUrl);

    // Concurrency & duration bounds
    const vus = Math.floor(Number(manifest.vus) || 1);
    if (vus < 1 || vus > this.maxVUs) {
      throw new ScenarioContractError(
        `vus (${vus}) exceeds bounds [1, ${this.maxVUs}]`
      );
    }

    const durationSec = this._parseDurationToSeconds(manifest.duration || '30s');
    if (durationSec <= 0 || durationSec > this.maxDurationSec) {
      throw new ScenarioContractError(
        `duration (${durationSec}s) exceeds bounds [1s, ${this.maxDurationSec}s]`
      );
    }

    // Thresholds validation
    const thresholds = this.validateThresholds(manifest.thresholds || {});

    // Canonical representation
    const canonical = {
      scenarioId,
      targetUrl,
      vus,
      durationSec,
      thresholds,
      validatedAt: Date.now(),
    };

    const checksum = crypto
      .createHash('sha256')
      .update(JSON.stringify(canonical))
      .digest('hex');

    return { ...canonical, checksum };
  }

  /**
   * Enforces target URL format, allowed protocols, and SSRF restrictions.
   */
  validateTargetUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') {
      throw new ScenarioContractError('targetUrl must be a non-empty string');
    }

    let parsed;
    try {
      parsed = new URL(rawUrl.trim());
    } catch {
      throw new ScenarioContractError(`Malformed targetUrl: '${rawUrl}'`);
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ScenarioContractError(
        `Unsupported targetUrl protocol '${parsed.protocol}': only http and https are allowed`
      );
    }

    const host = parsed.hostname.toLowerCase();
    if (!this.allowLocalhost && FORBIDDEN_HOSTS.has(host)) {
      throw new SSRFViolationError(
        `SSRF security violation: target host '${host}' is restricted`,
        { host, url: rawUrl }
      );
    }

    // Link-local IPv4 / IPv6 checks
    if (!this.allowLocalhost && (host.startsWith('127.') || host.startsWith('169.254.') || host === '0.0.0.0')) {
      throw new SSRFViolationError(
        `SSRF security violation: target host IP '${host}' is loopback or link-local`,
        { host, url: rawUrl }
      );
    }

    return parsed.href;
  }

  /**
   * Validates metric threshold expressions.
   */
  validateThresholds(rawThresholds) {
    if (!rawThresholds || typeof rawThresholds !== 'object') {
      return {};
    }

    this._guardPrototypePollution(rawThresholds);
    const validated = {};

    for (const [metric, rules] of Object.entries(rawThresholds)) {
      const cleanMetric = String(metric).trim();
      if (!cleanMetric) continue;

      const ruleList = Array.isArray(rules) ? rules : [rules];
      validated[cleanMetric] = [];

      for (const rule of ruleList) {
        const cleanRule = String(rule).trim();
        const match = cleanRule.match(THRESHOLD_PATTERN);
        if (!match) {
          throw new ThresholdSyntaxError(
            `Malformed threshold rule '${cleanRule}' on metric '${cleanMetric}'`,
            { metric: cleanMetric, rule: cleanRule }
          );
        }

        const aggregation = match[1];
        const operator = match[3];
        const rawValue = match[4];
        const numVal = parseFloat(rawValue);

        if (!Number.isFinite(numVal) || numVal < 0) {
          throw new ThresholdSyntaxError(
            `Threshold value in '${cleanRule}' must be a non-negative finite number`,
            { rule: cleanRule }
          );
        }

        // Percentile boundary check: p(x) must have 0 < x <= 100
        if (aggregation.startsWith('p(')) {
          const pct = parseFloat(aggregation.slice(2, -1));
          if (pct <= 0 || pct > 100) {
            throw new ThresholdSyntaxError(
              `Percentile ${pct} in '${cleanRule}' out of bounds (0, 100]`,
              { rule: cleanRule }
            );
          }
        }

        validated[cleanMetric].push({
          expression: cleanRule,
          aggregation,
          operator,
          value: numVal,
        });
      }
    }

    return validated;
  }

  _parseDurationToSeconds(durationStr) {
    if (typeof durationStr === 'number') {
      return Math.floor(durationStr);
    }
    const match = String(durationStr).trim().match(/^(\d+)(s|m|h)?$/i);
    if (!match) {
      throw new ScenarioContractError(`Invalid duration string format: '${durationStr}'`);
    }
    const val = parseInt(match[1], 10);
    const unit = (match[2] || 's').toLowerCase();
    switch (unit) {
      case 'h': return val * 3600;
      case 'm': return val * 60;
      case 's': return val;
      default: return val;
    }
  }

  _guardPrototypePollution(obj) {
    if (!obj || typeof obj !== 'object') return;
    for (const key of Object.keys(obj)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        throw new ScenarioContractError(`Prototype pollution attempt detected via property '${key}'`);
      }
      if (typeof obj[key] === 'object' && obj[key] !== null) {
        this._guardPrototypePollution(obj[key]);
      }
    }
  }
}
