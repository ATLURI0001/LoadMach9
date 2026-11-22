/**
 * k6 & Locust Load Scenario Ingress Contract and Metric Threshold Sanitizer.
 * Enforces declarative scenario schema constraints, validates complex executor types,
 * parses threshold mathematical expressions, and defends against prototype injection.
 */

export const ALLOWED_EXECUTORS = new Set([
  'constant-vus',
  'ramping-vus',
  'constant-arrival-rate',
  'ramping-arrival-rate',
  'per-vu-iterations',
  'shared-iterations',
]);

export const DURATION_REGEX = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/;
export const THRESHOLD_EXPR_REGEX = /^(p\(\d{1,2}(?:\.\d+)?\)|rate|count|avg|min|max)\s*(<|<=|>|>=)\s*(\d+(?:\.\d+)?)$/;
export const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Custom error for scenario contract and schema breaches.
 */
export class ScenarioContractError extends Error {
  /**
   * @param {string} message
   * @param {string} field
   * @param {string} rule
   */
  constructor(message, field, rule) {
    super(message);
    this.name = 'ScenarioContractError';
    this.field = field;
    this.rule = rule;
  }
}

/**
 * Parses duration strings like '30s', '5m', '1.5h' into integer milliseconds.
 * @param {string|number} input
 * @returns {number} Duration in milliseconds.
 */
export function parseScenarioDurationMs(input) {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input <= 0) {
      throw new ScenarioContractError('Duration must be a positive finite number', 'duration', 'positive_numeric');
    }
    return Math.floor(input);
  }

  const str = String(input || '').trim().toLowerCase();
  const match = DURATION_REGEX.exec(str);
  if (!match) {
    throw new ScenarioContractError(`Invalid duration format '${input}' (e.g. 30s, 5m, 1h)`, 'duration', 'format');
  }

  const val = parseFloat(match[1]);
  const unit = match[2];
  let multiplier = 1000;
  if (unit === 'ms') multiplier = 1;
  else if (unit === 's') multiplier = 1000;
  else if (unit === 'm') multiplier = 60 * 1000;
  else if (unit === 'h') multiplier = 3600 * 1000;

  return Math.floor(val * multiplier);
}

/**
 * Validates and sanitizes a complete k6/Locust execution scenario contract.
 * @param {Object} rawConfig
 * @returns {Object} Sanitized and normalized configuration.
 */
export function validateAndSanitizeK6Scenario(rawConfig) {
  if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    throw new ScenarioContractError('Scenario configuration must be an object', 'root', 'invalid_type');
  }

  // Prototype pollution scan
  for (const k of Object.keys(rawConfig)) {
    if (FORBIDDEN_KEYS.has(String(k).toLowerCase())) {
      throw new ScenarioContractError('Forbidden prototype/constructor property detected', k, 'prototype_pollution');
    }
  }

  const sanitized = {
    scenarios: {},
    thresholds: {},
    targetUrl: '',
  };

  // 1. targetUrl validation
  const rawUrl = String(rawConfig.targetUrl || rawConfig.url || '').trim();
  if (!rawUrl) {
    throw new ScenarioContractError('targetUrl is required', 'targetUrl', 'required');
  }
  try {
    const parsedUrl = new URL(rawUrl);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new ScenarioContractError('Target protocol must be http or https', 'targetUrl', 'protocol');
    }
    sanitized.targetUrl = parsedUrl.toString();
  } catch (err) {
    if (err instanceof ScenarioContractError) throw err;
    throw new ScenarioContractError(`Malformed target URL: ${err.message}`, 'targetUrl', 'malformed');
  }

  // 2. Scenarios validation
  const rawScenarios = rawConfig.scenarios || { default: rawConfig };
  if (typeof rawScenarios !== 'object' || Array.isArray(rawScenarios)) {
    throw new ScenarioContractError('scenarios must be an object map', 'scenarios', 'invalid_type');
  }

  const scenarioKeys = Object.keys(rawScenarios);
  if (scenarioKeys.length === 0) {
    throw new ScenarioContractError('At least one scenario must be defined', 'scenarios', 'min_items');
  }

  for (const name of scenarioKeys) {
    const sc = rawScenarios[name];
    if (!sc || typeof sc !== 'object') {
      throw new ScenarioContractError(`Scenario '${name}' must be an object`, `scenarios.${name}`, 'invalid_type');
    }

    const executor = String(sc.executor || 'constant-vus').trim().toLowerCase();
    if (!ALLOWED_EXECUTORS.has(executor)) {
      throw new ScenarioContractError(
        `Unsupported executor '${executor}' for scenario '${name}'`,
        `scenarios.${name}.executor`,
        'unsupported_executor'
      );
    }

    const scSanitized = {
      executor,
      vus: 1,
      durationMs: 0,
      stages: [],
    };

    if (executor === 'constant-vus' || executor === 'per-vu-iterations') {
      const vus = Number(sc.vus ?? 1);
      if (!Number.isInteger(vus) || vus < 1 || vus > 100000) {
        throw new ScenarioContractError(`vus must be an integer between 1 and 100,000`, `scenarios.${name}.vus`, 'bounds');
      }
      scSanitized.vus = vus;

      if (sc.duration) {
        scSanitized.durationMs = parseScenarioDurationMs(sc.duration);
      }
    } else if (executor === 'ramping-vus' || executor === 'ramping-arrival-rate') {
      if (!Array.isArray(sc.stages) || sc.stages.length === 0) {
        throw new ScenarioContractError(`Ramping executor requires non-empty 'stages' array`, `scenarios.${name}.stages`, 'required');
      }
      let totalDuration = 0;
      for (let sIdx = 0; sIdx < sc.stages.length; sIdx++) {
        const stage = sc.stages[sIdx];
        if (!stage || typeof stage !== 'object') {
          throw new ScenarioContractError(`Stage ${sIdx} must be an object`, `scenarios.${name}.stages[${sIdx}]`, 'invalid_type');
        }
        const stageDuration = parseScenarioDurationMs(stage.duration);
        const target = Number(stage.target ?? 0);
        if (!Number.isInteger(target) || target < 0 || target > 1000000) {
          throw new ScenarioContractError(`Stage target must be integer >= 0`, `scenarios.${name}.stages[${sIdx}].target`, 'bounds');
        }
        totalDuration += stageDuration;
        scSanitized.stages.push({
          durationMs: stageDuration,
          target,
        });
      }
      scSanitized.durationMs = totalDuration;
    }

    sanitized.scenarios[name] = scSanitized;
  }

  // 3. Thresholds validation
  if (rawConfig.thresholds && typeof rawConfig.thresholds === 'object') {
    for (const [metric, exprs] of Object.entries(rawConfig.thresholds)) {
      const exprList = Array.isArray(exprs) ? exprs : [exprs];
      const validExprs = [];

      for (const expr of exprList) {
        const cleanExpr = String(expr).trim();
        if (!THRESHOLD_EXPR_REGEX.test(cleanExpr)) {
          throw new ScenarioContractError(
            `Invalid threshold expression '${expr}' for metric '${metric}' (e.g. 'p(95)<500', 'rate<0.01')`,
            `thresholds.${metric}`,
            'invalid_expression'
          );
        }
        validExprs.push(cleanExpr);
      }
      sanitized.thresholds[metric] = validExprs;
    }
  }

  return sanitized;
}
