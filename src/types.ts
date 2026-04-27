/**
 * Wire-contract types for the Snapper WebSocket push surface.
 *
 * These types are the bridge-side source-of-truth for frames that
 * arrive on `wss://.../api/ws` once the upcoming `snapper-mcp watch`
 * subcommand subscribes. Frames are JSON objects discriminated by
 * the `type` field; the bridge `default:` switch arm drops unknown
 * types silently so the bridge stays forward-compatible when the
 * Snapper backend adds new frame variants.
 *
 * The bridge keeps a narrow local mirror of the frame schemas so it
 * can ship without a build-time dependency on the Snapper frontend's
 * generated TypeScript bundle. The fields modelled here are the
 * subset the watch subcommand cares about; any extra envelope or
 * payload fields the server emits are preserved by the JSON
 * passthrough but not statically typed here.
 *
 * Schema highlights:
 *
 *   - Control frames carry transport-layer routing fields where
 *     applicable (e.g. `reauth_required` includes the `deadline` by
 *     which the client MUST re-authenticate).
 *   - All AI-review data frames carry the dedup triple
 *     (`type`, `review_public_id`, `dispatch_version`) so consumers
 *     can drop server-side replays after reconnects.
 *   - Numeric `dispatch_version` increments monotonically per
 *     review and is the bridge's primary dedup key.
 */

/** Discriminator union for control frames the server emits to the client. */
export type ControlFrameType =
  | "subscription_success"
  | "subscription_error"
  | "reauth_required"
  | "auth_expired"
  | "system.heartbeat"
  | "error";

/** Subscription ACK after the client sends a `{type: "subscribe", topics: [...]}` frame. */
export interface SubscriptionSuccessFrame {
  readonly type: "subscription_success";
  readonly topics: readonly string[];
  readonly denied_topics?: readonly string[];
}

/** Server rejected the subscription request. */
export interface SubscriptionErrorFrame {
  readonly type: "subscription_error";
  readonly errors: readonly string[];
}

/**
 * Server signals the client must fetch a fresh `ws_token` and
 * re-`authenticate` before ``deadline``. The client SHOULD respond
 * before the deadline; failure to do so triggers `auth_expired` and
 * the WS session is closed.
 */
export interface ReauthRequiredFrame {
  readonly type: "reauth_required";
  readonly deadline: string;
}

/** Server expired the WS session — client must reconnect from scratch. */
export interface AuthExpiredFrame {
  readonly type: "auth_expired";
}

/** Server-initiated keep-alive. The client is expected to respond. */
export interface SystemHeartbeatFrame {
  readonly type: "system.heartbeat";
  readonly seq?: number;
  readonly ts?: string;
}

/** Generic transport-layer error frame. */
export interface ErrorFrame {
  readonly type: "error";
  readonly error_code?: string;
  readonly message?: string;
}

export type ControlFrame =
  | SubscriptionSuccessFrame
  | SubscriptionErrorFrame
  | ReauthRequiredFrame
  | AuthExpiredFrame
  | SystemHeartbeatFrame
  | ErrorFrame;

/** AI-review request frame: server publishes when a delegate is asked to review a candidate signal. */
export interface AiReviewRequestFrame {
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
export interface AiReviewDecisionAckFrame {
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
export interface AiReviewCapsViolationFrame {
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
 * Strategy-emitted signal frame on `signals.<exchange>.<symbol>.<rule>`
 * topics. Snapper backend publishes via
 * `snapper.messaging.schemas.data.SignalData`.
 */
export interface SignalFrame {
  readonly type: "signal";
  readonly topic: string;
  readonly signal_public_id: string;
  readonly timestamp: string;
  readonly payload: Record<string, unknown>;
}

/**
 * Order-lifecycle event frame on
 * `orders.events.<exchange>.<symbol>.<event>` topics. The
 * discriminator MUST stay as ``order_event`` (single underscore) to
 * match the Snapper backend's wire contract; using a dotted form
 * like ``order.event`` would silently drop real order events through
 * the bridge's ``default:`` switch arm.
 */
export interface OrderEventFrame {
  readonly type: "order_event";
  readonly topic: string;
  readonly payload: Record<string, unknown>;
}

/**
 * Closed union of every frame the bridge currently understands. The
 * `default:` arm of any switch on `frame.type` MUST drop unknown
 * types silently rather than throw — the bridge stays forward-
 * compatible with Snapper deployments that ship new frame variants
 * ahead of the npm bridge update.
 */
export type ServerFrame = ControlFrame | AiReviewFrame | SignalFrame | OrderEventFrame;

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
 * dedup contract (signals + order events have their own
 * `signal_public_id` / `client_order_id` keys).
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
