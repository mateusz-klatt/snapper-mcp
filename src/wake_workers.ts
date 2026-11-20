/**
 * Background wake workers for Codex (`--client codex --wake`),
 * Cursor (`--client cursor --wake`), and Antigravity
 * (`watch --client antigravity --wake`).
 *
 * All diagnostics go exclusively to stderr via `Logger`; zero bytes are
 * written to stdout so MCP JSON-RPC framing stays pure.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { Duplex } from "node:stream";
import { promisify } from "node:util";
import WebSocket from "ws";

import {
  classifyActionableFrame,
  DEFAULT_WAKE_KINDS,
  SNAPPER_WAKE_PROMPT,
  type WakeKind,
} from "./actionable.js";
import { computeWsUrl, type BridgeEnv } from "./env.js";
import { EnvelopeMinter } from "./envelope.js";
import { findExecutableOnPath } from "./hook.js";
import {
  checkInteractiveSession,
  inspectParentProcess,
  matchesExpectedExecutable,
  type ParentProcessInspector,
} from "./interactive.js";
import type { Logger } from "./logger.js";
import {
  defaultIsPidAlive,
  isWakeEnabled,
  readWakePreference,
} from "./state_dir.js";
import { TokenStore } from "./token_store.js";
import type { AiReviewRequestFrame, ServerFrame } from "./types.js";
import {
  isAntigravityHelperLive,
  latchAntigravityFailed,
  publishAntigravityHelper,
  readAntigravityWakeState,
  readCodexWakeState,
  recordCodexActionableEvent,
  recordCursorActionableEvent,
  setAntigravityReservation,
  settleCodexReservation,
  tryReserveCodexWake,
} from "./wake_state.js";
import {
  createWsClient,
  type WsClient,
  type WsClientOptions,
} from "./ws_client.js";
import { fetchWsToken } from "./ws_token.js";

const execFileAsync = promisify(execFile);

const DEFAULT_WAKE_TOPICS: readonly string[] = [
  "signals.",
  "orders.events.",
  "ai_reviews.",
  "ai_research.",
];
const AUTH_ME_TIMEOUT_MS = 10_000;
const AI_REVIEW_FANOUT_AFTER_MS = 30_000;
const DEFAULT_CHILD_KILL_GRACE_MS = 250;
const MAX_SUBPROCESS_STDOUT_BYTES = 64 * 1024;
const CANONICAL_UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const AGY_HELPER_ENV = "SNAPPER_AGY_HELPER";

export interface WakeWorkerHandle {
  readonly close: () => Promise<void>;
}

async function resolveOwnDelegatePublicId(
  baseUrl: URL,
  store: TokenStore,
): Promise<string | null> {
  const url = new URL("/api/auth/me", baseUrl.origin);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTH_ME_TIMEOUT_MS);
  try {
    const response = await globalThis.fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${store.accessToken()}` },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (body === null || typeof body !== "object") return null;
    const id = (
      body as { readonly payload?: { readonly delegate_public_id?: unknown } }
    ).payload?.delegate_public_id;
    return typeof id === "string" && id.trim().length > 0 ? id.trim() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function createActionableFilter(params: {
  readonly delegatePublicId: string | null;
  readonly wakeKinds?: ReadonlySet<WakeKind>;
  readonly onActionable: (kind: WakeKind, frame: ServerFrame) => void;
}): {
  readonly onFrame: (frame: ServerFrame) => void;
  readonly dispose: () => void;
} {
  const wakeKinds = params.wakeKinds ?? new Set<WakeKind>(DEFAULT_WAKE_KINDS);
  const held = new Map<string, ReturnType<typeof setTimeout>>();

  const cancelHeld = (reviewPublicId: string): void => {
    const timer = held.get(reviewPublicId);
    if (timer !== undefined) {
      clearTimeout(timer);
      held.delete(reviewPublicId);
    }
  };

  const emitIfActionable = (frame: ServerFrame): void => {
    const kind = classifyActionableFrame(frame, wakeKinds);
    if (kind !== null) {
      params.onActionable(kind, frame);
    }
  };

  const holdForeign = (frame: AiReviewRequestFrame): void => {
    const createdAtMs = Date.parse(frame.timestamp);
    const deadlineMs = Date.parse(frame.deadline);
    if (!Number.isFinite(createdAtMs) || !Number.isFinite(deadlineMs)) {
      emitIfActionable(frame);
      return;
    }
    const releaseAtMs = createdAtMs + AI_REVIEW_FANOUT_AFTER_MS;
    const nowMs = Date.now();
    if (deadlineMs <= nowMs || deadlineMs <= releaseAtMs) return;
    if (releaseAtMs <= nowMs) {
      emitIfActionable(frame);
      return;
    }
    cancelHeld(frame.review_public_id);
    const timer = setTimeout(() => {
      held.delete(frame.review_public_id);
      if (Date.now() < deadlineMs) {
        emitIfActionable(frame);
      }
    }, releaseAtMs - nowMs);
    timer.unref();
    held.set(frame.review_public_id, timer);
  };

  return {
    onFrame: (frame: ServerFrame) => {
      if (frame.type === "ai_review.decision_ack") {
        cancelHeld(frame.review_public_id);
        return;
      }
      if (frame.type === "ai_review.request" && params.delegatePublicId !== null) {
        const selected = frame.selected_delegate_public_id;
        if (
          typeof selected === "string" &&
          selected.length > 0 &&
          selected !== params.delegatePublicId
        ) {
          holdForeign(frame);
          return;
        }
      }
      emitIfActionable(frame);
    },
    dispose: () => {
      for (const timer of held.values()) clearTimeout(timer);
      held.clear();
    },
  };
}

async function startActionableClient(params: {
  readonly env: BridgeEnv;
  readonly logger: Logger;
  readonly onActionable: (kind: WakeKind, frame: ServerFrame) => void;
  readonly wsClientFactory?: (opts: WsClientOptions) => WsClient;
}): Promise<WakeWorkerHandle> {
  const store = new TokenStore({ access: params.env.accessToken });
  const delegatePublicId = await resolveOwnDelegatePublicId(params.env.baseUrl, store);
  const filter = createActionableFilter({
    delegatePublicId,
    onActionable: params.onActionable,
  });
  const factory = params.wsClientFactory ?? createWsClient;
  const client = factory({
    wsUrl: computeWsUrl(params.env.baseUrl),
    tokenStore: store,
    fetchWsToken: () => fetchWsToken(params.env.baseUrl, store, params.logger),
    topics: DEFAULT_WAKE_TOPICS,
    minter: new EnvelopeMinter(),
    logger: params.logger,
    onFrame: filter.onFrame,
  });
  const runPromise = client.run().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    params.logger.warn(`wake stream ended: ${msg}`);
  });
  return {
    close: async () => {
      filter.dispose();
      await client.close();
      await runPromise;
    },
  };
}

/* --------------------------------------------------------------------
 * Cursor background wake worker
 * ------------------------------------------------------------------ */

