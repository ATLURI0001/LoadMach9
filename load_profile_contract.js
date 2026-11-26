/**
 * Load Generation Scenario & Ramp-Up Profile Schema Contract.
 * 
 * Enforces safe concurrency bounds, positive duration/RPS targets,
 * and valid HTTP target URLs before dispatching load workers.
 */

export class LoadProfileContract {
  static validate(profile, maxAllowedVUs = 10000) {
    const errors = [];

    if (!profile || typeof profile !== 'object') {
      return { valid: false, errors: ['ERR_INVALID_PROFILE_OBJECT'] };
    }

    if (!profile.targetUrl || !/^https?:\/\/.+/.test(profile.targetUrl)) {
      errors.push('ERR_INVALID_TARGET_URL');
    }

    if (!Number.isInteger(profile.virtualUsers) || profile.virtualUsers <= 0 || profile.virtualUsers > maxAllowedVUs) {
      errors.push(`ERR_VUS_OUT_OF_BOUNDS: ${profile.virtualUsers}`);
    }

    if (typeof profile.durationSec !== 'number' || profile.durationSec <= 0) {
      errors.push('ERR_INVALID_DURATION');
    }

    if (profile.rampUpSec !== undefined && (profile.rampUpSec < 0 || profile.rampUpSec > profile.durationSec)) {
      errors.push('ERR_INVALID_RAMP_UP');
    }

    return { valid: errors.length === 0, errors };
  }
}
