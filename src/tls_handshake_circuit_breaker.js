export class TlsHandshakeCircuitBreaker {
  constructor(threshold = 3, cooldownMs = 5000) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    this.failures = 0;
    this.openUntil = 0;
  }

  call(fn) {
    if (Date.now() < this.openUntil) throw new Error('TLS handshake circuit open');
    try {
      const res = fn();
      this.failures = 0;
      return res;
    } catch (err) {
      this.failures++;
      if (this.failures >= this.threshold) {
        this.openUntil = Date.now() + this.cooldownMs;
        this.failures = 0;
      }
      throw err;
    }
  }
}
