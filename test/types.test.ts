import { describe, expect, it } from "vitest";

import type { FrameEnvelope } from "../src/envelope.js";
import type {
  AiReviewCapsViolationFrame,
  AiReviewDecisionAckFrame,
  AiReviewRequestFrame,
  AuthCompleteFrame,
  AuthExpiredFrame,
  AuthFailedFrame,
  AuthOkFrame,
  AuthRequiredFrame,
  ErrorFrame,
  OrderEventFrame,
  PongFrame,
  ReauthOkFrame,
  ReauthRequiredFrame,
  ServerFrame,
  SignalFrame,
  SubscriptionSuccessFrame,
} from "../src/types.js";
import { dedupKeyOf } from "../src/types.js";

const ENVELOPE: FrameEnvelope = {
  session_id: "sess-server-1",
  sequence_id: 1,
  public_id: "01933b00-0000-7000-8000-000000000001",
  timestamp: "2026-04-27T10:00:00.000Z",
};

const AI_REQUEST_PAYLOAD_FIELDS = {
  deadline: "2026-04-27T10:05:00.000Z",
  signal_envelope: {} as Readonly<Record<string, unknown>>,
  instrument_metadata: {} as Readonly<Record<string, unknown>>,
} as const;

const AI_DECISION_ACK_PAYLOAD_FIELDS = {
  responding_delegate_public_id: "delegate-1",
  new_status: "resolved_approved",
  resolution_mode: "pick_one_primary",
  rationale: null,
} as const;

describe("dedupKeyOf — AI-review frames", () => {
  it("returns the (type, review_public_id, dispatch_version) triple for ai_review.request", () => {
    const frame: AiReviewRequestFrame = {
      ...ENVELOPE,
      type: "ai_review.request",
      review_public_id: "rev-1",
      user_public_id: "user-1",
      strategy_public_id: "strat-1",
      wallet_public_id: "wal-1",
      instrument_public_id: "inst-1",
      dispatch_version: 7,
      selected_delegate_public_id: "delegate-1",
      ...AI_REQUEST_PAYLOAD_FIELDS,
    };
    expect(dedupKeyOf(frame)).toEqual({
      type: "ai_review.request",
      review_public_id: "rev-1",
      dispatch_version: 7,
    });
  });

  it("returns the dedup triple for ai_review.decision_ack", () => {
    const frame: AiReviewDecisionAckFrame = {
      ...ENVELOPE,
      type: "ai_review.decision_ack",
      review_public_id: "rev-2",
      user_public_id: "user-1",
      strategy_public_id: "strat-1",
      wallet_public_id: "wal-1",
      instrument_public_id: "inst-1",
      dispatch_version: 1,
      decision: "approve",
      ...AI_DECISION_ACK_PAYLOAD_FIELDS,
    };
    expect(dedupKeyOf(frame)).toEqual({
      type: "ai_review.decision_ack",
      review_public_id: "rev-2",
      dispatch_version: 1,
    });
  });

  it("returns the dedup triple for ai_review.caps_violation", () => {
    const frame: AiReviewCapsViolationFrame = {
      ...ENVELOPE,
      type: "ai_review.caps_violation",
      review_public_id: "rev-3",
      user_public_id: "user-1",
      strategy_public_id: "strat-1",
      wallet_public_id: "wal-1",
      instrument_public_id: "inst-1",
      dispatch_version: 2,
      cap_type: "max_open_orders",
      attempted: 6,
      limit: 5,
    };
    expect(dedupKeyOf(frame)).toEqual({
      type: "ai_review.caps_violation",
      review_public_id: "rev-3",
      dispatch_version: 2,
    });
  });

  it("two frames with the same triple produce equal dedup keys (LRU cache lookup contract)", () => {
    const a: AiReviewRequestFrame = {
      ...ENVELOPE,
      type: "ai_review.request",
      review_public_id: "rev-X",
      user_public_id: "user-1",
      strategy_public_id: "strat-1",
      wallet_public_id: "wal-1",
      instrument_public_id: "inst-1",
      dispatch_version: 1,
      selected_delegate_public_id: "delegate-1",
      ...AI_REQUEST_PAYLOAD_FIELDS,
    };
    const b: AiReviewRequestFrame = {
      ...ENVELOPE,
      type: "ai_review.request",
      review_public_id: "rev-X",
      user_public_id: "user-2",
      strategy_public_id: "strat-different",
      wallet_public_id: "wal-different",
      instrument_public_id: "inst-different",
      dispatch_version: 1,
      selected_delegate_public_id: "delegate-different",
      ...AI_REQUEST_PAYLOAD_FIELDS,
    };
    expect(dedupKeyOf(a)).toEqual(dedupKeyOf(b));
  });

  it("frames with different dispatch_version produce different dedup keys (replays vs new)", () => {
    const v1: AiReviewRequestFrame = {
      ...ENVELOPE,
      type: "ai_review.request",
      review_public_id: "rev-X",
      user_public_id: "user-1",
      strategy_public_id: "strat-1",
      wallet_public_id: "wal-1",
      instrument_public_id: "inst-1",
      dispatch_version: 1,
      selected_delegate_public_id: "delegate-1",
      ...AI_REQUEST_PAYLOAD_FIELDS,
    };
    const v2: AiReviewRequestFrame = { ...v1, dispatch_version: 2 };
    expect(dedupKeyOf(v1)).not.toEqual(dedupKeyOf(v2));
  });
});

