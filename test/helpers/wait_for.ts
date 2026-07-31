export interface WaitForOptions {
  readonly timeoutMs?: number;
  readonly message: string;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 10;

export async function waitFor(
  predicate: () => boolean,
  { timeoutMs = DEFAULT_TIMEOUT_MS, message }: WaitForOptions,
): Promise<void> {
  const startedAt = Date.now();

  while (!predicate()) {
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${message}`);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(POLL_INTERVAL_MS, timeoutMs - elapsedMs));
    });
  }
}
