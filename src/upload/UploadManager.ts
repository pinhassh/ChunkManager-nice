/**
 * UploadManager — the resilient upload engine and the heart of recovery.
 *
 * The IndexedDB store (`IChunkStore`) is the single source of truth: a chunk is
 * only considered safe once it is persisted, and only removed once the server
 * has confirmed it. Everything here is built around that invariant so we never
 * lose a recorded chunk.
 *
 * Recovery scenarios handled:
 *  - Network drop: uploads retry with exponential backoff; a chunk that can't be
 *    sent stays `pending`. `online`/`offline` listeners pause and resume draining.
 *  - Computer shutdown mid-shift: on startup {@link resume} finds chunks/sessions
 *    left behind (including a session interrupted while still "recording") and
 *    finishes uploading + finalizing them.
 *  - Mid-upload failure: the chunk stays `pending` until a 2xx arrives; the server
 *    is idempotent (keyed by sessionId/index) so a retry never duplicates.
 *  - Guaranteed finalize: the `complete` call is only sent once every chunk of a
 *    stopped session is uploaded, and is itself retried until it succeeds.
 */

import { RETRY, backoffDelayMs } from '../core/config';
import { logger } from '../core/Logger';
import type {
  ChunkRecord,
  CompletePayload,
  IApiClient,
  IChunkStore,
  SessionMeta,
} from '../recording/types';

/** Snapshot of upload progress for the UI. */
export interface UploadStats {
  pending: number;
  uploaded: number;
  draining: boolean;
}

export interface UploadManagerOptions {
  /** Notified whenever upload progress changes, so the UI can re-render. */
  onStats?: (stats: UploadStats) => void;
  /** Overridable delay (defaults to setTimeout) so tests can skip real waits. */
  sleep?: (ms: number) => Promise<void>;
}

export class UploadManager {
  private draining = false;
  /** Running count of chunks confirmed uploaded (for the UI). */
  private uploadedCount = 0;

  private readonly sleep: (ms: number) => Promise<void>;
  private onlineHandler?: () => void;
  private offlineHandler?: () => void;

