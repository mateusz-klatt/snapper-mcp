/**
 * Atomic per-session runtime state for Cursor, Codex, Antigravity,
 * and Kimi wake coordination.
 *
 * All files live inside `stateDir/runtime/` (`0700` directory, `0600`
 * files) and mutate under `mutateLockedJsonFile` so concurrent hooks
 * and background workers never corrupt state or double-wake a session.
 */

import { randomUUID } from "node:crypto";

import {
  defaultIsPidAlive,
  mutateLockedJsonFile,
  readRuntimeJsonFile,
} from "./state_dir.js";

/* --------------------------------------------------------------------
 * Cursor sequence state
 * ------------------------------------------------------------------ */

export interface CursorWakeState {
  readonly latestSeq: number;
  readonly toldSeq: number;
  readonly updatedAtMs: number;
}

function initialCursorState(): CursorWakeState {
  return { latestSeq: 0, toldSeq: 0, updatedAtMs: 0 };
}

export async function recordCursorActionableEvent(
  stateDir: string,
  nowMs: number = Date.now(),
): Promise<number> {
  return mutateLockedJsonFile({
    stateDir,
    name: "cursor-wake",
    initial: initialCursorState,
    mutate: (current) => {
      const nextSeq = current.latestSeq + 1;
      return {
        next: {
          latestSeq: nextSeq,
          toldSeq: current.toldSeq,
          updatedAtMs: nowMs,
        },
        result: nextSeq,
      };
    },
  });
}

export async function consumeCursorFollowup(
  stateDir: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  return mutateLockedJsonFile({
    stateDir,
    name: "cursor-wake",
    initial: initialCursorState,
    mutate: (current) => {
      if (current.latestSeq <= current.toldSeq) {
        return { next: current, result: false };
      }
      return {
        next: {
          latestSeq: current.latestSeq,
          toldSeq: current.latestSeq,
          updatedAtMs: nowMs,
        },
        result: true,
      };
    },
  });
}

/* --------------------------------------------------------------------
 * Codex root-thread binding and reservation state
 * ------------------------------------------------------------------ */

export interface CodexWakeState {
  readonly codexPid: number | null;
  readonly codexStartToken: string | null;
  readonly threadId: string | null;
  readonly latestSeq: number;
  readonly deliveredSeq: number;
  readonly reservationId: string | null;
  readonly reservedAtMs: number | null;
}

function initialCodexState(): CodexWakeState {
  return {
    codexPid: null,
    codexStartToken: null,
    threadId: null,
    latestSeq: 0,
    deliveredSeq: 0,
    reservationId: null,
    reservedAtMs: null,
  };
}

export async function recordCodexSession(params: {
  readonly stateDir: string;
  readonly codexPid: number;
  readonly codexStartToken: string;
  readonly threadId: string;
  readonly consumeReservation: boolean;
}): Promise<void> {
  await mutateLockedJsonFile({
    stateDir: params.stateDir,
    name: "codex-wake",
    initial: initialCodexState,
    mutate: (current) => {
      const changedThread = current.threadId !== params.threadId;
      const clearRes = params.consumeReservation || changedThread;
      return {
        next: {
          codexPid: params.codexPid,
          codexStartToken: params.codexStartToken,
          threadId: params.threadId,
          latestSeq: current.latestSeq,
          deliveredSeq: clearRes ? current.latestSeq : current.deliveredSeq,
          reservationId: clearRes ? null : current.reservationId,
          reservedAtMs: clearRes ? null : current.reservedAtMs,
        },
        result: undefined,
      };
    },
  });
}

export async function recordCodexActionableEvent(stateDir: string): Promise<number> {
  return mutateLockedJsonFile({
    stateDir,
    name: "codex-wake",
    initial: initialCodexState,
    mutate: (current) => {
      const nextSeq = current.latestSeq + 1;
      return {
        next: { ...current, latestSeq: nextSeq },
        result: nextSeq,
      };
    },
  });
}

export async function readCodexWakeState(stateDir: string): Promise<CodexWakeState> {
  return readRuntimeJsonFile(stateDir, "codex-wake", initialCodexState);
}

