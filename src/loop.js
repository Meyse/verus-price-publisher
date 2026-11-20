// The service loop. A check (Publisher.tick) runs on each poll and on each block
// notification. It never runs, and never calls the daemon, while the minimum interval
// since the last cycle runs: a check that comes too early waits until the interval ends.

const MAX_DELAY = 2 ** 31 - 1; // setTimeout limit (about 24.8 days)

export class Loop {
  /**
   * @param {import('./publisher.js').Publisher} publisher
   * @param {object} options
   * @param {number} options.pollMs regular poll; with block notification a slow safety poll
   * @param {(error: Error) => void} options.onFatal called once when a check throws (wrong chain)
   * @param {Function} [options.setTimer]
   * @param {Function} [options.clearTimer]
   */
  constructor(publisher, { pollMs, onFatal, setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.publisher = publisher;
    this.pollMs = pollMs;
    this.onFatal = onFatal;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timer = null;
    this.dueAt = Infinity; // time of the planned check
    this.running = false;
    this.pendingAt = Infinity; // a check asked for while one was running
    this.stopped = false;
  }

  start() {
    this.wake(this.publisher.now());
  }

  stop() {
    this.stopped = true;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }

  // A block notification: check at once, or when the minimum interval ends.
  notify() {
    this.wake(this.publisher.nextCycleAt());
  }

  // Plan a check at `at` (ms), unless one is already planned at or before that time.
  wake(at) {
    if (this.stopped) return;
    if (this.running) {
      this.pendingAt = Math.min(this.pendingAt, at);
      return;
    }
    if (at >= this.dueAt) return;
    if (this.timer) this.clearTimer(this.timer);
    this.dueAt = at;
    const delay = Math.min(MAX_DELAY, Math.max(0, at - this.publisher.now()));
    this.timer = this.setTimer(() => this.run(), delay);
  }

  async run() {
    this.timer = null;
    this.dueAt = Infinity;
    this.running = true;
    try {
      await this.publisher.tick();
    } catch (error) {
      this.running = false;
      this.stop();
      this.onFatal(error);
      return;
    }
    this.running = false;
    const pending = this.pendingAt;
    this.pendingAt = Infinity;
    // The next poll, but not before the minimum interval ends (that poll could do nothing).
    this.wake(Math.max(this.publisher.now() + this.pollMs, this.publisher.nextCycleAt()));
    if (pending < Infinity) this.wake(Math.max(pending, this.publisher.nextCycleAt()));
  }
}