export async function startCursorWakeWorker(params: {
  readonly env: BridgeEnv;
  readonly stateDir: string;
  readonly logger: Logger;
  readonly wsClientFactory?: (opts: WsClientOptions) => WsClient;
}): Promise<WakeWorkerHandle> {
  const inFlight = new Set<Promise<unknown>>();
  const stream = await startActionableClient({
    env: params.env,
    logger: params.logger,
    wsClientFactory: params.wsClientFactory,
    onActionable: () => {
      const writeOp = recordCursorActionableEvent(params.stateDir)
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          params.logger.warn(`cursor wake state update failed: ${msg}`);
        })
        .finally(() => {
          inFlight.delete(writeOp);
        });
      inFlight.add(writeOp);
    },
  });
  return {
    close: async () => {
      await stream.close();
      if (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
      }
    },
  };
}

/* --------------------------------------------------------------------
 * Subprocess target resolution & Codex idle-checked wake worker
 * ------------------------------------------------------------------ */

export type CodexIdleProbe = (
  threadId: string,
  signal?: AbortSignal,
) => Promise<boolean>;
export type CodexQueueSender = (
  threadId: string,
  message: string,
  signal?: AbortSignal,
) => Promise<boolean>;

export function resolveSubprocessTarget(
  rawCommand: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): { readonly file: string; readonly args: readonly string[] } | null {
  const trimmed = rawCommand.trim();
  if (trimmed.length === 0) return null;
  const isPathQualified =
    trimmed.includes("/") || trimmed.includes("\\") || path.isAbsolute(trimmed);
  const candidate = isPathQualified
    ? path.resolve(trimmed)
    : findExecutableOnPath(trimmed, env, platform);
  if (candidate === null || !path.isAbsolute(candidate)) {
    return null;
  }
  const lower = candidate.toLowerCase();
  if (lower.endsWith(".mjs") || lower.endsWith(".cjs") || lower.endsWith(".js")) {
    return { file: process.execPath, args: [candidate, ...args] };
  }
  return { file: candidate, args: [...args] };
}

interface ManagedChild {
  readonly child: ChildProcess;
  readonly exited: Promise<void>;
  readonly terminate: (killGraceMs?: number) => Promise<void>;
}

