/**
 * Wire-contract types for the Snapper WebSocket push surface.
 *
 * These types are the bridge-side source-of-truth for frames the
 * upcoming `snapper-mcp watch` subcommand will exchange with the
 * Snapper backend on `wss://.../api/ws`. Frames are JSON objects
 * discriminated by the `type` field; the bridge `default:` switch
 * arm drops unknown server-emitted types silently so the bridge
 * stays forward-compatible when the backend adds new frame variants.
 *
 * The bridge keeps a narrow local mirror of the schemas so it can
 * ship without a build-time dependency on any generated TypeScript
 * bundle. The fields modelled here are the subset the watch
 * subcommand cares about; any extra envelope or payload fields the
 * server emits are preserved by the JSON passthrough but not
 * statically typed here.
 *
 * Schema notes:
 *
 *   - Every server-emitted frame carries a transport-layer envelope
 *     (`session_id`, `sequence_id`, `public_id`, `timestamp`); it is
 *     modelled here via `extends FrameEnvelope` for completeness even
 *     though the watch subcommand does not currently inspect those
 *     fields.
 *   - Every client-sent frame MUST carry the same envelope. The
 *     `WatchClientFrame` union below covers only the frames the watch
 *     subcommand sends (authenticate, reauth, subscribe, ping); other
 *     client frame types (unsubscribe, get_subscriptions) are not
 *     needed for the watch flow and are deliberately omitted.
 *   - All AI-review data frames carry the dedup triple
 *     (`type`, `review_public_id`, `dispatch_version`) so consumers
 *     can drop server-side replays after reconnects.
 *   - Pydantic's `None` fields serialize as JSON `null`, so optional
 *     server-emitted fields are typed as `T | null` rather than
 *     `T | undefined`.
 *   - Generic data frames (signal, order_event) are intentionally
 *     NOT modelled here. The server forwards raw publisher payloads
 *     verbatim; their wire shape mirrors the publisher schemas
 *     directly (flat domain fields, not a `{topic, payload}`
 *     wrapper). The watch subcommand forwards them as-is via JSON
 *     passthrough, so a typed model is not required for that flow.
 */

import type { FrameEnvelope } from "./envelope.js";

/* --------------------------------------------------------------------
 * Server → client control frames
 * ------------------------------------------------------------------ */

/** First server frame post-upgrade: prompts the client to send `authenticate` within `timeout` seconds. */
export interface AuthRequiredFrame extends FrameEnvelope {
  readonly type: "auth_required";
  readonly timeout: number;
}

/** Server acknowledges a successful `authenticate` frame; carries the new ws_token expiration. */
export interface AuthOkFrame extends FrameEnvelope {
  readonly type: "auth_ok";
  readonly exp: string;
}

/** Server completes the authentication handshake; carries the available topic catalogue + role. */
export interface AuthCompleteFrame extends FrameEnvelope {
  readonly type: "auth_complete";
  readonly available_topics: readonly string[];
  readonly user_role: string;
  readonly session_expires_at: string | null;
  readonly ws_token_exp: string;
}

/** Server rejected the authentication handshake (bad ws_token, timeout, replay, missing cookie). */
export interface AuthFailedFrame extends FrameEnvelope {
  readonly type: "auth_failed";
  readonly reason: string | null;
}

/**
 * Server signals the client must fetch a fresh `ws_token` and
 * send a `reauth` frame before `deadline`. The client SHOULD respond
 * before the deadline; failure to do so triggers `auth_expired` and
 * the WS session is closed.
 */
export interface ReauthRequiredFrame extends FrameEnvelope {
  readonly type: "reauth_required";
  readonly deadline: string;
}

/** Server acknowledges a successful `reauth` frame; carries the new ws_token expiration. */
export interface ReauthOkFrame extends FrameEnvelope {
  readonly type: "reauth_ok";
  readonly exp: string;
}

/** Server expired the WS session — client must reconnect from scratch. */
export interface AuthExpiredFrame extends FrameEnvelope {
  readonly type: "auth_expired";
}

/** Subscription ACK after the client sends a `subscribe` frame. */
export interface SubscriptionSuccessFrame extends FrameEnvelope {
  readonly type: "subscription_success";
  readonly action: "subscribe" | "unsubscribe";
  readonly status: "subscribed" | "unsubscribed" | "partial" | "denied" | "no_topics";
  readonly topics: readonly string[];
  readonly denied_topics: readonly string[];
  readonly active_subscriptions: readonly string[];
  readonly message: string | null;
}

/** Pong response to a client `ping`; carries server timestamp + connection count. */
export interface PongFrame extends FrameEnvelope {
  readonly type: "pong";
  readonly timestamp: string;
  readonly active_connections: number;
}

/** Generic transport-layer error frame; the server emits this for protocol-level failures. */
export interface ErrorFrame extends FrameEnvelope {
  readonly type: "error";
  readonly message: string;
}

