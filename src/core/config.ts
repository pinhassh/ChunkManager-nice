/**
 * Central configuration. Kept in one place so tuning behaviour (chunk length,
 * retry policy, server address) never requires touching business logic.
 */

/** Length of every recorded chunk. The spec requires exactly 30 seconds. */
export const CHUNK_DURATION_MS = 30_000;

/** Base URL of the local mock server. */
export const SERVER_URL = 'http://localhost:4000';

/**
 * Retry policy for uploads. Exponential backoff: delay = base * factor^(attempt-1),
 * capped at maxDelayMs. After maxAttempts the chunk stays "failed"/"pending" and is
 * retried later (e.g. when the network comes back or on the next app start).
 */
export const RETRY = {
  maxAttempts: 6,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  factor: 2,
  /**
   * Lifetime cap across ALL drains. Once a chunk's cumulative attempts exceed
   * this, it is dead-lettered (stops being retried and its blob is freed) so a
   * permanently-failing chunk can't be retried forever (R2).
   */
  maxLifetimeAttempts: 24,
} as const;

/** Every network request is aborted after this long so a hung connection can't stall the pipeline (R5). */
export const REQUEST_TIMEOUT_MS = 20_000;

/** Retention for pruning finished bookkeeping so storage never grows without bound (R2). */
export const RETENTION = {
  /** Completed session records older than this are pruned on startup. */
  completedSessionMs: 24 * 60 * 60 * 1_000,
} as const;

/** Maximum number of log rows kept in the on-screen list (R6). */
export const MAX_LOG_ENTRIES = 200;

/**
 * How often to probe real server reachability for the network indicator.
 * `navigator.onLine` is unreliable (true whenever any interface is up), so the UI
 * status is driven by whether the upload server actually answers.
 */
export const CONNECTIVITY_POLL_MS = 5_000;

/** IndexedDB database and object-store names. */
export const DB = {
  name: 'chunk-manager',
  // v2 adds the `status` index on the chunks store for memory-safe pending scans.
  version: 2,
  chunkStore: 'chunks',
  sessionStore: 'sessions',
} as const;

/** Preferred recording MIME types, most preferred first. */
export const MIME_CANDIDATES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
] as const;

/**
 * Compute the backoff delay (ms) before a given attempt number (1-based).
 * Exposed here so both the app and tests use the exact same formula.
 */
export function backoffDelayMs(attempt: number): number {
  const raw = RETRY.baseDelayMs * RETRY.factor ** (attempt - 1);
  return Math.min(raw, RETRY.maxDelayMs);
}