function registerManagedChild(
  child: ChildProcess,
  registry?: Set<ManagedChild>,
): ManagedChild {
  let done = false;
  let onSettled: (() => void) | null = null;
  const exited = new Promise<void>((resolve) => {
    const markDone = (): void => {
      if (done) return;
      done = true;
      onSettled?.();
      resolve();
    };
    child.once("close", markDone);
    child.once("error", () => {
      if (child.pid === undefined) {
        markDone();
      }
    });
  });

  let terminatePromise: Promise<void> | null = null;
  const terminate = (
    killGraceMs = DEFAULT_CHILD_KILL_GRACE_MS,
  ): Promise<void> => {
    if (done) {
      return Promise.resolve();
    }
    terminatePromise ??= (async () => {
      child.kill("SIGTERM");
      let killTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        killTimer = null;
        if (!done) {
          child.kill("SIGKILL");
          child.stdin?.destroy();
          child.stdout?.destroy();
        }
      }, killGraceMs);
      killTimer.unref();
      try {
        await exited;
      } finally {
        if (killTimer !== null) {
          clearTimeout(killTimer);
        }
      }
    })();
    return terminatePromise;
  };

  const managed: ManagedChild = { child, exited, terminate };
  if (registry !== undefined) {
    registry.add(managed);
    onSettled = () => {
      registry.delete(managed);
    };
  }
  return managed;
}

/**
 * Wraps a spawned Codex proxy child's stdin/stdout pipes as a single `Duplex`
 * stream for `ws`. Stream write/read errors are intentionally absorbed and
 * mapped to completion/EOF because `probeCodexThreadIdleViaProxy` bounds probe
 * lifetime via its own timer, abort signal, and `ChildProcess` exit join; do
 * not reuse this helper where callers require stream-level write errors.
 */
function createChildProcessDuplex(
  childStdin: NodeJS.WritableStream,
  childStdout: NodeJS.ReadableStream,
): Duplex {
  const duplex = new Duplex({
    read() {
      // Driven by childStdout 'data' events below.
    },
    write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
      const buf = typeof chunk === "string" ? Buffer.from(chunk, encoding) : chunk;
      childStdin.write(buf, () => {
        callback();
      });
    },
    final(callback: (error?: Error | null) => void) {
      childStdin.end(() => {
        callback();
      });
    },
  });
  childStdin.on("error", () => undefined);
  duplex.on("error", () => undefined);
  childStdout.on("data", (chunk: Buffer) => {
    duplex.push(chunk);
  });
  childStdout.on("end", () => {
    duplex.push(null);
  });
  childStdout.on("error", () => {
    duplex.push(null);
  });
  return duplex;
}

function parseCodexProxyFrame(
  raw: WebSocket.RawData,
  threadId: string,
):
  | { readonly action: "send_thread_read" }
  | { readonly action: "done"; readonly idle: boolean }
  | { readonly action: "ignore" } {
  const text =
    typeof raw === "string"
      ? raw
      : Buffer.isBuffer(raw)
        ? raw.toString("utf8")
        : Buffer.from(raw as ArrayBuffer).toString("utf8");
  const msg = JSON.parse(text) as {
    readonly id?: unknown;
    readonly result?: unknown;
    readonly error?: unknown;
  };
  if (msg.id === 1 && msg.result !== undefined && msg.error === undefined) {
    return { action: "send_thread_read" };
  }
  if (msg.id === 2) {
    const thread = (
      msg.result as {
        readonly thread?: {
          readonly id?: unknown;
          readonly status?: { readonly type?: unknown };
        };
      } | undefined
    )?.thread;
    return {
      action: "done",
      idle: thread?.id === threadId && thread?.status?.type === "idle",
    };
  }
  return { action: "ignore" };
}

