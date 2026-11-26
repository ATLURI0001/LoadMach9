export function validateLoadProfile(profile) {
  if (!profile || typeof profile !== 'object') throw new Error('Contract violation: profile object required');
  if (!Number.isInteger(profile.vus) || profile.vus <= 0) throw new Error('Contract violation: vus must be positive integer');
  if (typeof profile.durationSec !== 'number' || profile.durationSec <= 0) throw new Error('Contract violation: durationSec must be > 0');
  return true;
}
