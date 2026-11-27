// workerPoolRotary.js - bounded ring buffer for worker pool metrics
export class WorkerPoolRotary {
  #buf = [];
  #max;

  constructor(max = 8) {
    this.#max = max;
  }

  push(item) {
    if (this.#buf.length >= this.#max) this.#buf.shift();
    this.#buf.push(item);
  }

  count() { return this.#buf.length; }
}
