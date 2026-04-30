/**
 * Error types for the bridge.
 *
 * Scope:
 *
 *   (a) Transport-layer errors emitted by Snapper's middleware
 *       BEFORE the request reaches a tool. The SDK surfaces these
 *       via its own protocol machinery (`McpError`,
 *       `CallToolResult.isError`); the bridge passes them through
 *       to the MCP host verbatim.
 *
 *   (b) Tool-layer errors are passed through as
 *       `CallToolResult.isError=true` by design. No bridge mapping.
 *
 *   (c) ws_token mint failures (HTTP / network / malformed body)
 *       throw `AuthFailedError` from `ws_token.ts`. The watch
 *       reconnect loop handles them by logging + backing off.
 *
 *   (d) SDK / transport-construction pre-initialize failures throw
 *       `BridgeStartupError` from `index.ts` so a stdio-attach
 *       failure surfaces with a fatal stderr line before the bridge
 *       publishes itself to the MCP host.
 */

export { EnvValidationError } from "./env.js";

export class AuthFailedError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AuthFailedError";
  }
}

export class BridgeStartupError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "BridgeStartupError";
  }
}
