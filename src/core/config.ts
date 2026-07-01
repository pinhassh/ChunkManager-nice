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
} as const;

/** IndexedDB database and object-store names. */
export const DB = {
  name: 'chunk-manager',
  version: 1,
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
