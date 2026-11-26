import { validateLoadProfile } from './load_profile_contract.js';
import assert from 'node:assert/strict';

assert.equal(validateLoadProfile({ vus: 10, durationSec: 30 }), true);
assert.throws(() => validateLoadProfile({ vus: 0, durationSec: 30 }));
console.log('PASS load_profile_contract');
