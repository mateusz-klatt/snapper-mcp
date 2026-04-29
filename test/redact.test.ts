import { describe, expect, it } from "vitest";

import { redactToken } from "../src/env.js";

describe("redactToken", () => {
  it("redacts JWT-shaped values while keeping their length and suffix visible", () => {
    const token = `${"a".repeat(24)}.${"b".repeat(24)}.${"c".repeat(24)}`;
    expect(redactToken(token)).toBe(`<jwt-${token.length}-chars-ending-cccccccc>`);
  });

  it("leaves short non-token strings unchanged", () => {
    expect(redactToken("not-a-token")).toBe("not-a-token");
  });

  it("leaves URLs unchanged", () => {
    const value = "https://snapper.example.com/api/mcp";
    expect(redactToken(value)).toBe(value);
  });

  it("leaves empty strings unchanged", () => {
    expect(redactToken("")).toBe("");
  });
});