export async function tryReserveCodexWake(params: {
  readonly stateDir: string;
  readonly isPidAlive?: (pid: number) => boolean;
  readonly nowMs?: number;
}): Promise<{ readonly reserved: boolean; readonly threadId: string; readonly reservationId: string }> {
  const isPidAlive = params.isPidAlive ?? defaultIsPidAlive;
  const nowMs = params.nowMs ?? Date.now();
  return mutateLockedJsonFile<
    CodexWakeState,
    { readonly reserved: boolean; readonly threadId: string; readonly reservationId: string }
  >({
    stateDir: params.stateDir,
    name: "codex-wake",
    initial: initialCodexState,
    isPidAlive,
    mutate: (current) => {
      if (
        current.threadId === null ||
        current.codexPid === null ||
        !isPidAlive(current.codexPid) ||
        current.reservationId !== null ||
        current.latestSeq <= current.deliveredSeq
      ) {
        return {
          next: current,
          result: { reserved: false, threadId: "", reservationId: "" },
        };
      }
      const reservationId = randomUUID();
      return {
        next: {
          ...current,
          reservationId,
          reservedAtMs: nowMs,
        },
        result: {
          reserved: true,
          threadId: current.threadId,
          reservationId,
        },
      };
    },
  });
}

export async function settleCodexReservation(params: {
  readonly stateDir: string;
  readonly reservationId: string;
  readonly submitted: boolean;
}): Promise<void> {
  await mutateLockedJsonFile({
    stateDir: params.stateDir,
    name: "codex-wake",
    initial: initialCodexState,
    mutate: (current) => {
      if (current.reservationId !== params.reservationId) {
        return { next: current, result: undefined };
      }
      if (params.submitted) {
        return {
          next: {
            ...current,
            deliveredSeq: current.latestSeq,
          },
          result: undefined,
        };
      }
      return {
        next: {
          ...current,
          reservationId: null,
          reservedAtMs: null,
        },
        result: undefined,
      };
    },
  });
}

/* --------------------------------------------------------------------
 * Antigravity helper ownership and idle/reservation state
 * ------------------------------------------------------------------ */

export interface AntigravityHelperRecord {
  readonly agyPid: number;
  readonly agyStartToken: string;
  readonly helperPid: number;
  readonly conversationId: string;
  readonly attemptId: string;
}

export interface AntigravityWakeState {
  readonly agyPid: number | null;
  readonly agyStartToken: string | null;
  readonly conversationId: string | null;
  readonly idle: boolean;
  readonly latchedFailed: boolean;
  readonly outstandingReservation: boolean;
  readonly helper: AntigravityHelperRecord | null;
}

function initialAntigravityState(): AntigravityWakeState {
  return {
    agyPid: null,
    agyStartToken: null,
    conversationId: null,
    idle: false,
    latchedFailed: false,
    outstandingReservation: false,
    helper: null,
  };
}

export async function recordAntigravityTurnEvent(params: {
  readonly stateDir: string;
  readonly agyPid: number;
  readonly agyStartToken: string;
  readonly conversationId: string;
  readonly idle: boolean;
  readonly clearReservation: boolean;
}): Promise<AntigravityWakeState> {
  return mutateLockedJsonFile({
    stateDir: params.stateDir,
    name: "antigravity-wake",
    initial: initialAntigravityState,
    mutate: (current) => {
      const sameSession =
        current.agyPid === params.agyPid &&
        current.agyStartToken === params.agyStartToken &&
        current.conversationId === params.conversationId;
      const next: AntigravityWakeState = {
        agyPid: params.agyPid,
        agyStartToken: params.agyStartToken,
        conversationId: params.conversationId,
        idle: params.idle,
        latchedFailed: sameSession ? current.latchedFailed : false,
        outstandingReservation:
          sameSession && !params.clearReservation
            ? current.outstandingReservation
            : false,
        helper: sameSession ? current.helper : null,
      };
      return { next, result: next };
    },
  });
}

