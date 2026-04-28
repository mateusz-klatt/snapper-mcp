/**
 * Frame envelope minter for outbound WebSocket frames.
 *
 * The Snapper backend's WebSocket schemas require every inbound
 * (client → server) frame to carry an envelope of provenance fields
 * alongside the type discriminator and payload-specific fields. The
 * envelope is `{session_id, sequence_id, public_id, timestamp}`,
 * matching the producer-side conventions Snapper uses across its
 * REST, WebSocket, and pub/sub surfaces.
 *
 * `EnvelopeMinter` keeps a process-stable `session_id` (random UUID
 * per minter instance, or operator-supplied via constructor option)
 * and two independent monotonic counters:
 *
 *   - "control" — for protocol-level frames the watch subcommand
 *     drives (authenticate, reauth, subscribe).
 *   - "telemetry" — for optional liveness frames (ping). Splitting
 *     these streams keeps gap-detection logs on the server clean if
 *     a control frame arrives between two ping frames.
 *
 * Each `next(counter)` call:
 *
 *   1. Advances the chosen counter by 1.
 *   2. Mints a fresh UUID v7 for `public_id` via the local `uuidv7`
 *      helper. The Snapper backend produces UUID v7 across the rest
 *      of its surface (REST, WebSocket, ZMQ publishers); matching
 *      the version on the bridge side keeps cross-producer logs
 *      naturally sortable by mint time and avoids surprising the
 *      operators who debug across components.
 *   3. Stamps `timestamp` as the current UTC instant in ISO 8601
 *      form (millisecond precision; matches the Pydantic backend's
 *      JSON-serialized datetimes).
 */

import { randomBytes } from "node:crypto";

import type { FrameEnvelope } from "./generated/wire-contract.js";

/**
 * Generate an RFC 9562 UUID v7. The first 48 bits are the current
 * Unix epoch in milliseconds (big-endian), giving naturally
 * sortable identifiers; the remaining bits carry the version
 * marker (0111), variant marker (10), and 74 bits of cryptographic
 * randomness.
 */
export function uuidv7(): string {
  const tsHex = BigInt(Date.now()).toString(16).padStart(12, "0");
  const rand = randomBytes(10);
  rand.writeUInt8((rand.readUInt8(0) & 0x0f) | 0x70, 0);
  rand.writeUInt8((rand.readUInt8(2) & 0x3f) | 0x80, 2);
  const seg3 = rand.subarray(0, 2).toString("hex");
  const seg4 = rand.subarray(2, 4).toString("hex");
  const seg5 = rand.subarray(4, 10).toString("hex");
  return `${tsHex.slice(0, 8)}-${tsHex.slice(8, 12)}-${seg3}-${seg4}-${seg5}`;
}

export type { FrameEnvelope } from "./generated/wire-contract.js";

export type EnvelopeCounter = "control" | "telemetry";

export interface EnvelopeMinterOptions {
  readonly sessionId?: string;
}

export class EnvelopeMinter {
  private readonly sessionIdValue: string;
  private controlCounter: number;
  private telemetryCounter: number;

  constructor(opts: EnvelopeMinterOptions = {}) {
    this.sessionIdValue = opts.sessionId ?? uuidv7();
    this.controlCounter = 0;
    this.telemetryCounter = 0;
  }

  next(counter: EnvelopeCounter = "control"): FrameEnvelope {
    let sequence_id: number;
    if (counter === "control") {
      this.controlCounter += 1;
      sequence_id = this.controlCounter;
    } else {
      this.telemetryCounter += 1;
      sequence_id = this.telemetryCounter;
    }
    return {
      session_id: this.sessionIdValue,
      sequence_id,
      public_id: uuidv7(),
      timestamp: new Date().toISOString(),
    };
  }

  get sessionId(): string {
    return this.sessionIdValue;
  }

  get controlSequence(): number {
    return this.controlCounter;
  }

  get telemetrySequence(): number {
    return this.telemetryCounter;
  }
}