describe("dedupKeyOf — control frames return null", () => {
  it("returns null for auth_required", () => {
    const frame: AuthRequiredFrame = { ...ENVELOPE, type: "auth_required", timeout: 10 };
    expect(dedupKeyOf(frame)).toBeNull();
  });

  it("returns null for auth_ok", () => {
    const frame: AuthOkFrame = { ...ENVELOPE, type: "auth_ok", exp: "2026-04-27T10:05:00Z" };
    expect(dedupKeyOf(frame)).toBeNull();
  });

  it("returns null for auth_complete (with null session_expires_at)", () => {
    const frame: AuthCompleteFrame = {
      ...ENVELOPE,
      type: "auth_complete",
      available_topics: ["signals.", "orders.events."],
      user_role: "operator",
      session_expires_at: null,
      ws_token_exp: "2026-04-27T10:05:00Z",
    };
    expect(dedupKeyOf(frame)).toBeNull();
  });

  it("returns null for auth_failed (with null reason)", () => {
    const frame: AuthFailedFrame = { ...ENVELOPE, type: "auth_failed", reason: null };
    expect(dedupKeyOf(frame)).toBeNull();
  });

  it("returns null for auth_failed (with non-null reason)", () => {
    const frame: AuthFailedFrame = {
      ...ENVELOPE,
      type: "auth_failed",
      reason: "ws_token replay",
    };
    expect(dedupKeyOf(frame)).toBeNull();
  });

  it("returns null for reauth_required", () => {
    const frame: ReauthRequiredFrame = {
      ...ENVELOPE,
      type: "reauth_required",
      deadline: "2026-04-27T10:04:00Z",
    };
    expect(dedupKeyOf(frame)).toBeNull();
  });

  it("returns null for reauth_ok", () => {
    const frame: ReauthOkFrame = {
      ...ENVELOPE,
      type: "reauth_ok",
      exp: "2026-04-27T10:10:00Z",
    };
    expect(dedupKeyOf(frame)).toBeNull();
  });

  it("returns null for auth_expired", () => {
    const frame: AuthExpiredFrame = { ...ENVELOPE, type: "auth_expired" };
    expect(dedupKeyOf(frame)).toBeNull();
  });

  it("returns null for subscription_success (with null message and explicit denied_topics + active_subscriptions)", () => {
    const frame: SubscriptionSuccessFrame = {
      ...ENVELOPE,
      type: "subscription_success",
      action: "subscribe",
      status: "subscribed",
      topics: ["signals."],
      denied_topics: [],
      active_subscriptions: ["signals."],
      message: null,
    };
    expect(dedupKeyOf(frame)).toBeNull();
  });

  it("returns null for subscription_success status=denied with denied_topics populated", () => {
    const frame: SubscriptionSuccessFrame = {
      ...ENVELOPE,
      type: "subscription_success",
      action: "subscribe",
      status: "denied",
      topics: [],
      denied_topics: ["admin."],
      active_subscriptions: [],
      message: "permission denied for admin.",
    };
    expect(dedupKeyOf(frame)).toBeNull();
  });

  it("returns null for pong", () => {
    const frame: PongFrame = {
      ...ENVELOPE,
      type: "pong",
      timestamp: "2026-04-27T10:00:00Z",
      active_connections: 1,
    };
    expect(dedupKeyOf(frame)).toBeNull();
  });

  it("returns null for error", () => {
    const frame: ErrorFrame = {
      ...ENVELOPE,
      type: "error",
      message: "invalid frame",
    };
    expect(dedupKeyOf(frame)).toBeNull();
  });

  it("returns null for signal (generic data frames don't carry the AI-review dedup triple)", () => {
    const frame: SignalFrame = {
      ...ENVELOPE,
      type: "signal",
      instrument: "BTC-USD",
      exchange: "kraken",
      side: "buy",
      strength: 0.75,
      reason: "rsi crossed 30",
      price: null,
      strategy_name: null,
      fired_at: "2026-04-27T10:00:00Z",
      wallet_public_id: "wal-1",
      operator_public_id: null,
      user_public_id: null,
    };
    expect(dedupKeyOf(frame)).toBeNull();
  });

  it("returns null for order_event (generic data frames don't carry the AI-review dedup triple)", () => {
    const frame: OrderEventFrame = {
      ...ENVELOPE,
      type: "order_event",
      exchange_order_id: "exch-1",
      client_order_id: "cli-1",
      exchange: "kraken",
      instrument: "BTC-USD",
      event: "submitted",
      reason: null,
      wallet_public_id: "wal-1",
      operator_public_id: null,
      user_public_id: null,
    };
    expect(dedupKeyOf(frame)).toBeNull();
  });
});

