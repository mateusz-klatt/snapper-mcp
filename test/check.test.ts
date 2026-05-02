import { describe, expect, it } from "vitest";

import { checkMain } from "../src/check.js";

const VALID_BASE_URL = "https://snapper.example.com/api/mcp";

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll(/=+$/g, "");
}

function makeJwt(payload: Record<string, unknown>, header: Record<string, unknown> = { alg: "HS256", typ: "JWT" }): string {
  const headerB64 = encodeBase64Url(JSON.stringify(header));
  const payloadB64 = encodeBase64Url(JSON.stringify(payload));
  return `${headerB64}.${payloadB64}.signature-not-verified`;
}

class WriteSink {
  written: string[] = [];

  write = (data: string | Uint8Array): boolean => {
    this.written.push(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
    return true;
  };

  text(): string {
    return this.written.join("");
  }
}

function fakeStreams(): { stdout: WriteSink; stderr: WriteSink } {
  return { stdout: new WriteSink(), stderr: new WriteSink() };
}

describe("checkMain", () => {
  it("decodes a valid token and returns 0 with operator-relevant claims", async () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const past = Math.floor(Date.now() / 1000) - 60;
    const token = makeJwt({
      sub: "user-pid-123",
      iss: "snapper",
      aud: "ai-delegate",
      role: "AI_DELEGATE",
      scopes: ["read.orders", "write.orders"],
      iat: past,
      exp: future,
    });
    const { stdout, stderr } = fakeStreams();
    const code = await checkMain({
      argv: [],
      stdout,
      stderr,
      env: { SNAPPER_BASE_URL: VALID_BASE_URL, SNAPPER_ACCESS_TOKEN: token },
    });
    expect(code).toBe(0);
    expect(stdout.text()).toContain("base URL: https://snapper.example.com/api/mcp/");
    expect(stdout.text()).toContain("sub: user-pid-123");
    expect(stdout.text()).toContain("role: AI_DELEGATE");
    expect(stdout.text()).toContain("scopes: read.orders, write.orders");
    expect(stdout.text()).toContain("status: valid");
    expect(stderr.text()).toBe("");
  });

  it("returns 2 when the token is already expired", async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    const token = makeJwt({ sub: "user-pid", exp: past });
    const { stdout, stderr } = fakeStreams();
    const code = await checkMain({
      argv: [],
      stdout,
      stderr,
      env: { SNAPPER_BASE_URL: VALID_BASE_URL, SNAPPER_ACCESS_TOKEN: token },
    });
    expect(code).toBe(2);
    expect(stdout.text()).toContain("status: EXPIRED");
    expect(stderr.text()).toBe("");
  });

  it("returns 2 when the token has no exp claim", async () => {
    const token = makeJwt({ sub: "user-pid" });
    const { stdout, stderr } = fakeStreams();
    const code = await checkMain({
      argv: [],
      stdout,
      stderr,
      env: { SNAPPER_BASE_URL: VALID_BASE_URL, SNAPPER_ACCESS_TOKEN: token },
    });
    expect(code).toBe(2);
    expect(stdout.text()).toContain("exp: <missing>");
  });

  it("returns 1 when the token is not a parseable JWT", async () => {
    const { stdout, stderr } = fakeStreams();
    const code = await checkMain({
      argv: [],
      stdout,
      stderr,
      env: { SNAPPER_BASE_URL: VALID_BASE_URL, SNAPPER_ACCESS_TOKEN: "not-a-jwt" },
    });
    expect(code).toBe(1);
    expect(stderr.text()).toContain("not a parseable JWT");
  });

  it("returns 1 when SNAPPER_BASE_URL is missing", async () => {
    const token = makeJwt({ sub: "user-pid", exp: Math.floor(Date.now() / 1000) + 3600 });
    const { stdout, stderr } = fakeStreams();
    const code = await checkMain({
      argv: [],
      stdout,
      stderr,
      env: { SNAPPER_ACCESS_TOKEN: token },
    });
    expect(code).toBe(1);
    expect(stderr.text()).toContain("Missing required SNAPPER_BASE_URL");
  });

  it("returns 1 when SNAPPER_ACCESS_TOKEN is missing", async () => {
    const { stdout, stderr } = fakeStreams();
    const code = await checkMain({
      argv: [],
      stdout,
      stderr,
      env: { SNAPPER_BASE_URL: VALID_BASE_URL },
    });
    expect(code).toBe(1);
    expect(stderr.text()).toContain("Missing required SNAPPER_ACCESS_TOKEN");
  });

  it("accepts the token via --access-token CLI flag", async () => {
    const token = makeJwt({ sub: "user-pid", exp: Math.floor(Date.now() / 1000) + 3600 });
    const { stdout } = fakeStreams();
    const code = await checkMain({
      argv: ["--access-token", token, "--base-url", VALID_BASE_URL],
      stdout,
      stderr: new WriteSink(),
      env: {},
    });
    expect(code).toBe(0);
    expect(stdout.text()).toContain("status: valid");
  });
});
