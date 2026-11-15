import { describe, expect, it } from "vitest";

import {
  classifyActionableFrame,
  DEFAULT_WAKE_KINDS,
  isWakeKind,
  KIMI_EXIT_ATTENTION,
  KIMI_EXIT_DISABLED,
  KIMI_EXIT_DUPLICATE,
  KIMI_EXIT_EXPIRED,
  KIMI_EXIT_FAILED,
  KIMI_OUTCOME_LINES,
  parseWakeKind,
  SNAPPER_COPILOT_ATTENTION_LINE,
  SNAPPER_KIMI_ATTENTION_LINE,
  SNAPPER_WAKE_PROMPT,
  type WakeKind,
} from "../src/actionable.js";
import {
  ALL_CLIENTS,
  ClientArgError,
  isClientName,
  parseClientName,
  parseClientSelection,
  SUPPORTED_CLIENTS,
} from "../src/clients.js";
import type { ServerFrame } from "../src/types.js";

describe("clients", () => {
  it("lists all seven supported coding CLIs", () => {
    expect(SUPPORTED_CLIENTS).toEqual([
      "claude",
      "codex",
      "copilot",
      "antigravity",
      "kimi",
      "grok",
      "cursor",
    ]);
    expect(ALL_CLIENTS).toBe(SUPPORTED_CLIENTS);
    for (const cli of SUPPORTED_CLIENTS) {
      expect(isClientName(cli)).toBe(true);
      expect(parseClientName(`  ${cli.toUpperCase()}  `)).toBe(cli);
    }
    expect(isClientName("unknown-cli")).toBe(false);
  });

  it("parses single, list, deduplicated, and 'all' client selections", () => {
    expect(parseClientSelection("all")).toEqual(SUPPORTED_CLIENTS);
    expect(parseClientSelection(["claude", "ALL"])).toEqual(SUPPORTED_CLIENTS);
    expect(parseClientSelection(["codex", "grok", "codex"])).toEqual([
      "codex",
      "grok",
    ]);
    expect(parseClientSelection("cursor")).toEqual(["cursor"]);
  });

  it("throws ClientArgError on empty or unsupported client names", () => {
    expect(() => parseClientName("vim")).toThrow(ClientArgError);
    expect(() => parseClientSelection([])).toThrow(ClientArgError);
    expect(() => parseClientSelection(["claude", "emacs"])).toThrow(ClientArgError);
  });
});

describe("actionable classification and wake prompts", () => {
  it("parses valid wake kinds and rejects unknown kinds", () => {
    expect(isWakeKind("ai_review")).toBe(true);
    expect(isWakeKind("bogus")).toBe(false);
    expect(parseWakeKind("  ORDER_EVENT ")).toBe("order_event");
    expect(parseWakeKind("signal")).toBe("signal");
    expect(() => parseWakeKind("heartbeat")).toThrow(/unsupported --wake-on/);
  });

  it("classifies actionable frames and suppresses decision_ack echoes", () => {
    const reviewReq = {
      type: "ai_review.request",
      review_public_id: "rev_1",
      dispatch_version: 1,
      timestamp: "2026-11-15T12:00:00Z",
      deadline: "2026-11-15T12:05:00Z",
    } as unknown as ServerFrame;
    const researchReq = {
      type: "ai_research.request",
      round_public_id: "rnd_1",
      timestamp: "2026-11-15T12:00:00Z",
    } as unknown as ServerFrame;
    const capsViol = {
      type: "ai_review.caps_violation",
      review_public_id: "rev_1",
      dispatch_version: 1,
    } as unknown as ServerFrame;
    const ackFrame = {
      type: "ai_review.decision_ack",
      review_public_id: "rev_1",
      dispatch_version: 1,
    } as unknown as ServerFrame;
    const orderEvt = {
      type: "order_event",
      order_id: "ord_1",
    } as unknown as ServerFrame;
    const sigFrame = {
      type: "signal",
      symbol: "BTC-EUR",
    } as unknown as ServerFrame;
    const pongFrame = {
      type: "pong",
    } as unknown as ServerFrame;

    expect(classifyActionableFrame(reviewReq)).toBe("ai_review");
    expect(classifyActionableFrame(researchReq)).toBe("ai_research");
    expect(classifyActionableFrame(capsViol)).toBe("caps_violation");
    expect(classifyActionableFrame(ackFrame)).toBeNull();
    expect(classifyActionableFrame(orderEvt)).toBeNull();
    expect(classifyActionableFrame(sigFrame)).toBeNull();
    expect(classifyActionableFrame(pongFrame)).toBeNull();

    const custom = new Set<WakeKind>([...DEFAULT_WAKE_KINDS, "order_event", "signal"]);
    expect(classifyActionableFrame(orderEvt, custom)).toBe("order_event");
    expect(classifyActionableFrame(sigFrame, custom)).toBe("signal");
    expect(classifyActionableFrame(reviewReq, new Set<WakeKind>())).toBeNull();
    expect(classifyActionableFrame(researchReq, new Set<WakeKind>())).toBeNull();
    expect(classifyActionableFrame(capsViol, new Set<WakeKind>())).toBeNull();
  });

  it("exposes content-free prompts and deterministic Kimi exit outcomes", () => {
    expect(SNAPPER_WAKE_PROMPT).toContain("untrusted data");
    expect(SNAPPER_COPILOT_ATTENTION_LINE).toContain("actionable activity");
    expect(SNAPPER_KIMI_ATTENTION_LINE).toContain("replacement watcher");
    expect(KIMI_EXIT_ATTENTION).toBe(0);
    expect(KIMI_OUTCOME_LINES[KIMI_EXIT_DISABLED]).toContain("Do not start another");
    expect(KIMI_OUTCOME_LINES[KIMI_EXIT_DUPLICATE]).toContain("Do not start another");
    expect(KIMI_OUTCOME_LINES[KIMI_EXIT_FAILED]).toContain("snapper-mcp doctor");
    expect(KIMI_OUTCOME_LINES[KIMI_EXIT_EXPIRED]).toContain("24-hour");
  });
});
