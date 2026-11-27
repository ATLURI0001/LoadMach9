export function validateRateLimitConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') throw new Error('Contract violation: config object required');
  if (!Number.isInteger(cfg.maxRps) || cfg.maxRps <= 0) throw new Error('Contract violation: maxRps must be > 0');
  if (!Number.isInteger(cfg.burst) || cfg.burst < cfg.maxRps) throw new Error('Contract violation: burst must be >= maxRps');
  return true;
}
