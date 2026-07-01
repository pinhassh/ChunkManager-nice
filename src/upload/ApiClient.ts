/**
 * Thin HTTP client for the mock upload server.
 *
 * Its only job is to translate the upload domain operations into `fetch` calls
 * and to turn non-2xx responses / network failures into informative errors.
 * All retry/queue/recovery policy lives in {@link UploadManager} — this layer
 * stays dumb and easy to fake in tests.
 */

import { REQUEST_TIMEOUT_MS, SERVER_URL } from '../core/config';
import type { CompletePayload, IApiClient } from '../recording/types';

/**
 * Error thrown when a request fails or returns a non-2xx status. Carries the
 * method, URL and (when available) HTTP status so callers can log exactly which
 * call fell over and why.
 */
export class HttpError extends Error {
  constructor(
    readonly method: string,
    readonly url: string,
    readonly status: number | null,
    cause?: unknown,
  ) {
    const where = status === null ? 'network failure' : `HTTP ${status}`;
    super(`${method} ${url} failed: ${where}`);
    this.name = 'HttpError';
    if (cause !== undefined) this.cause = cause;
  }
}

export class ApiClient implements IApiClient {
  constructor(
    private readonly baseUrl: string = SERVER_URL,
    private readonly timeoutMs: number = REQUEST_TIMEOUT_MS,
  ) {}

  /** Upload one chunk's binary payload to `/recordings/:sessionId/chunks/:index`. */
  async uploadChunk(sessionId: string, index: number, blob: Blob): Promise<void> {
    const url = `${this.baseUrl}/recordings/${encodeURIComponent(sessionId)}/chunks/${index}`;
    await this.send('POST', url, {
      headers: { 'Content-Type': 'application/octet-stream' },
      body: blob,
    });
  }

  /** Notify the server that a recording finished, with all metadata to process it. */
  async completeRecording(payload: CompletePayload): Promise<void> {
    const url = `${this.baseUrl}/recordings/${encodeURIComponent(payload.sessionId)}/complete`;
    await this.send('POST', url, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  /** Ask the server which chunk indexes it already has (for resume/reconcile). */
  async getSessionStatus(sessionId: string): Promise<{ receivedIndexes: number[] }> {
    const url = `${this.baseUrl}/recordings/${encodeURIComponent(sessionId)}/status`;
    const res = await this.send('GET', url);
    const data = (await res.json()) as { receivedIndexes?: number[] };
    return { receivedIndexes: data.receivedIndexes ?? [] };
  }

  /**
   * Perform a fetch and normalise failures. Every request is bounded by an
   * AbortController timeout so a hung connection can't stall the pipeline (R5).
   * - A rejected fetch (offline/DNS/timeout/etc.) becomes HttpError with status null.
   * - A non-2xx response becomes HttpError with the real status.
   */
  private async send(method: string, url: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, { method, ...init, signal: controller.signal });
    } catch (error) {
      // Network-level failure or timeout abort (server down, connection dropped, ...).
      throw new HttpError(method, url, null, error);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new HttpError(method, url, response.status);
    }
    return response;
  }
}
