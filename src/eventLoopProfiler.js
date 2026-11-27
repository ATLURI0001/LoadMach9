// eventLoopProfiler.js - records event loop lag samples
export class EventLoopProfiler {
  #samples = [];

  record(lagMs) {
    this.#samples.push(lagMs);
  }

  maxLag() {
    return this.#samples.length ? Math.max(...this.#samples) : 0;
  }
}