export type ControlFrame =
  | AuthRequiredFrame
  | AuthOkFrame
  | AuthCompleteFrame
  | AuthFailedFrame
  | ReauthRequiredFrame
  | ReauthOkFrame
  | AuthExpiredFrame
  | SubscriptionSuccessFrame
  | PongFrame
  | ErrorFrame;

export type ControlFrameType = ControlFrame["type"];

/* --------------------------------------------------------------------
 * Server → client AI-review frames
 * ------------------------------------------------------------------ */

/** AI-review request frame: server publishes when a delegate is asked to review a candidate signal. */
export interface AiReviewRequestFrame extends FrameEnvelope {
  readonly type: "ai_review.request";
  readonly review_public_id: string;
  readonly user_public_id: string;
  readonly strategy_public_id: string;
  readonly wallet_public_id: string;
  readonly instrument_public_id: string;
  readonly dispatch_version: number;
  readonly selected_delegate_public_id: string;
  readonly deadline?: string;
  readonly signal_envelope?: object;
  readonly instrument_metadata?: object;
}

/** AI-review decision ACK: server publishes after a delegate submits an approve/reject decision. */
export interface AiReviewDecisionAckFrame extends FrameEnvelope {
  readonly type: "ai_review.decision_ack";
  readonly review_public_id: string;
  readonly user_public_id: string;
  readonly strategy_public_id: string;
  readonly wallet_public_id: string;
  readonly instrument_public_id: string;
  readonly dispatch_version: number;
  readonly decision: "approve" | "reject";
  readonly resolution_mode?: string;
}

/** Caps-violation frame: server publishes when an approved review trips a per-strategy or per-wallet cap. */
export interface AiReviewCapsViolationFrame extends FrameEnvelope {
  readonly type: "ai_review.caps_violation";
  readonly review_public_id: string;
  readonly user_public_id: string;
  readonly strategy_public_id: string;
  readonly wallet_public_id: string;
  readonly instrument_public_id: string;
  readonly dispatch_version: number;
  readonly cap_type: string;
  readonly attempted: number;
  readonly limit: number;
}

export type AiReviewFrame =
  | AiReviewRequestFrame
  | AiReviewDecisionAckFrame
  | AiReviewCapsViolationFrame;

/**
 * Closed union of every server-emitted frame the bridge currently
 * understands. The `default:` arm of any switch on `frame.type` MUST
 * drop unknown types silently rather than throw — the bridge stays
 * forward-compatible with backend deployments that ship new frame
 * variants ahead of the npm bridge update.
 */
export type ServerFrame = ControlFrame | AiReviewFrame;

/* --------------------------------------------------------------------
 * Client → server frames the watch subcommand sends
 * ------------------------------------------------------------------ */

/** First client frame post-`auth_required`: presents the one-shot ws_token. */
export interface AuthenticateRequestFrame extends FrameEnvelope {
  readonly type: "authenticate";
  readonly ws_token: string;
}

/** Sent in response to `reauth_required`: presents a freshly-minted ws_token. */
export interface ReauthRequestFrame extends FrameEnvelope {
  readonly type: "reauth";
  readonly ws_token: string;
}

/** Subscribes to one or more topic prefixes (or exact topic names). */
export interface SubscribeRequestFrame extends FrameEnvelope {
  readonly type: "subscribe";
  readonly topics: readonly string[];
}

/** Optional liveness probe; the server replies with `pong`. */
export interface PingRequestFrame extends FrameEnvelope {
  readonly type: "ping";
}

/**
 * Closed union of client-emitted frames the watch subcommand sends.
 * Other client frame types (unsubscribe, get_subscriptions) are not
 * needed for the watch subcommand; they are deliberately omitted to
 * keep the surface narrow.
 */
export type WatchClientFrame =
  | AuthenticateRequestFrame
  | ReauthRequestFrame
  | SubscribeRequestFrame
  | PingRequestFrame;

/* --------------------------------------------------------------------
 * Dedup helpers
 * ------------------------------------------------------------------ */

/**
 * AI-review dedup triple. The bridge keeps an LRU cache keyed on
 * this triple to drop server-side replays after reconnects.
 * `dispatch_version` is the primary discriminator; `type` and
 * `review_public_id` exist to disambiguate frames that share a
 * review across the three AI-review variants.
 */
export interface DedupKey {
  readonly type: string;
  readonly review_public_id: string;
  readonly dispatch_version: number;
}

/**
 * Helper: extract the dedup triple from any AI-review frame.
 * Non-AI frames return ``null`` — they don't participate in the
 * dedup contract.
 */
export function dedupKeyOf(frame: ServerFrame): DedupKey | null {
  if (
    frame.type === "ai_review.request" ||
    frame.type === "ai_review.decision_ack" ||
    frame.type === "ai_review.caps_violation"
  ) {
    return {
      type: frame.type,
      review_public_id: frame.review_public_id,
      dispatch_version: frame.dispatch_version,
    };
  }
  return null;
}
