import { describe, expect, it } from "vitest";

import {
  AiReviewCapsViolationFrame,
  AiReviewDecisionAckFrame,
  AiReviewRequestFrame,
  ServerFrame,
  SignalFrame,
  dedupKeyOf,
} from "../src/types.js";

describe("dedupKeyOf", () => {
  it("returns the (type, review_public_id, dispatch_version) triple for ai_review.request", () => {
    const frame: AiReviewRequestFrame = {
      type: "ai_review.request",
      review_public_id: "rev-1",
      user_public_id: "user-1",
      strategy_public_id: "strat-1",
      wallet_public_id: "wal-1",
      instrument_public_id: "inst-1",
      dispatch_version: 7,
      selected_delegate_public_id: "delegate-1",
    };
    expect(dedupKeyOf(frame)).toEqual({
      type: "ai_review.request",
      review_public_id: "rev-1",
      dispatch_version: 7,
    });
  });

  it("returns the dedup triple for ai_review.decision_ack", () => {
    const frame: AiReviewDecisionAckFrame = {
      type: "ai_review.decision_ack",
      review_public_id: "rev-2",
      user_public_id: "user-1",
      strategy_public_id: "strat-1",
      wallet_public_id: "wal-1",
      instrument_public_id: "inst-1",
      dispatch_version: 1,
      decision: "approve",
    };
    expect(dedupKeyOf(frame)).toEqual({
      type: "ai_review.decision_ack",
      review_public_id: "rev-2",
      dispatch_version: 1,
    });
  });

  it("returns the dedup triple for ai_review.caps_violation", () => {
    const frame: AiReviewCapsViolationFrame = {
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

  it("returns null for non-AI-review frames (signals + order events have their own keys)", () => {
    const signalFrame: SignalFrame = {
      type: "signal",
      topic: "signals.kraken.BTC-USD.rsi",
      signal_public_id: "sig-1",
      timestamp: "2026-04-27T10:00:00Z",
      payload: {},
    };
    expect(dedupKeyOf(signalFrame)).toBeNull();
  });

  it("returns null for control frames", () => {
    const reauth: ServerFrame = {
      type: "reauth_required",
      deadline: "2026-04-27T10:05:00Z",
    };
    const success: ServerFrame = { type: "subscription_success", topics: ["signals."] };
    const heartbeat: ServerFrame = { type: "system.heartbeat", seq: 7 };
    const error: ServerFrame = { type: "error", message: "x" };
    expect(dedupKeyOf(reauth)).toBeNull();
    expect(dedupKeyOf(success)).toBeNull();
    expect(dedupKeyOf(heartbeat)).toBeNull();
    expect(dedupKeyOf(error)).toBeNull();
  });

  it("returns null for order_event frames (single-underscore discriminator)", () => {
    const orderEvent: ServerFrame = {
      type: "order_event",
      topic: "orders.events.kraken.BTC-USD.executed",
      payload: { client_order_id: "cid-1" },
    };
    expect(dedupKeyOf(orderEvent)).toBeNull();
  });

  it("two frames with the same triple produce equal dedup keys (LRU cache lookup contract)", () => {
    const a: AiReviewRequestFrame = {
      type: "ai_review.request",
      review_public_id: "rev-X",
      user_public_id: "user-1",
      strategy_public_id: "strat-1",
      wallet_public_id: "wal-1",
      instrument_public_id: "inst-1",
      dispatch_version: 1,
      selected_delegate_public_id: "delegate-1",
    };
    const b: AiReviewRequestFrame = {
      type: "ai_review.request",
      review_public_id: "rev-X",
      user_public_id: "user-2",
      strategy_public_id: "strat-different",
      wallet_public_id: "wal-different",
      instrument_public_id: "inst-different",
      dispatch_version: 1,
      selected_delegate_public_id: "delegate-different",
    };
    expect(dedupKeyOf(a)).toEqual(dedupKeyOf(b));
  });

  it("frames with different dispatch_version produce different dedup keys (replays vs new)", () => {
    const v1: AiReviewRequestFrame = {
      type: "ai_review.request",
      review_public_id: "rev-X",
      user_public_id: "user-1",
      strategy_public_id: "strat-1",
      wallet_public_id: "wal-1",
      instrument_public_id: "inst-1",
      dispatch_version: 1,
      selected_delegate_public_id: "delegate-1",
    };
    const v2: AiReviewRequestFrame = { ...v1, dispatch_version: 2 };
    expect(dedupKeyOf(v1)).not.toEqual(dedupKeyOf(v2));
  });
});
