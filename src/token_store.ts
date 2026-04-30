/**
 * In-memory access-token storage for the bridge.
 *
 * Owned by `bridge_fetch`'s custom `fetch` wrapper. Holds the access
 * token used for `Authorization: Bearer` on every request. The token
 * is set once at startup from the operator-supplied AI delegate
 * credential and is not mutated at runtime.
 */

export interface TokenPair {
  readonly access: string;
}

export class TokenStore {
  private readonly pair: TokenPair;

  constructor(initial: TokenPair) {
    this.pair = initial;
  }

  accessToken(): string {
    return this.pair.access;
  }

  current(): TokenPair {
    return this.pair;
  }
}
