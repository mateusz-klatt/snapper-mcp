/**
 * WebSocket client for the `snapper-mcp watch` subcommand.
 *
 * Owns the full lifecycle of a long-lived WebSocket session against
 * the Snapper backend's `/api/ws` endpoint:
 *
 *   1. Mint a one-shot ws_token via the existing refresh flow
 *      (`fetchWsToken`).
 *   2. Open the socket with `Authorization: Bearer <access_token>`
 *      on the upgrade request — the backend prefers the bearer
 *      header over the cookie fallback for header-only clients
 *      (MCP / CLI). The ws_token rides on the post-upgrade
 *      `authenticate` frame, NOT as a URL parameter.
 *   3. Wait for the server's `auth_required` control frame,
 *      respond with `authenticate`, then wait for `auth_ok` +
 *      `auth_complete`.
 *   4. Send a `subscribe` request for the configured topic prefixes
 *      and await `subscription_success`.
 *   5. Enter the streaming loop. Forward only DATA frames (signals,
 *      order events, AI-review variants) via the operator-supplied
 *      `onFrame` callback. Control frames (`pong`,
 *      `subscription_success`, `error`, the auth/reauth family) are
 *      handled internally and surface only through the stderr
 *      logger — the JSONL stream a Claude Code Monitor primitive
 *      consumes stays free of protocol noise. Drop unknown
 *      `frame.type` values silently — the backend may ship new
 *      variants ahead of an npm bridge update, so the bridge stays
 *      forward-compatible by dropping rather than throwing.
 *   6. Send periodic `ping` frames as a liveness signal so the
 *      backend's gap detector observes a healthy client cadence.
 *      The default cadence (7s) is comfortably below the
 *      reauth-warn lead time (60s) so a network stall surfaces as a
 *      missed heartbeat well before any auth-related close.
 *
 * Reauthentication paths:
 *
 *   - `reauth_required` (warn): mint a fresh ws_token (rotates the
 *     token pair as a side-effect) and send a `reauth` frame in the
 *     same socket; await `reauth_ok`. The streaming loop continues
 *     uninterrupted.
 *   - `auth_expired` (server emits 0.3s before close 4401): close
 *     the socket and reconnect from scratch — the previous session's
 *     credentials are dead by the time we see this frame.
 *
 * Reconnect:
 *
 *   Any unintended socket close (network blip, server restart,
 *   `auth_expired`-triggered close) schedules a reconnect with
 *   jittered exponential backoff. The first reconnect attempt fires
 *   ~1s after close; subsequent attempts double up to a 30s cap with
 *   ±25% uniform jitter. Backoff resets on the first successful
 *   `subscription_success` of the next session — not on socket open
 *   alone, since a server that accepts the upgrade then immediately
 *   closes (e.g. ws_token replay) MUST not be treated as a healthy
 *   reconnect.
 *
 * PAT-mode incompatibility:
 *
 *   `fetchWsToken` rejects with `NoRefreshTokenError` when no
 *   refresh token is configured (long-lived PAT). This is fatal for
 *   the watch subcommand: PAT delegates cannot mint a ws_token, so
 *   the watch session can never authenticate. The error surfaces to
 *   the caller and the watch entry point exits with a clear
 *   operator-facing stderr message.
 *
 * AI-review dedup:
 *
 *   Server-side reconnect replays may re-deliver `ai_review.*`
 *   frames the bridge has already forwarded once. The dedup cache
 *   keys on `(type, review_public_id)` and tracks the
 *   `dispatch_version` last seen for each. A re-delivery whose
 *   `dispatch_version` is at or below the cached value is dropped.
 *   New versions overwrite the cached entry. The cache:
 *
 *     - is bounded (default 10000 entries) with oldest-first
 *       eviction on insert overflow;
 *     - prunes deadline-expired entries on a coarse timer (default
 *       60s) so it doesn't grow unbounded if the signal stream
 *       falls quiet;
 *     - commits the cache update AFTER a successful `onFrame` call
 *       — at-least-once semantics. If `onFrame` throws (downstream
 *       writer closed), the next re-delivery WILL be forwarded
 *       again.
 *
 * Frame-size guards:
 *
 *   Two budgets enforced at receive time so a malformed peer cannot
 *   pin process memory:
 *
 *     - 64 KiB raw frame budget — drops over-sized frames before
 *       JSON parse (the backend's per-frame ceiling is well below
 *       this).
 *     - 16 KiB signal envelope budget on `ai_review.request` —
 *       caps the embedded `signal_envelope` field which carries
 *       indicator history and instrument metadata.
 */

