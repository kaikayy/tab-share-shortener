/*!
 * ratelimit.mjs -- a plain in-memory rolling-window counter, keyed by client IP.
 *
 * Guards the creation endpoints only; redirects are unlimited. Good enough for
 * a single instance. Behind multiple instances, put a real limiter at the proxy.
 */

export class RateLimiter {
  /** @param {number} perMinute  0 disables the limiter */
  constructor(perMinute) {
    this.limit = perMinute;
    /** @type {Map<string, number[]>} timestamps per key */
    this.hits = new Map();
  }

  /** @param {string} key @returns {boolean} true = allowed */
  allow(key) {
    if (!this.limit || this.limit <= 0) return true;
    const now = Date.now();
    const cutoff = now - 60_000;
    const arr = (this.hits.get(key) || []).filter((t) => t > cutoff);
    if (arr.length >= this.limit) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(key, arr);
    return true;
  }

  /** Drop stale keys -- call on an interval. */
  sweep() {
    const cutoff = Date.now() - 60_000;
    for (const [k, arr] of this.hits) {
      const live = arr.filter((t) => t > cutoff);
      if (live.length) this.hits.set(k, live);
      else this.hits.delete(k);
    }
  }
}