async function probeCodexThreadIdleInternal(params: {
  readonly threadId: string;
  readonly codexCommand?: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly killGraceMs: number;
  readonly registry?: Set<ManagedChild>;
}): Promise<boolean> {
  if (params.signal?.aborted) {
    return false;
  }
  const resolved = resolveSubprocessTarget(params.codexCommand ?? "codex", [
    "app-server",
    "proxy",
  ]);
  if (resolved === null) {
    return false;
  }

  const child = spawn(resolved.file, resolved.args, {
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  const managed = registerManagedChild(child, params.registry);
  const duplex = createChildProcessDuplex(child.stdin, child.stdout);
  const ws = new WebSocket("ws://localhost/", {
    createConnection: () => duplex as unknown as net.Socket,
    maxPayload: 256 * 1024,
  });

  let timer: ReturnType<typeof setTimeout> | null = null;
  let onAbort: (() => void) | null = null;
  try {
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (idle: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(idle);
      };

      timer = setTimeout(() => {
        finish(false);
      }, params.timeoutMs);
      timer.unref();

      child.on("error", () => {
        finish(false);
      });
      ws.on("error", () => {
        finish(false);
      });
      ws.once("close", () => {
        finish(false);
      });

      onAbort = () => {
        finish(false);
      };
      params.signal?.addEventListener("abort", onAbort, { once: true });

      ws.once("open", () => {
        ws.send(
          JSON.stringify({
            id: 1,
            method: "initialize",
            params: { clientInfo: { name: "snapper-mcp-wake", version: "1" } },
          }),
        );
      });

      ws.on("message", (raw: WebSocket.RawData) => {
        try {
          const parsed = parseCodexProxyFrame(raw, params.threadId);
          if (parsed.action === "send_thread_read") {
            ws.send(JSON.stringify({ method: "initialized", params: {} }));
            ws.send(
              JSON.stringify({
                id: 2,
                method: "thread/read",
                params: { threadId: params.threadId, includeTurns: false },
              }),
            );
          } else if (parsed.action === "done") {
            finish(parsed.idle);
          }
        } catch {
          finish(false);
        }
      });
    });
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
    if (onAbort !== null) {
      params.signal?.removeEventListener("abort", onAbort);
    }
    ws.terminate();
    await managed.terminate(params.killGraceMs);
  }
}

export async function probeCodexThreadIdleViaProxy(
  threadId: string,
  codexCommand?: string,
  timeoutMs = 5_000,
  signal?: AbortSignal,
): Promise<boolean> {
  return probeCodexThreadIdleInternal({
    threadId,
    codexCommand,
    timeoutMs,
    signal,
    killGraceMs: DEFAULT_CHILD_KILL_GRACE_MS,
  });
}

async function queueCodexWakeMessageInternal(params: {
  readonly threadId: string;
  readonly message: string;
  readonly codexCommand?: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly killGraceMs: number;
  readonly registry?: Set<ManagedChild>;
}): Promise<boolean> {
  if (params.signal?.aborted) {
    return false;
  }
  const resolved = resolveSubprocessTarget(params.codexCommand ?? "codex", [
    "queue",
    "--thread",
    params.threadId,
    "--resume",
    "--message",
    params.message,
  ]);
  if (resolved === null) {
    return false;
  }

  const child = spawn(resolved.file, resolved.args, {
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  child.on("error", () => undefined);
  const managed = registerManagedChild(child, params.registry);

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    totalBytes += chunk.length;
    if (totalBytes <= MAX_SUBPROCESS_STDOUT_BYTES) {
      chunks.push(chunk);
    }
  });
  child.stdout.on("error", () => undefined);

  let cancelled = false;
  const requestCancel = (): void => {
    cancelled = true;
    void managed.terminate(params.killGraceMs);
  };

  const timer = setTimeout(requestCancel, params.timeoutMs);
  timer.unref();
  params.signal?.addEventListener("abort", requestCancel, { once: true });

  try {
    await managed.exited;
    if (cancelled) {
      await managed.terminate(params.killGraceMs);
    }
  } finally {
    clearTimeout(timer);
    params.signal?.removeEventListener("abort", requestCancel);
  }

  if (
    cancelled ||
    totalBytes > MAX_SUBPROCESS_STDOUT_BYTES ||
    child.exitCode !== 0 ||
    child.signalCode !== null
  ) {
    return false;
  }
  const trimmed = Buffer.concat(chunks).toString("utf8").trim();
  return (
    trimmed.startsWith("Queued message ") &&
    trimmed.includes(` for thread ${params.threadId}.`)
  );
}

export async function queueCodexWakeMessage(
  threadId: string,
  message: string,
  codexCommand?: string,
  timeoutMs = 5_000,
  signal?: AbortSignal,
): Promise<boolean> {
  return queueCodexWakeMessageInternal({
    threadId,
    message,
    codexCommand,
    timeoutMs,
    signal,
    killGraceMs: DEFAULT_CHILD_KILL_GRACE_MS,
  });
}

export interface CodexWakeWorkerOptions {
  readonly env: BridgeEnv;
  readonly stateDir: string;
  readonly logger: Logger;
  readonly wsClientFactory?: (opts: WsClientOptions) => WsClient;
  readonly idleProbe?: CodexIdleProbe;
  readonly queueSender?: CodexQueueSender;
  readonly codexCommand?: string;
  readonly killGraceMs?: number;
  readonly isPidAlive?: (pid: number) => boolean;
  readonly settleMs?: number;
  readonly pollMs?: number;
}