  constructor(
    private readonly store: IChunkStore,
    private readonly api: IApiClient,
    private readonly options: UploadManagerOptions = {},
  ) {
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Subscribe to network up/down events so uploads pause and resume automatically. */
  attachNetworkListeners(): void {
    if (typeof window === 'undefined') return;

    this.onlineHandler = () => {
      logger.success('Network back online — resuming uploads.', {
        source: 'UploadManager.onlineHandler',
      });
      void this.drain();
    };
    this.offlineHandler = () => {
      logger.warning('Network offline — pausing uploads (recording continues).', {
        source: 'UploadManager.offlineHandler',
      });
      void this.emitStats();
    };

    window.addEventListener('online', this.onlineHandler);
    window.addEventListener('offline', this.offlineHandler);
  }

  /** Remove network listeners (used on teardown / in tests). */
  detachNetworkListeners(): void {
    if (typeof window === 'undefined') return;
    if (this.onlineHandler) window.removeEventListener('online', this.onlineHandler);
    if (this.offlineHandler) window.removeEventListener('offline', this.offlineHandler);
  }

  /**
   * Persist a freshly recorded chunk, then kick the queue. Persisting FIRST is
   * what makes the chunk crash-safe — even if the upload never happens, it is
   * on disk and will be retried on the next drain / app start.
   */
  async enqueueChunk(record: ChunkRecord): Promise<void> {
    await this.store.saveChunk(record);
    await this.emitStats();
    void this.drain();
  }

  /**
   * Recover after a reload or shutdown: adopt any interrupted session, then drain
   * pending chunks and finalize stopped sessions. Returns a small summary.
   */
  async resume(): Promise<{ pendingChunks: number; sessions: number }> {
    await this.reconcileInterruptedSessions();

    const pending = await this.store.getPendingChunks();
    const unfinished = (await this.store.getUnfinishedSessions()).filter(
      (s) => s.status !== 'recording',
    );

    if (pending.length === 0 && unfinished.length === 0) {
      logger.success('No unfinished work to resume.', { source: 'UploadManager.resume' });
      return { pendingChunks: 0, sessions: 0 };
    }

    logger.warning(
      `Resuming: ${pending.length} pending chunk(s), ${unfinished.length} unfinished session(s).`,
      { source: 'UploadManager.resume' },
    );
    await this.drain();
    return { pendingChunks: pending.length, sessions: unfinished.length };
  }

  /**
   * Drain the queue: upload every pending chunk in order, then finalize any
   * session that is stopped and fully uploaded. Single-flight — concurrent calls
   * are ignored while one drain is in progress.
   */
  async drain(): Promise<void> {
    if (this.draining) return;
    if (this.isOffline()) {
      logger.warning('Skipping drain — currently offline.', { source: 'UploadManager.drain' });
      return;
    }

    this.draining = true;
    await this.emitStats();
    try {
      // Re-read after each upload so chunks enqueued mid-drain are picked up.
      let pending = await this.store.getPendingChunks();
      while (pending.length > 0) {
        const uploaded = await this.uploadWithRetry(pending[0]);
        if (!uploaded) return; // exhausted/offline — retry on 'online' or next enqueue
        pending = await this.store.getPendingChunks();
      }
      await this.finalizeReadySessions();
    } catch (error) {
      logger.error('Unexpected error while draining the upload queue.', {
        source: 'UploadManager.drain',
        error,
      });
    } finally {
      this.draining = false;
      await this.emitStats();
    }
  }

  // --- internals -------------------------------------------------------------

  /**
   * Upload a single chunk with exponential-backoff retries. Attempts are capped
   * PER drain (not for the chunk's lifetime) so a later drain / app start always
   * gets a fresh set of tries. Returns true on success, false if we should stop.
   */
  private async uploadWithRetry(chunk: ChunkRecord): Promise<boolean> {
    const { sessionId, index } = chunk;

    for (let attempt = 1; attempt <= RETRY.maxAttempts; attempt++) {
      if (this.isOffline()) {
        logger.warning('Went offline mid-drain — will resume when back online.', {
          source: 'UploadManager.uploadWithRetry',
          context: { sessionId, chunkIndex: index, attempt },
        });
        return false;
      }

      try {
        await this.store.updateChunkStatus(sessionId, index, 'uploading', chunk.attempts + attempt);
        await this.api.uploadChunk(sessionId, index, chunk.blob);
        await this.onChunkUploaded(chunk);
        return true;
      } catch (error) {
        await this.store.updateChunkStatus(sessionId, index, 'failed', chunk.attempts + attempt);
        logger.warning(`Chunk upload failed (attempt ${attempt}/${RETRY.maxAttempts}).`, {
          source: 'UploadManager.uploadWithRetry',
          context: { sessionId, chunkIndex: index, attempt },
          error,
        });

        if (attempt >= RETRY.maxAttempts) {
          logger.error('Giving up on this chunk for now; it stays pending for a later retry.', {
            source: 'UploadManager.uploadWithRetry',
            context: { sessionId, chunkIndex: index },
          });
          return false;
        }
        await this.sleep(backoffDelayMs(attempt));
      }
    }
    return false;
  }

  /**
   * A chunk was accepted by the server: record its metadata on the session (so we
   * can build the finalize payload later) and delete the heavy blob to free space.
   */
  private async onChunkUploaded(chunk: ChunkRecord): Promise<void> {
    await this.appendUploadedMeta(chunk);
    await this.store.deleteChunk(chunk.sessionId, chunk.index);
    this.uploadedCount += 1;

    logger.success('Chunk uploaded and confirmed.', {
      source: 'UploadManager.onChunkUploaded',
      context: { sessionId: chunk.sessionId, chunkIndex: chunk.index },
    });
    await this.emitStats();
  }

  /** Append a chunk's lightweight metadata to its session (idempotent by index). */
  private async appendUploadedMeta(chunk: ChunkRecord): Promise<void> {
    const session = await this.store.getSession(chunk.sessionId);
    if (!session) return;

    const uploaded = session.uploadedChunks ?? [];
    if (uploaded.some((c) => c.index === chunk.index)) return; // already recorded

    uploaded.push({ index: chunk.index, size: chunk.size, durationMs: chunk.durationMs });
    session.uploadedChunks = uploaded;
    await this.store.saveSession(session);
  }

  /** Finalize every session that is stopped and has no pending chunks left. */
  private async finalizeReadySessions(): Promise<void> {
    const sessions = await this.store.getUnfinishedSessions();
    const pending = await this.store.getPendingChunks();

    for (const session of sessions) {
      if (session.status !== 'stopped') continue; // still recording — not ready
      const hasPending = pending.some((c) => c.sessionId === session.sessionId);
      if (hasPending) continue; // wait until all chunks are up
      await this.finalizeSession(session);
    }
  }

  /**
   * Send the `complete` signal (with all metadata needed to process the chunks)
   * and mark the session done. Retried until it succeeds so finalize also
   * survives outages.
   */
  private async finalizeSession(session: SessionMeta): Promise<void> {
    const chunks = (session.uploadedChunks ?? []).slice().sort((a, b) => a.index - b.index);
    const payload: CompletePayload = {
      sessionId: session.sessionId,
      totalChunks: session.totalChunks ?? chunks.length,
      startedAt: session.startedAt,
      endedAt: session.endedAt ?? Date.now(),
      mimeType: session.mimeType,
      chunks,
    };

    for (let attempt = 1; attempt <= RETRY.maxAttempts; attempt++) {
      if (this.isOffline()) return;
      try {
        await this.api.completeRecording(payload);
        await this.store.markSessionCompleted(session.sessionId);
        logger.success('Recording finalized — server notified of completion.', {
          source: 'UploadManager.finalizeSession',
          context: { sessionId: session.sessionId },
        });
        return;
      } catch (error) {
        logger.warning(`Finalize failed (attempt ${attempt}/${RETRY.maxAttempts}).`, {
          source: 'UploadManager.finalizeSession',
          context: { sessionId: session.sessionId, attempt },
          error,
        });
        if (attempt >= RETRY.maxAttempts) {
          logger.error('Could not finalize session now; will retry on next drain.', {
            source: 'UploadManager.finalizeSession',
            context: { sessionId: session.sessionId },
          });
          return;
        }
        await this.sleep(backoffDelayMs(attempt));
      }
    }
  }

  /**
   * A session still marked "recording" at startup was interrupted (e.g. the
   * machine was shut down mid-shift). Treat it as stopped so its chunks get
   * uploaded and it can be finalized.
   */
  private async reconcileInterruptedSessions(): Promise<void> {
    const sessions = await this.store.getUnfinishedSessions();
    const pending = await this.store.getPendingChunks();

    for (const session of sessions) {
      if (session.status !== 'recording') continue;

      const uploaded = (session.uploadedChunks ?? []).length;
      const pendingCount = pending.filter((c) => c.sessionId === session.sessionId).length;

      session.status = 'stopped';
      session.endedAt = session.endedAt ?? Date.now();
      session.totalChunks = session.totalChunks ?? uploaded + pendingCount;
      await this.store.saveSession(session);

      logger.warning('Recovered an interrupted recording session.', {
        source: 'UploadManager.reconcileInterruptedSessions',
        context: { sessionId: session.sessionId, totalChunks: session.totalChunks },
      });
    }
  }

  private isOffline(): boolean {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
  }

  /** Push a fresh progress snapshot to the UI, if a listener is registered. */
  private async emitStats(): Promise<void> {
    if (!this.options.onStats) return;
    const pending = await this.store.getPendingChunks();
    this.options.onStats({
      pending: pending.length,
      uploaded: this.uploadedCount,
      draining: this.draining,
    });
  }
}