import { Buffer } from "node:buffer";
import WebSocket from "ws";

import { EnvelopeMinter } from "./envelope.js";
import { NoRefreshTokenError } from "./errors.js";
import type { Logger } from "./logger.js";
import type { TokenStore } from "./token_store.js";
import type {
  AiReviewFrame,
  PingRequestFrame,
  ServerFrame,
  SubscriptionSuccessFrame,
} from "./types.js";
import type { WsTokenResult } from "./ws_token.js";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 7_000;
const DEFAULT_MAX_RAW_FRAME_BYTES = 64 * 1024;
const DEFAULT_MAX_SIGNAL_ENVELOPE_BYTES = 16 * 1024;
const DEFAULT_RECONNECT_BACKOFF_BASE_MS = 1_000;
const DEFAULT_RECONNECT_BACKOFF_MAX_MS = 30_000;
const DEFAULT_RECONNECT_JITTER_FRACTION = 0.25;
const DEFAULT_DEDUP_CACHE_CAP = 10_000;
const DEFAULT_DEDUP_PRUNE_INTERVAL_MS = 60_000;
const DEFAULT_AUTH_HANDSHAKE_TIMEOUT_MS = 15_000;
const DEFAULT_SUBSCRIBE_TIMEOUT_MS = 10_000;
const DEFAULT_DEDUP_FALLBACK_TTL_MS = 5 * 60 * 1_000;

export interface WsClientOptions {
  readonly wsUrl: URL;
  readonly tokenStore: TokenStore;
  readonly fetchWsToken: () => Promise<WsTokenResult>;
  readonly topics: readonly string[];
  readonly minter: EnvelopeMinter;
  readonly onFrame: (frame: ServerFrame) => void;
  readonly logger: Logger;
  readonly heartbeatIntervalMs?: number;
  readonly maxRawFrameBytes?: number;
  readonly maxSignalEnvelopeBytes?: number;
  readonly reconnectBackoffBaseMs?: number;
  readonly reconnectBackoffMaxMs?: number;
  readonly reconnectJitterFraction?: number;
  readonly dedupCacheCap?: number;
  readonly dedupPruneIntervalMs?: number;
  readonly authHandshakeTimeoutMs?: number;
  readonly subscribeTimeoutMs?: number;
  readonly socketFactory?: (url: string, options: WebSocket.ClientOptions) => WebSocket;
  readonly random?: () => number;
}

export interface WsClient {
  readonly run: () => Promise<void>;
  readonly close: () => Promise<void>;
}

interface DedupEntry {
  dispatchVersion: number;
  expiresAt: number;
}

interface ResolvedConfig {
  readonly heartbeatIntervalMs: number;
  readonly maxRawFrameBytes: number;
  readonly maxSignalEnvelopeBytes: number;
  readonly reconnectBackoffBaseMs: number;
  readonly reconnectBackoffMaxMs: number;
  readonly reconnectJitterFraction: number;
  readonly dedupCacheCap: number;
  readonly dedupPruneIntervalMs: number;
  readonly authHandshakeTimeoutMs: number;
  readonly subscribeTimeoutMs: number;
  readonly random: () => number;
}

/**
 * Attach a no-op rejection handler so an early rejection on a
 * deferred — one that may be rejected before the awaiter reaches it
 * — does not surface as an "unhandled promise rejection" warning.
 * The real awaiter still observes the rejection because every
 * `.then`/`await` on the same promise creates a fresh continuation.
 */
