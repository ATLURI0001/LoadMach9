// Request rate sentinel – rejects payloads above rateLimit per window.
export class RequestRateSentinel {
  #count = 0;
  #limit;
  constructor(limit) { this.#limit = limit; }
  check() {
    this.#count++;
    if (this.#count > this.#limit) throw new Error('rate limit exceeded');
  }
  reset() { this.#count = 0; }
}