async function revalidateCodexReservation(params: {
  readonly stateDir: string;
  readonly reservationId: string;
  readonly threadId: string;
  readonly isPidAlive: (pid: number) => boolean;
}): Promise<{ readonly valid: boolean; readonly shouldRetry: boolean }> {
  const pref = await readWakePreference(params.stateDir, "codex");
  if (pref === "off") {
    return { valid: false, shouldRetry: false };
  }
  const current = await readCodexWakeState(params.stateDir);
  const valid =
    current.reservationId === params.reservationId &&
    current.threadId === params.threadId &&
    current.codexPid !== null &&
    params.isPidAlive(current.codexPid);
  return {
    valid,
    shouldRetry: !valid && current.latestSeq > current.deliveredSeq,
  };
}

export async function startCodexWakeWorker(
  options: CodexWakeWorkerOptions,
): Promise<WakeWorkerHandle> {
  const activeChildren = new Set<ManagedChild>();
  const killGraceMs = options.killGraceMs ?? DEFAULT_CHILD_KILL_GRACE_MS;
  const idleProbe =
    options.idleProbe ??
    ((id, sig) =>
      probeCodexThreadIdleInternal({
        threadId: id,
        codexCommand: options.codexCommand,
        timeoutMs: 5_000,
        signal: sig,
        killGraceMs,
        registry: activeChildren,
      }));
  const queueSender =
    options.queueSender ??
    ((id, msg, sig) =>
      queueCodexWakeMessageInternal({
        threadId: id,
        message: msg,
        codexCommand: options.codexCommand,
        timeoutMs: 5_000,
        signal: sig,
        killGraceMs,
        registry: activeChildren,
      }));
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  const settleMs = options.settleMs ?? 1_000;
  const pollMs = options.pollMs ?? 5_000;

  const abortController = new AbortController();
  const pendingRecords = new Set<Promise<unknown>>();
  let closed = false;
  let pendingTrigger = false;
  let activeStepPromise: Promise<void> | null = null;
  let stepTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleStep = (delayMs: number): void => {
    if (closed || stepTimer !== null) return;
    stepTimer = setTimeout(() => {
      stepTimer = null;
      triggerStep();
    }, delayMs);
    stepTimer.unref();
  };

  const executeStep = async (): Promise<void> => {
    try {
      const pref = await readWakePreference(options.stateDir, "codex");
      if (pref === "off") return;

      const reservation = await tryReserveCodexWake({
        stateDir: options.stateDir,
        isPidAlive,
      });
      if (!reservation.reserved) return;

      const idle = await idleProbe(reservation.threadId, abortController.signal);
      if (closed) {
        await settleCodexReservation({
          stateDir: options.stateDir,
          reservationId: reservation.reservationId,
          submitted: false,
        });
        return;
      }

      const recheck = await revalidateCodexReservation({
        stateDir: options.stateDir,
        reservationId: reservation.reservationId,
        threadId: reservation.threadId,
        isPidAlive,
      });
      if (!recheck.valid) {
        await settleCodexReservation({
          stateDir: options.stateDir,
          reservationId: reservation.reservationId,
          submitted: false,
        });
        if (recheck.shouldRetry) {
          scheduleStep(settleMs);
        }
        return;
      }

      if (!idle) {
        await settleCodexReservation({
          stateDir: options.stateDir,
          reservationId: reservation.reservationId,
          submitted: false,
        });
        scheduleStep(pollMs);
        return;
      }

      const queued = await queueSender(
        reservation.threadId,
        SNAPPER_WAKE_PROMPT,
        abortController.signal,
      );
      await settleCodexReservation({
        stateDir: options.stateDir,
        reservationId: reservation.reservationId,
        submitted: queued,
      });
      if (closed) return;
      if (!queued) {
        scheduleStep(pollMs);
        return;
      }
      const afterState = await readCodexWakeState(options.stateDir);
      if (afterState.latestSeq > afterState.deliveredSeq && afterState.reservationId === null) {
        scheduleStep(settleMs);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      options.logger.warn(`codex wake step failed: ${msg}`);
    }
  };

  const triggerStep = (): void => {
    if (closed) return;
    if (activeStepPromise !== null) {
      pendingTrigger = true;
      return;
    }
    pendingTrigger = false;
    const p = executeStep().finally(() => {
      activeStepPromise = null;
      if (pendingTrigger && !closed) {
        pendingTrigger = false;
        scheduleStep(settleMs);
      }
    });
    activeStepPromise = p;
  };

  const stream = await startActionableClient({
    env: options.env,
    logger: options.logger,
    wsClientFactory: options.wsClientFactory,
    onActionable: () => {
      const rec = recordCodexActionableEvent(options.stateDir)
        .then(() => {
          scheduleStep(settleMs);
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          options.logger.warn(`codex wake state update failed: ${msg}`);
        })
        .finally(() => {
          pendingRecords.delete(rec);
        });
      pendingRecords.add(rec);
    },
  });

  return {
    close: async () => {
      closed = true;
      if (stepTimer !== null) {
        clearTimeout(stepTimer);
        stepTimer = null;
      }
      abortController.abort();
      if (activeChildren.size > 0) {
        await Promise.allSettled(
          [...activeChildren].map((m) => m.terminate(killGraceMs)),
        );
      }
      await stream.close();
      if (pendingRecords.size > 0) {
        await Promise.allSettled([...pendingRecords]);
      }
      if (activeStepPromise !== null) {
        await activeStepPromise;
      }
    },
  };
}

/* --------------------------------------------------------------------
 * Antigravity launcher and detached wake helper
 * ------------------------------------------------------------------ */

export async function validateLoopbackLanguageServer(
  rawAddress: string | undefined,
  dialTcp?: (host: string, port: number) => Promise<boolean>,
): Promise<string> {
  if (typeof rawAddress !== "string" || rawAddress.trim().length === 0) {
    throw new Error("ANTIGRAVITY_LS_ADDRESS is missing");
  }
  const trimmed = rawAddress.trim();
  let host: string;
  let portStr: string;
  if (trimmed.startsWith("[")) {
    const closeBracket = trimmed.indexOf("]:");
    if (closeBracket < 0) {
      throw new Error("invalid IPv6 ANTIGRAVITY_LS_ADDRESS");
    }
    host = trimmed.slice(1, closeBracket);
    portStr = trimmed.slice(closeBracket + 2);
  } else {
    const lastColon = trimmed.lastIndexOf(":");
    if (lastColon <= 0) {
      throw new Error("invalid ANTIGRAVITY_LS_ADDRESS");
    }
    host = trimmed.slice(0, lastColon);
    portStr = trimmed.slice(lastColon + 1);
  }
  const port = Number(portStr);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("invalid ANTIGRAVITY_LS_ADDRESS port");
  }

  let candidates: readonly string[];
  if (host.toLowerCase() === "localhost") {
    candidates = ["127.0.0.1", "::1"];
  } else if (host === "127.0.0.1" || host === "::1" || host.startsWith("127.")) {
    candidates = [host];
  } else {
    throw new Error("ANTIGRAVITY_LS_ADDRESS must be a loopback address");
  }

  const probe =
    dialTcp ??
    ((targetHost: string, targetPort: number) =>
      new Promise<boolean>((resolve) => {
        const sock = net.createConnection({ host: targetHost, port: targetPort });
        const timer = setTimeout(() => {
          sock.destroy();
          resolve(false);
        }, 500);
        sock.once("connect", () => {
          clearTimeout(timer);
          sock.destroy();
          resolve(true);
        });
        sock.once("error", () => {
          clearTimeout(timer);
          sock.destroy();
          resolve(false);
        });
      }));

  for (const candidateHost of candidates) {
    const reachable = await probe(candidateHost, port);
    if (reachable) {
      return candidateHost.includes(":")
        ? `[${candidateHost}]:${port}`
        : `${candidateHost}:${port}`;
    }
  }
  throw new Error("Antigravity language server is unreachable on loopback");
}