function silenceUnhandledRejection<T>(p: Promise<T>): Promise<T> {
  void p.catch(() => undefined);
  return p;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
}

/**
 * Factory for an externally-resolvable promise pair. Provided as a
 * function rather than a class constructor so the no-op rejection
 * handler can be attached without putting an asynchronous operation
 * inside a constructor body.
 */
function createDeferred<T>(): Deferred<T> {
  let resolveFn!: (value: T) => void;
  let rejectFn!: (err: Error) => void;
  const promise = silenceUnhandledRejection(
    new Promise<T>((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
    }),
  );
  return {
    promise,
    resolve: resolveFn,
    reject: rejectFn,
  };
}

function defaultSocketFactory(
  url: string,
  options: WebSocket.ClientOptions,
): WebSocket {
  return new WebSocket(url, undefined, options);
}

function resolveConfig(opts: WsClientOptions): ResolvedConfig {
  return {
    heartbeatIntervalMs: opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    maxRawFrameBytes: opts.maxRawFrameBytes ?? DEFAULT_MAX_RAW_FRAME_BYTES,
    maxSignalEnvelopeBytes:
      opts.maxSignalEnvelopeBytes ?? DEFAULT_MAX_SIGNAL_ENVELOPE_BYTES,
    reconnectBackoffBaseMs:
      opts.reconnectBackoffBaseMs ?? DEFAULT_RECONNECT_BACKOFF_BASE_MS,
    reconnectBackoffMaxMs:
      opts.reconnectBackoffMaxMs ?? DEFAULT_RECONNECT_BACKOFF_MAX_MS,
    reconnectJitterFraction:
      opts.reconnectJitterFraction ?? DEFAULT_RECONNECT_JITTER_FRACTION,
    dedupCacheCap: opts.dedupCacheCap ?? DEFAULT_DEDUP_CACHE_CAP,
    dedupPruneIntervalMs:
      opts.dedupPruneIntervalMs ?? DEFAULT_DEDUP_PRUNE_INTERVAL_MS,
    authHandshakeTimeoutMs:
      opts.authHandshakeTimeoutMs ?? DEFAULT_AUTH_HANDSHAKE_TIMEOUT_MS,
    subscribeTimeoutMs: opts.subscribeTimeoutMs ?? DEFAULT_SUBSCRIBE_TIMEOUT_MS,
    random: opts.random ?? Math.random,
  };
}

function dedupKey(frame: AiReviewFrame): string {
  return `${frame.type}:${frame.review_public_id}`;
}

function deadlineToEpochMs(deadline: string | undefined, now: number): number {
  if (typeof deadline !== "string") return now + DEFAULT_DEDUP_FALLBACK_TTL_MS;
  const parsed = Date.parse(deadline);
  if (Number.isNaN(parsed)) return now + DEFAULT_DEDUP_FALLBACK_TTL_MS;
  return parsed;
}

