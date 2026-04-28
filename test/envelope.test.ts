import { describe, expect, it } from "vitest";

import { EnvelopeMinter, type FrameEnvelope, uuidv7 } from "../src/envelope.js";

const ISO_8601_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("EnvelopeMinter — defaults", () => {
  it("generates a stable session_id across all next() calls", () => {
    const minter = new EnvelopeMinter();
    const a = minter.next();
    const b = minter.next();
    const c = minter.next("telemetry");
    expect(a.session_id).toBe(b.session_id);
    expect(b.session_id).toBe(c.session_id);
    expect(minter.sessionId).toBe(a.session_id);
  });

  it("session_id defaults to a fresh UUID per minter instance", () => {
    const a = new EnvelopeMinter();
    const b = new EnvelopeMinter();
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(a.sessionId).toMatch(UUID_V7_PATTERN);
    expect(b.sessionId).toMatch(UUID_V7_PATTERN);
  });

  it("accepts an operator-supplied sessionId override", () => {
    const minter = new EnvelopeMinter({ sessionId: "operator-supplied-sid" });
    expect(minter.sessionId).toBe("operator-supplied-sid");
    expect(minter.next().session_id).toBe("operator-supplied-sid");
  });
});

describe("EnvelopeMinter — sequence_id", () => {
  it("control counter advances 1, 2, 3 across consecutive control frames", () => {
    const minter = new EnvelopeMinter();
    expect(minter.next("control").sequence_id).toBe(1);
    expect(minter.next("control").sequence_id).toBe(2);
    expect(minter.next("control").sequence_id).toBe(3);
    expect(minter.controlSequence).toBe(3);
  });

  it("telemetry counter advances independently of control counter", () => {
    const minter = new EnvelopeMinter();
    expect(minter.next("control").sequence_id).toBe(1);
    expect(minter.next("telemetry").sequence_id).toBe(1);
    expect(minter.next("control").sequence_id).toBe(2);
    expect(minter.next("telemetry").sequence_id).toBe(2);
    expect(minter.next("telemetry").sequence_id).toBe(3);
    expect(minter.controlSequence).toBe(2);
    expect(minter.telemetrySequence).toBe(3);
  });

  it("defaults the counter to 'control' when none is supplied", () => {
    const minter = new EnvelopeMinter();
    expect(minter.next().sequence_id).toBe(1);
    expect(minter.next().sequence_id).toBe(2);
    expect(minter.controlSequence).toBe(2);
    expect(minter.telemetrySequence).toBe(0);
  });
});

describe("EnvelopeMinter — public_id", () => {
  it("mints a fresh UUID per next() call (no repeats across the same minter)", () => {
    const minter = new EnvelopeMinter();
    const ids = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      ids.add(minter.next().public_id);
    }
    expect(ids.size).toBe(50);
    for (const id of ids) {
      expect(id).toMatch(UUID_V7_PATTERN);
    }
  });

  it("public_id is independent of sessionId override (still a fresh UUID)", () => {
    const minter = new EnvelopeMinter({ sessionId: "fixed-sid" });
    const a = minter.next();
    const b = minter.next();
    expect(a.public_id).not.toBe(b.public_id);
    expect(a.public_id).toMatch(UUID_V7_PATTERN);
    expect(b.public_id).toMatch(UUID_V7_PATTERN);
    expect(a.public_id).not.toBe("fixed-sid");
  });
});

describe("EnvelopeMinter — timestamp", () => {
  it("stamps an ISO 8601 UTC datetime with millisecond precision", () => {
    const before = Date.now();
    const env = new EnvelopeMinter().next();
    const after = Date.now();
    expect(env.timestamp).toMatch(ISO_8601_PATTERN);
    const parsed = Date.parse(env.timestamp);
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });

  it("subsequent calls produce timestamps in non-decreasing order", () => {
    const minter = new EnvelopeMinter();
    const t1 = Date.parse(minter.next().timestamp);
    const t2 = Date.parse(minter.next().timestamp);
    expect(t2).toBeGreaterThanOrEqual(t1);
  });
});

describe("EnvelopeMinter — topic field", () => {
  it("returns topic: null on every minted envelope (bridge does not broadcast)", () => {
    const minter = new EnvelopeMinter();
    expect(minter.next().topic).toBeNull();
    expect(minter.next("control").topic).toBeNull();
    expect(minter.next("telemetry").topic).toBeNull();
  });

  it("envelope carries exactly the 5 expected wire-contract fields", () => {
    const env = new EnvelopeMinter().next();
    expect(new Set(Object.keys(env))).toEqual(
      new Set(["session_id", "sequence_id", "public_id", "timestamp", "topic"]),
    );
  });
});

describe("uuidv7 — RFC 9562 invariants", () => {
  it("encodes the current millisecond timestamp into the first 48 bits (sortable across mints)", () => {
    const before = Date.now();
    const id = uuidv7();
    const after = Date.now();
    const tsHex = `${id.slice(0, 8)}${id.slice(9, 13)}`;
    const tsMs = Number(BigInt(`0x${tsHex}`));
    expect(tsMs).toBeGreaterThanOrEqual(before);
    expect(tsMs).toBeLessThanOrEqual(after);
  });

  it("sets the version nibble to 7 (per RFC 9562)", () => {
    for (let i = 0; i < 20; i += 1) {
      const id = uuidv7();
      expect(id[14]).toBe("7");
    }
  });

  it("sets the variant nibble to 8/9/a/b (per RFC 9562)", () => {
    for (let i = 0; i < 20; i += 1) {
      const id = uuidv7();
      expect(id[19]).toMatch(/^[89ab]$/i);
    }
  });

  it("ids minted at later times sort lexicographically AFTER ids minted earlier (timestamp-prefix property)", async () => {
    const earlier = uuidv7();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const later = uuidv7();
    expect(later > earlier).toBe(true);
  });
});

describe("FrameEnvelope shape", () => {
  it("returned envelope has exactly the five expected fields including topic", () => {
    const env = new EnvelopeMinter().next();
    const keys = Object.keys(env).sort((a, b) => a.localeCompare(b));
    expect(keys).toEqual(["public_id", "sequence_id", "session_id", "timestamp", "topic"]);
  });

  it("FrameEnvelope is structurally assignable from a fresh envelope", () => {
    const env: FrameEnvelope = new EnvelopeMinter().next();
    expect(typeof env.session_id).toBe("string");
    expect(typeof env.sequence_id).toBe("number");
    expect(typeof env.public_id).toBe("string");
    expect(typeof env.timestamp).toBe("string");
  });
});