export function isAntigravityHelperLive(
  state: AntigravityWakeState,
  agyPid: number,
  agyStartToken: string,
  conversationId: string,
  isPidAlive: (pid: number) => boolean = defaultIsPidAlive,
): boolean {
  const h = state.helper;
  if (h === null) return false;
  return (
    h.agyPid === agyPid &&
    h.agyStartToken === agyStartToken &&
    h.conversationId === conversationId &&
    isPidAlive(h.helperPid)
  );
}

export async function publishAntigravityHelper(params: {
  readonly stateDir: string;
  readonly record: AntigravityHelperRecord;
  readonly isPidAlive?: (pid: number) => boolean;
}): Promise<{ readonly alreadyLive: boolean }> {
  const isPidAlive = params.isPidAlive ?? defaultIsPidAlive;
  return mutateLockedJsonFile<AntigravityWakeState, { readonly alreadyLive: boolean }>({
    stateDir: params.stateDir,
    name: "antigravity-wake",
    initial: initialAntigravityState,
    isPidAlive,
    mutate: (current) => {
      if (
        isAntigravityHelperLive(
          current,
          params.record.agyPid,
          params.record.agyStartToken,
          params.record.conversationId,
          isPidAlive,
        ) &&
        current.helper?.helperPid !== params.record.helperPid
      ) {
        return { next: current, result: { alreadyLive: true } };
      }
      return {
        next: {
          ...current,
          agyPid: params.record.agyPid,
          agyStartToken: params.record.agyStartToken,
          conversationId: params.record.conversationId,
          latchedFailed: false,
          helper: params.record,
        },
        result: { alreadyLive: false },
      };
    },
  });
}

export async function latchAntigravityFailed(params: {
  readonly stateDir: string;
  readonly agyPid: number;
  readonly agyStartToken: string;
  readonly conversationId: string;
}): Promise<void> {
  await mutateLockedJsonFile({
    stateDir: params.stateDir,
    name: "antigravity-wake",
    initial: initialAntigravityState,
    mutate: (current) => ({
      next: {
        ...current,
        agyPid: params.agyPid,
        agyStartToken: params.agyStartToken,
        conversationId: params.conversationId,
        latchedFailed: true,
      },
      result: undefined,
    }),
  });
}

export async function readAntigravityWakeState(
  stateDir: string,
): Promise<AntigravityWakeState> {
  return readRuntimeJsonFile(stateDir, "antigravity-wake", initialAntigravityState);
}

export async function setAntigravityReservation(
  stateDir: string,
  conversationId: string,
  reserved: boolean,
): Promise<boolean> {
  return mutateLockedJsonFile({
    stateDir,
    name: "antigravity-wake",
    initial: initialAntigravityState,
    mutate: (current) => {
      if (current.conversationId !== conversationId) {
        return { next: current, result: false };
      }
      if (reserved && (!current.idle || current.outstandingReservation)) {
        return { next: current, result: false };
      }
      return {
        next: { ...current, outstandingReservation: reserved },
        result: true,
      };
    },
  });
}

/* --------------------------------------------------------------------
 * Kimi one-shot arming and latch state
 * ------------------------------------------------------------------ */

export interface KimiSessionEntry {
  readonly pid: number;
  readonly startToken: string;
  readonly sessionId: string;
  readonly watcherPid: number | null;
  readonly armPending: boolean;
  readonly latchedReason: string | null;
}

export interface KimiWakeState {
  readonly sessions: Readonly<Record<string, KimiSessionEntry>>;
}

function initialKimiState(): KimiWakeState {
  return { sessions: {} };
}

function kimiEntryKey(pid: number, startToken: string): string {
  return `${pid}:${startToken}`;
}

export async function recordKimiSessionStart(params: {
  readonly stateDir: string;
  readonly pid: number;
  readonly startToken: string;
  readonly sessionId: string;
}): Promise<void> {
  const key = kimiEntryKey(params.pid, params.startToken);
  await mutateLockedJsonFile({
    stateDir: params.stateDir,
    name: "kimi-wake",
    initial: initialKimiState,
    mutate: (current) => {
      const existing = current.sessions[key];
      const sameSession = existing?.sessionId === params.sessionId;
      const entry: KimiSessionEntry = {
        pid: params.pid,
        startToken: params.startToken,
        sessionId: params.sessionId,
        watcherPid: sameSession ? (existing?.watcherPid ?? null) : null,
        armPending: false,
        latchedReason: null,
      };
      return {
        next: { sessions: { ...current.sessions, [key]: entry } },
        result: undefined,
      };
    },
  });
}

