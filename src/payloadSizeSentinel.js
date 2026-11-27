// payloadSizeSentinel.js - flags oversized request payloads
export class PayloadSizeSentinel {
  #maxBytes;
  #flagged = 0;

  constructor(maxBytes = 65536) {
    this.#maxBytes = maxBytes;
  }

  check(bytes) {
    if (bytes > this.#maxBytes) {
      this.#flagged++;
      return false;
    }
    return true;
  }

  flaggedCount() { return this.#flagged; }
}
