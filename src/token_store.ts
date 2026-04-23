/**
 * In-memory token pair storage with race-tight single-flight rotation.
 *
 * Owned by `bridge_fetch`'s custom `fetch` wrapper. Holds the current
 * access+refresh pair and coordinates refresh so that N concurrent
 * 401 responses trigger exactly ONE `performRefresh` call; every
 * caller awaits the same promise and sees the same new pair.
 *
 * Race-tightness invariant:
 *
 *   The publication of the rotated pair (`this.pair = next`) runs
 *   INSIDE the `.then` continuation of the `performRefresh` promise,
 *   which settles BEFORE any awaiting caller's microtask resumes.
 *   Only AFTER that does `finally { this.inFlight = null }` run.
 *   Consequence: as long as `this.inFlight !== null`, `this.pair` is
 *   still the old value; the instant `this.inFlight` clears, the
 *   new pair has already been published. There is no window where
 *   `accessToken()` could return the old pair while `inFlight` is
 *   null.
 *
 * Token rotation failures (network, 5xx, malformed response, 401
 * refresh-rejected) propagate out as the original thrown error.
 * `this.pair` stays at the old value and `this.inFlight` clears so
 * the next 401 triggers a fresh rotate attempt.
 */

export interface TokenPair {
  readonly access: string;
  readonly refresh: string;
}

export type RefreshFn = (current: TokenPair) => Promise<TokenPair>;

export class TokenStore {
  private pair: TokenPair;
  private inFlight: Promise<TokenPair> | null = null;

  constructor(initial: TokenPair) {
    this.pair = initial;
  }

  accessToken(): string {
    return this.pair.access;
  }

  current(): TokenPair {
    return this.pair;
  }

  async rotate(via: RefreshFn): Promise<TokenPair> {
    if (this.inFlight !== null) {
      return this.inFlight;
    }
    const snapshot = this.pair;
    const inFlight = via(snapshot).then((next) => {
      this.pair = next;
      return next;
    });
    this.inFlight = inFlight;
    try {
      return await inFlight;
    } finally {
      this.inFlight = null;
    }
  }
}