export function createWsClient(opts: WsClientOptions): WsClient {
  const config = resolveConfig(opts);
  const socketFactory = opts.socketFactory ?? defaultSocketFactory;
  const dedupCache = new Map<string, DedupEntry>();

  /*
   * `shutdownAc` is created eagerly so the reconnect-backoff sleep
   * can always race against it. If we lazy-allocated it inside
   * `close()`, a `close()` arriving while the runner is mid-backoff
   * would have to wait for the full timer because the sleep would
   * already be running without the cancel-signal wired up.
   *
   * AbortController (vs a Deferred + `.then(...)` race) gives sleep
   * a remove-listener path so a long-running session with many
   * reconnects does not accumulate one pending continuation per
   * sleep call against a single never-resolving promise.
   */
  const shutdownAc = new AbortController();
  let shutdownRequested = false;
  let runComplete: Deferred<void> | null = null;
  let reconnectAttempt = 0;
  let pruneTimer: ReturnType<typeof setInterval> | null = null;
  let activeSession: SessionRunner | null = null;

  function startPruneTimer(): void {
    if (pruneTimer !== null) return;
    pruneTimer = setInterval(() => {
      pruneExpired(dedupCache, Date.now());
    }, config.dedupPruneIntervalMs);
    pruneTimer.unref();
  }

  function stopPruneTimer(): void {
    if (pruneTimer === null) return;
    clearInterval(pruneTimer);
    pruneTimer = null;
  }

  function computeBackoffMs(attempt: number): number {
    const exponent = Math.min(attempt, 16);
    const base = Math.min(
      config.reconnectBackoffBaseMs * 2 ** exponent,
      config.reconnectBackoffMaxMs,
    );
    const jitter = base * config.reconnectJitterFraction * (config.random() * 2 - 1);
    return Math.max(0, Math.floor(base + jitter));
  }

  async function sleep(ms: number): Promise<void> {
    if (ms <= 0) return;
    /*
     * The reconnect-backoff sleep MUST keep the Node event loop alive
     * (no `unref()` here) — when this timer fires no socket is open,
     * and the prune timer is unref'd by design, so the process would
     * otherwise exit between sessions.
     *
     * The sleep is also cancellable via `shutdownAc`: a `close()`
     * during backoff aborts the controller, which races the timer
     * to completion and lets the runner break out of the loop
     * without waiting for the full backoff. The abort listener is
     * registered with `once: true` and explicitly removed in the
     * timer-fire path, so a long-running session with many
     * reconnects does not accumulate listeners on the controller's
     * signal.
     */
    if (shutdownAc.signal.aborted) return;
    await new Promise<void>((resolve) => {
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        shutdownAc.signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      shutdownAc.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async function runForever(): Promise<void> {
    startPruneTimer();
    try {
      while (!shutdownRequested) {
        try {
          await runOneSession();
        } catch (err) {
          if (err instanceof NoRefreshTokenError) {
            opts.logger.error(
              "watch: this delegate is configured without a refresh token; long-lived PATs cannot mint ws_token. Re-issue the delegate as rotating-token.",
            );
            throw err;
          }
          if (shutdownRequested) {
            opts.logger.debug(`watch: session ended during shutdown: ${formatError(err)}`);
            break;
          }
          const message = formatError(err);
          opts.logger.warn(`watch: session error (will reconnect): ${message}`);
        }
        if (shutdownRequested) break;
        const backoff = computeBackoffMs(reconnectAttempt);
        reconnectAttempt += 1;
        opts.logger.info(`watch: reconnecting in ${backoff}ms (attempt ${reconnectAttempt})`);
        await sleep(backoff);
      }
    } finally {
      stopPruneTimer();
    }
  }

  async function runOneSession(): Promise<void> {
    if (shutdownRequested) return;
    const wsToken = await opts.fetchWsToken();
    if (shutdownRequested) return;
    const accessToken = opts.tokenStore.accessToken();
    const socketUrl = opts.wsUrl.toString();
    const socket = socketFactory(socketUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const session = new SessionRunner(socket, wsToken.ws_token, opts, config, dedupCache);
    activeSession = session;
    try {
      await session.run(() => {
        reconnectAttempt = 0;
      });
    } finally {
      activeSession = null;
      session.dispose();
    }
  }

  return {
    run: () => {
      if (runComplete !== null) return runComplete.promise;
      runComplete = createDeferred<void>();
      const deferred = runComplete;
      runForever()
        .then(
          () => deferred.resolve(),
          (err: unknown) => deferred.reject(err instanceof Error ? err : new Error(String(err))),
        )
        .finally(() => {
          if (!shutdownAc.signal.aborted) shutdownAc.abort();
        });
      return runComplete.promise;
    },
    close: async () => {
      /*
       * `shutdownAc` serves the cancel-sleep purpose; the
       * `close(): Promise<void>` contract resolves only after
       * teardown is FULLY complete, so every caller — including any
       * second concurrent `close()` — awaits `runComplete`, not the
       * abort signal. Aborting an already-aborted controller or
       * disposing an already-disposed session is a no-op.
       */
      if (!shutdownRequested) {
        shutdownRequested = true;
        shutdownAc.abort();
        if (activeSession !== null) {
          activeSession.dispose();
        }
      }
      if (runComplete !== null) {
        await runComplete.promise.catch(() => undefined);
      }
    },
  };
}

class SessionRunner {
  private readonly socket: WebSocket;
  private readonly wsToken: string;
  private readonly opts: WsClientOptions;
  private readonly config: ResolvedConfig;
  private readonly dedupCache: Map<string, DedupEntry>;
  private readonly logger: Logger;
  private readonly minter: EnvelopeMinter;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly authRequiredDeferred = createDeferred<void>();
  private readonly authCompleteDeferred = createDeferred<void>();
  private readonly subscribeDeferred = createDeferred<void>();
  private reauthDeferred: Deferred<void> | null = null;
  private readonly streamingDeferred = createDeferred<void>();
  private opened = false;
  private closed = false;
  private subscribed = false;

  constructor(
    socket: WebSocket,
    wsToken: string,
    opts: WsClientOptions,
    config: ResolvedConfig,
    dedupCache: Map<string, DedupEntry>,
  ) {
    this.socket = socket;
    this.wsToken = wsToken;
    this.opts = opts;
    this.config = config;
    this.dedupCache = dedupCache;
    this.logger = opts.logger;
    this.minter = opts.minter;

    const socketRef = socket;
    socket.on("open", () => {
      this.opened = true;
    });
    socket.on("error", (err: Error) => {
      this.failAll(err);
    });
    socket.on("close", (code: number, reason: Buffer) => {
      this.closed = true;
      const reasonText = reason.length > 0 ? reason.toString("utf8") : "(no reason)";
      const closeError = new Error(`websocket closed (code=${code}, reason=${reasonText})`);
      this.failAll(closeError);
    });
    socket.on("message", (raw: WebSocket.RawData) => {
      this.handleRawMessage(raw, socketRef);
    });
  }

  async run(onSubscribed: () => void): Promise<void> {
    await this.waitForOpen();
    await this.handshake();
    await this.subscribeOnce();
    this.subscribed = true;
    onSubscribed();
    this.startHeartbeat();
    await this.streamingDeferred.promise;
  }

  dispose(): void {
    this.stopHeartbeat();
    if (!this.closed) {
      this.socket.close(1000, "client shutdown");
    }
    this.socket.terminate();
  }

  private async waitForOpen(): Promise<void> {
    if (this.opened) return;
    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        cleanup();
        resolve();
      };
      const onError = (err: Error): void => {
        cleanup();
        reject(err);
      };
      const onClose = (code: number, reason: Buffer): void => {
        cleanup();
        const reasonText = reason.length > 0 ? reason.toString("utf8") : "(no reason)";
        reject(new Error(`websocket closed before open (code=${code}, reason=${reasonText})`));
      };
      const cleanup = (): void => {
        this.socket.off("open", onOpen);
        this.socket.off("error", onError);
        this.socket.off("close", onClose);
      };
      this.socket.once("open", onOpen);
      this.socket.once("error", onError);
      this.socket.once("close", onClose);
    });
  }

  private async handshake(): Promise<void> {
    await withTimeout(
      this.authRequiredDeferred.promise,
      this.config.authHandshakeTimeoutMs,
      "auth_required",
    );
    this.sendClientFrame({
      type: "authenticate",
      ws_token: this.wsToken,
      ...this.minter.next("control"),
    });
    await withTimeout(
      this.authCompleteDeferred.promise,
      this.config.authHandshakeTimeoutMs,
      "auth_complete",
    );
  }

  private async subscribeOnce(): Promise<void> {
    this.sendClientFrame({
      type: "subscribe",
      topics: [...this.opts.topics],
      ...this.minter.next("control"),
    });
    await withTimeout(
      this.subscribeDeferred.promise,
      this.config.subscribeTimeoutMs,
      "subscription_success",
    );
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer !== null) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.closed) return;
      const ping: PingRequestFrame = {
        type: "ping",
        ...this.minter.next("telemetry"),
      };
      this.sendClientFrame(ping);
    }, this.config.heartbeatIntervalMs);
    this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer === null) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private sendClientFrame(frame: object): void {
    if (this.closed) return;
    this.socket.send(JSON.stringify(frame));
  }

  private failAll(err: Error): void {
    this.authRequiredDeferred.reject(err);
    this.authCompleteDeferred.reject(err);
    this.subscribeDeferred.reject(err);
    if (this.reauthDeferred !== null) {
      this.reauthDeferred.reject(err);
      this.reauthDeferred = null;
    }
    if (this.subscribed) {
      this.streamingDeferred.reject(err);
    } else {
      this.streamingDeferred.resolve();
    }
  }

  private handleRawMessage(raw: WebSocket.RawData, socket: WebSocket): void {
    if (socket !== this.socket) return;
    const buf = toBuffer(raw);
    if (buf.byteLength > this.config.maxRawFrameBytes) {
      this.logger.warn(
        `watch: dropping over-sized frame (${buf.byteLength}B > ${this.config.maxRawFrameBytes}B)`,
      );
      return;
    }
    let parsed: ServerFrame;
    try {
      parsed = JSON.parse(buf.toString("utf8")) as ServerFrame;
    } catch (err) {
      this.logger.warn(`watch: dropping unparsable frame: ${formatError(err)}`);
      return;
    }
    if (typeof parsed !== "object" || parsed === null || typeof parsed.type !== "string") {
      this.logger.warn("watch: dropping frame without a string type discriminator");
      return;
    }
    this.dispatchFrame(parsed);
  }

  private dispatchFrame(frame: ServerFrame): void {
    switch (frame.type) {
      case "auth_required":
        this.authRequiredDeferred.resolve();
        return;
      case "auth_ok":
        return;
      case "auth_complete":
        this.authCompleteDeferred.resolve();
        return;
      case "auth_failed":
        this.failAll(new Error(`websocket auth_failed: ${frame.reason ?? "(no reason)"}`));
        return;
      case "subscription_success":
        this.handleSubscriptionSuccess(frame);
        return;
      case "reauth_required":
        void this.handleReauthRequired();
        return;
      case "reauth_ok":
        if (this.reauthDeferred !== null) {
          this.reauthDeferred.resolve();
          this.reauthDeferred = null;
        }
        return;
      case "auth_expired":
        this.logger.info("watch: auth_expired received; cycling connection");
        this.socket.close(4401, "auth_expired");
        return;
      case "pong":
        return;
      case "error":
        this.logger.warn(`watch: server error frame: ${frame.message}`);
        return;
      case "signal":
      case "order_event":
        this.opts.onFrame(frame);
        return;
      case "ai_review.request":
      case "ai_review.decision_ack":
      case "ai_review.caps_violation":
        this.handleAiReviewFrame(frame);
        return;
      default:
        /*
         * Forward-compat contract (see `src/types.ts`): unknown
         * server-emitted frame types are dropped silently so the
         * bridge stays compatible with backend deployments that
         * ship new variants ahead of an npm bridge update. The
         * drop is recorded at debug level only — a high-volume
         * new frame type would otherwise spam stderr.
         */
        this.logger.debug(
          `watch: dropping unknown frame.type=${JSON.stringify((frame as { type: unknown }).type)}`,
        );
        return;
    }
  }

  private handleSubscriptionSuccess(frame: SubscriptionSuccessFrame): void {
    /*
     * The backend reuses `subscription_success` for denied / no_topics
     * outcomes: the frame type is the response envelope, not a
     * commitment that a subscription is live. Treat only `subscribed`
     * and `partial` (with at least one accepted topic) as a healthy
     * handshake completion. Everything else is a fatal session error
     * — the watch process would otherwise sit idle with zero
     * subscriptions while looking healthy to its caller.
     */
    const isSubscribeAction = frame.action === "subscribe";
    const okStatus = frame.status === "subscribed" || frame.status === "partial";
    const acceptedAtLeastOne = frame.topics.length > 0;
    if (isSubscribeAction && okStatus && acceptedAtLeastOne) {
      this.subscribeDeferred.resolve();
      this.logger.info(
        `watch: subscribed (status=${frame.status}) topics=[${frame.topics.join(",")}] denied=[${frame.denied_topics.join(",")}]`,
      );
      return;
    }
    this.failAll(
      new Error(
        `subscription rejected: action=${frame.action} status=${frame.status} accepted=[${frame.topics.join(",")}] denied=[${frame.denied_topics.join(",")}]`,
      ),
    );
  }

  private handleAiReviewFrame(frame: AiReviewFrame): void {
    if (frame.type === "ai_review.request") {
      const envBytes = Buffer.byteLength(
        JSON.stringify(frame.signal_envelope ?? {}),
        "utf8",
      );
      if (envBytes > this.config.maxSignalEnvelopeBytes) {
        this.logger.warn(
          `watch: dropping ai_review.request — signal_envelope ${envBytes}B exceeds ${this.config.maxSignalEnvelopeBytes}B`,
        );
        return;
      }
    }
    const key = dedupKey(frame);
    const cached = this.dedupCache.get(key);
    if (cached !== undefined && frame.dispatch_version <= cached.dispatchVersion) {
      this.logger.debug(
        `watch: drop AI-review replay key=${key} version=${frame.dispatch_version} cached=${cached.dispatchVersion}`,
      );
      return;
    }
    let delivered = false;
    try {
      this.opts.onFrame(frame);
      delivered = true;
    } catch (err) {
      this.logger.warn(`watch: onFrame threw on ai-review delivery: ${formatError(err)}`);
    }
    if (!delivered) return;
    const deadline =
      frame.type === "ai_review.request" ? frame.deadline : undefined;
    const expiresAt = deadlineToEpochMs(deadline, Date.now());
    /*
     * Two distinct cases:
     *
     *   - The key is new and the cache is at cap → evict oldest by
     *     insertion order before insert.
     *   - The key already exists (we're updating to a newer
     *     dispatch_version) → delete first, then re-insert so Map
     *     iteration order moves the entry to the most-recent slot.
     *     This keeps the eviction order LRU-faithful: the next
     *     overflow won't evict an entry we just touched.
     */
    if (this.dedupCache.has(key)) {
      this.dedupCache.delete(key);
    } else if (this.dedupCache.size >= this.config.dedupCacheCap) {
      const oldestKey = this.dedupCache.keys().next().value as string;
      this.dedupCache.delete(oldestKey);
    }
    this.dedupCache.set(key, {
      dispatchVersion: frame.dispatch_version,
      expiresAt,
    });
  }

  private async handleReauthRequired(): Promise<void> {
    this.logger.info("watch: reauth_required received; minting fresh ws_token");
    let fresh: WsTokenResult;
    try {
      fresh = await this.opts.fetchWsToken();
    } catch (err) {
      this.logger.warn(`watch: ws_token refresh failed during reauth: ${formatError(err)}`);
      this.socket.close(4001, "reauth fetch failed");
      return;
    }
    if (this.closed) return;
    const deferred = createDeferred<void>();
    this.reauthDeferred = deferred;
    this.sendClientFrame({
      type: "reauth",
      ws_token: fresh.ws_token,
      ...this.minter.next("control"),
    });
    try {
      await withTimeout(
        deferred.promise,
        this.config.authHandshakeTimeoutMs,
        "reauth_ok",
      );
    } catch (err) {
      this.logger.warn(`watch: reauth_ok wait failed: ${formatError(err)}`);
      this.socket.close(4001, "reauth timeout");
    }
  }
}

function pruneExpired(cache: Map<string, DedupEntry>, now: number): void {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
}

export function toBuffer(raw: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw);
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`watch: timeout waiting for ${label} after ${ms}ms`)), ms);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