describe("ServerFrame discriminator coverage", () => {
  it("dedupKeyOf handles every ControlFrame variant via the type guard", () => {
    const frames: ServerFrame[] = [
      { ...ENVELOPE, type: "auth_required", timeout: 10 },
      { ...ENVELOPE, type: "auth_ok", exp: "2026-04-27T10:05:00Z" },
      {
        ...ENVELOPE,
        type: "auth_complete",
        available_topics: [],
        user_role: "operator",
        session_expires_at: null,
        ws_token_exp: "2026-04-27T10:05:00Z",
      },
      { ...ENVELOPE, type: "auth_failed", reason: null },
      { ...ENVELOPE, type: "reauth_required", deadline: "2026-04-27T10:04:00Z" },
      { ...ENVELOPE, type: "reauth_ok", exp: "2026-04-27T10:10:00Z" },
      { ...ENVELOPE, type: "auth_expired" },
      {
        ...ENVELOPE,
        type: "subscription_success",
        action: "subscribe",
        status: "subscribed",
        topics: ["signals."],
        denied_topics: [],
        active_subscriptions: ["signals."],
        message: null,
      },
      {
        ...ENVELOPE,
        type: "pong",
        timestamp: "2026-04-27T10:00:00Z",
        active_connections: 0,
      },
      { ...ENVELOPE, type: "error", message: "x" },
      {
        ...ENVELOPE,
        type: "signal",
        instrument: "BTC-USD",
        exchange: "kraken",
        side: "buy",
        strength: 1,
        reason: "rsi crossed 30",
        price: null,
        strategy_name: null,
        fired_at: "2026-04-27T10:00:00Z",
        wallet_public_id: "wal-1",
        operator_public_id: null,
        user_public_id: null,
      },
      {
        ...ENVELOPE,
        type: "order_event",
        exchange_order_id: "exch-1",
        client_order_id: "cli-1",
        exchange: "kraken",
        instrument: "BTC-USD",
        event: "submitted",
        reason: null,
        wallet_public_id: "wal-1",
        operator_public_id: null,
        user_public_id: null,
      },
    ];
    for (const frame of frames) {
      expect(dedupKeyOf(frame)).toBeNull();
    }
  });
});