function validControlFreeSecret(secret: string | undefined): secret is string {
  if (typeof secret !== "string" || secret.length === 0 || secret.length > 4096) {
    return false;
  }
  for (let i = 0; i < secret.length; i += 1) {
    const code = secret.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

export async function sendAntigravityWakeMessage(params: {
  readonly agyExecutable: string;
  readonly conversationId: string;
  readonly message: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}): Promise<boolean> {
  const resolved = resolveSubprocessTarget(
    params.agyExecutable,
    ["agentapi", "send-message", params.conversationId, params.message],
    params.env,
  );
  if (resolved === null) {
    return false;
  }
  try {
    const { stdout, stderr } = await execFileAsync(
      resolved.file,
      resolved.args,
      {
        env: params.env,
        timeout: params.timeoutMs ?? 15_000,
        windowsHide: true,
      },
    );
    if (stderr.length > 0) return false;
    const parsed = JSON.parse(stdout) as {
      readonly error?: unknown;
      readonly response?: {
        readonly sendMessage?: { readonly recipientId?: unknown };
      };
    };
    return (
      !parsed.error &&
      parsed.response?.sendMessage?.recipientId === params.conversationId
    );
  } catch {
    return false;
  }
}

export interface AntigravityWakeOptions {
  readonly env: BridgeEnv;
  readonly configPath: string;
  readonly stateDir: string;
  readonly source: NodeJS.ProcessEnv;
  readonly logger: Logger;
  readonly inspector?: ParentProcessInspector;
  readonly isPidAlive?: (pid: number) => boolean;
  readonly dialTcp?: (host: string, port: number) => Promise<boolean>;
  readonly spawnDetached?: (params: {
    readonly command: string;
    readonly args: readonly string[];
    readonly env: NodeJS.ProcessEnv;
  }) => number;
  readonly sendMessage?: (params: {
    readonly agyExecutable: string;
    readonly conversationId: string;
    readonly message: string;
    readonly env: NodeJS.ProcessEnv;
  }) => Promise<boolean>;
  readonly wsClientFactory?: (opts: WsClientOptions) => WsClient;
  readonly settleMs?: number;
  readonly pollMs?: number;
}

function defaultSpawnDetached(params: {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}): number {
  const child = spawn(params.command, params.args, {
    env: params.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => undefined);
  child.unref();
  if (typeof child.pid !== "number" || child.pid <= 0) {
    throw new Error("detached Antigravity helper failed to spawn");
  }
  return child.pid;
}

export async function runAntigravityWakeCommand(
  options: AntigravityWakeOptions,
): Promise<number> {
  const handshake = options.source[AGY_HELPER_ENV];
  if (typeof handshake === "string" && handshake.length > 0) {
    return runAntigravityChildHelper(options, handshake);
  }
  return runAntigravityLauncher(options);
}

async function runAntigravityLauncher(
  options: AntigravityWakeOptions,
): Promise<number> {
  const inspector = options.inspector ?? (() => inspectParentProcess());
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  const convId = options.source["ANTIGRAVITY_CONVERSATION_ID"] ?? "";
  const csrf = options.source["ANTIGRAVITY_CSRF_TOKEN"];
  const check = await checkInteractiveSession("antigravity", inspector);

  const failAndLatch = async (reason: string): Promise<number> => {
    options.logger.error(reason);
    if (check.parent !== null && CANONICAL_UUID_REGEX.test(convId)) {
      await latchAntigravityFailed({
        stateDir: options.stateDir,
        agyPid: check.parent.pid,
        agyStartToken: check.parent.startToken,
        conversationId: convId,
      }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        options.logger.warn(`antigravity failure latch failed: ${msg}`);
      });
    }
    return 1;
  };

  const pref = await readWakePreference(options.stateDir, "antigravity");
  if (!isWakeEnabled(pref)) {
    return failAndLatch("Antigravity wake is disabled");
  }
  if (!check.interactive || check.parent === null) {
    return failAndLatch(`Antigravity interactive session unavailable (${check.reason})`);
  }
  if (!CANONICAL_UUID_REGEX.test(convId) || !validControlFreeSecret(csrf)) {
    return failAndLatch("Antigravity session credentials are missing or invalid");
  }

  let canonicalLs: string;
  try {
    canonicalLs = await validateLoopbackLanguageServer(
      options.source["ANTIGRAVITY_LS_ADDRESS"],
      options.dialTcp,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return failAndLatch(msg);
  }

  const state = await readAntigravityWakeState(options.stateDir);
  if (
    isAntigravityHelperLive(
      state,
      check.parent.pid,
      check.parent.startToken,
      convId,
      isPidAlive,
    )
  ) {
    return 0;
  }

  const attemptId = randomBytes(16).toString("hex");
  const scriptPath = process.argv[1];
  const spawnArgs = [
    ...(typeof scriptPath === "string" && scriptPath.length > 0 ? [scriptPath] : []),
    "watch",
    "--client",
    "antigravity",
    "--wake",
    "--config",
    options.configPath,
  ];
  const childEnv: NodeJS.ProcessEnv = {
    ...options.source,
    ANTIGRAVITY_CONVERSATION_ID: convId,
    ANTIGRAVITY_LS_ADDRESS: canonicalLs,
    ANTIGRAVITY_CSRF_TOKEN: csrf,
    [AGY_HELPER_ENV]: JSON.stringify({
      agyPid: check.parent.pid,
      agyStartToken: check.parent.startToken,
      attemptId,
      agyExe: check.parent.executableName,
    }),
  };

  const spawner = options.spawnDetached ?? defaultSpawnDetached;
  let helperPid: number;
  try {
    helperPid = spawner({
      command: process.execPath,
      args: spawnArgs,
      env: childEnv,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return failAndLatch(msg);
  }

  const published = await publishAntigravityHelper({
    stateDir: options.stateDir,
    record: {
      agyPid: check.parent.pid,
      agyStartToken: check.parent.startToken,
      helperPid,
      conversationId: convId,
      attemptId,
    },
    isPidAlive,
  });
  if (published.alreadyLive) {
    try {
      process.kill(helperPid, "SIGTERM");
    } catch {
      // Best-effort cleanup of duplicate helper.
    }
  }
  return 0;
}

interface AntigravityHandshake {
  readonly agyPid: number;
  readonly agyStartToken: string;
  readonly attemptId: string;
  readonly agyExe: string;
}

function parseAntigravityHandshake(raw: string): AntigravityHandshake | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const agyPid = obj["agyPid"];
  const agyStartToken = obj["agyStartToken"];
  const attemptId = obj["attemptId"];
  const agyExe = obj["agyExe"];
  if (
    typeof agyPid !== "number" ||
    !Number.isInteger(agyPid) ||
    agyPid <= 1 ||
    typeof agyStartToken !== "string" ||
    agyStartToken.trim().length === 0 ||
    typeof attemptId !== "string" ||
    attemptId.trim().length === 0 ||
    typeof agyExe !== "string" ||
    !matchesExpectedExecutable("antigravity", agyExe)
  ) {
    return null;
  }
  return { agyPid, agyStartToken, attemptId, agyExe };
}

async function runAntigravityChildHelper(
  options: AntigravityWakeOptions,
  rawHandshake: string,
): Promise<number> {
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  const sendMessage = options.sendMessage ?? sendAntigravityWakeMessage;
  const settleMs = options.settleMs ?? 1_000;
  const pollMs = options.pollMs ?? 5_000;

  const handshake = parseAntigravityHandshake(rawHandshake);
  if (handshake === null) {
    return 1;
  }

  const convId = options.source["ANTIGRAVITY_CONVERSATION_ID"] ?? "";
  const csrf = options.source["ANTIGRAVITY_CSRF_TOKEN"];
  if (!CANONICAL_UUID_REGEX.test(convId) || !validControlFreeSecret(csrf)) {
    return 1;
  }

  let canonicalLs: string;
  try {
    canonicalLs = await validateLoopbackLanguageServer(
      options.source["ANTIGRAVITY_LS_ADDRESS"],
      options.dialTcp,
    );
  } catch {
    return 1;
  }

  let pendingWake = false;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resolveDone: (() => void) | null = null;
  const inFlight = new Set<Promise<unknown>>();
  const donePromise = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const stopHelper = (): void => {
    if (closed) return;
    closed = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    resolveDone?.();
  };

  const scheduleAttempt = (delayMs: number): void => {
    if (closed || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      const deliverOp = tryDeliver()
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          options.logger.warn(`antigravity wake delivery failed: ${msg}`);
          if (!closed) {
            scheduleAttempt(pollMs);
          }
        })
        .finally(() => {
          inFlight.delete(deliverOp);
        });
      inFlight.add(deliverOp);
    }, delayMs);
  };

  const tryDeliver = async (): Promise<void> => {
    if (closed || !pendingWake) return;
    if (!isPidAlive(handshake.agyPid)) {
      stopHelper();
      return;
    }
    const pref = await readWakePreference(options.stateDir, "antigravity");
    if (closed) return;
    if (!isWakeEnabled(pref)) {
      stopHelper();
      return;
    }
    const reserved = await setAntigravityReservation(options.stateDir, convId, true);
    if (closed) return;
    if (!reserved) {
      scheduleAttempt(pollMs);
      return;
    }
    let ok = false;
    let sendErr: unknown = null;
    let sendThrew = false;
    try {
      ok = await sendMessage({
        agyExecutable: handshake.agyExe,
        conversationId: convId,
        message: SNAPPER_WAKE_PROMPT,
        env: {
          ...options.source,
          ANTIGRAVITY_CONVERSATION_ID: convId,
          ANTIGRAVITY_LS_ADDRESS: canonicalLs,
          ANTIGRAVITY_CSRF_TOKEN: csrf,
        },
      });
    } catch (err) {
      sendThrew = true;
      sendErr = err;
    }
    if (closed) return;
    if (ok) {
      pendingWake = false;
    } else {
      await setAntigravityReservation(options.stateDir, convId, false);
      if (sendThrew) throw sendErr;
      scheduleAttempt(pollMs);
    }
  };

  const stream = await startActionableClient({
    env: options.env,
    logger: options.logger,
    wsClientFactory: options.wsClientFactory,
    onActionable: () => {
      pendingWake = true;
      scheduleAttempt(settleMs);
    },
  });

  const livenessInterval = setInterval(() => {
    if (!isPidAlive(handshake.agyPid)) {
      stopHelper();
    }
  }, pollMs);
  livenessInterval.unref();

  try {
    await donePromise;
  } finally {
    clearInterval(livenessInterval);
    if (inFlight.size > 0) {
      await Promise.allSettled([...inFlight]);
    }
    await stream.close();
  }
  return 0;
}
