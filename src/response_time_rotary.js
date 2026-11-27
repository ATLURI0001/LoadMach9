// LoadMach9: response time rotary telemetry
export class ResponseTimeRotary {
  #buf = [];
  #cap;
  constructor(cap = 10) { this.#cap = cap; }
  record(ms) {
    if (this.#buf.length >= this.#cap) this.#buf.shift();
    this.#buf.push(ms);
  }
  get length() { return this.#buf.length; }
}