export async function requestKimiArm(params: {
  readonly stateDir: string;
  readonly pid: number;
  readonly startToken: string;
  readonly sessionId: string;
  readonly isPidAlive?: (pid: number) => boolean;
}): Promise<boolean> {
  const isPidAlive = params.isPidAlive ?? defaultIsPidAlive;
  const key = kimiEntryKey(params.pid, params.startToken);
  return mutateLockedJsonFile({
    stateDir: params.stateDir,
    name: "kimi-wake",
    initial: initialKimiState,
    isPidAlive,
    mutate: (current) => {
      const existing = current.sessions[key];
      if (existing !== undefined && existing.sessionId === params.sessionId) {
        if (existing.latchedReason !== null) {
          return { next: current, result: false };
        }
        if (existing.watcherPid !== null && isPidAlive(existing.watcherPid)) {
          return { next: current, result: false };
        }
        if (existing.armPending) {
          const latched: KimiSessionEntry = {
            ...existing,
            armPending: false,
            latchedReason: "unanswered",
          };
          return {
            next: { sessions: { ...current.sessions, [key]: latched } },
            result: false,
          };
        }
      }
      const armed: KimiSessionEntry = {
        pid: params.pid,
        startToken: params.startToken,
        sessionId: params.sessionId,
        watcherPid: null,
        armPending: true,
        latchedReason: null,
      };
      return {
        next: { sessions: { ...current.sessions, [key]: armed } },
        result: true,
      };
    },
  });
}

export async function claimKimiWatcherStart(params: {
  readonly stateDir: string;
  readonly parentPid: number;
  readonly parentStartToken: string;
  readonly watcherPid: number;
}): Promise<void> {
  const key = kimiEntryKey(params.parentPid, params.parentStartToken);
  await mutateLockedJsonFile({
    stateDir: params.stateDir,
    name: "kimi-wake",
    initial: initialKimiState,
    mutate: (current) => {
      const existing = current.sessions[key];
      const nextEntry: KimiSessionEntry = {
        pid: params.parentPid,
        startToken: params.parentStartToken,
        sessionId: existing?.sessionId ?? "active",
        watcherPid: params.watcherPid,
        armPending: false,
        latchedReason: existing?.latchedReason ?? null,
      };
      return {
        next: { sessions: { ...current.sessions, [key]: nextEntry } },
        result: undefined,
      };
    },
  });
}

export async function recordKimiWatcherFinish(params: {
  readonly stateDir: string;
  readonly parentPid: number;
  readonly parentStartToken: string;
  readonly watcherPid: number;
  readonly latchReason: string | null;
}): Promise<void> {
  const key = kimiEntryKey(params.parentPid, params.parentStartToken);
  await mutateLockedJsonFile({
    stateDir: params.stateDir,
    name: "kimi-wake",
    initial: initialKimiState,
    mutate: (current) => {
      const existing = current.sessions[key];
      if (existing === undefined || existing.watcherPid !== params.watcherPid) {
        return { next: current, result: undefined };
      }
      const updated: KimiSessionEntry = {
        ...existing,
        watcherPid: null,
        armPending: false,
        latchedReason: params.latchReason,
      };
      return {
        next: { sessions: { ...current.sessions, [key]: updated } },
        result: undefined,
      };
    },
  });
}

export async function clearKimiSession(params: {
  readonly stateDir: string;
  readonly pid: number;
  readonly startToken: string;
}): Promise<void> {
  const key = kimiEntryKey(params.pid, params.startToken);
  await mutateLockedJsonFile({
    stateDir: params.stateDir,
    name: "kimi-wake",
    initial: initialKimiState,
    mutate: (current) => {
      const nextSessions = { ...current.sessions };
      delete nextSessions[key];
      return { next: { sessions: nextSessions }, result: undefined };
    },
  });
}
