/**
 * Durable persistence layer over IndexedDB.
 *
 * `ChunkStore` is the crash-recovery backbone of ChunkManager: every recorded
 * chunk and every session is written here *before* it is uploaded, so that a page
 * reload, browser crash, or computer shutdown never loses data. On restart the app
 * scans this store for pending chunks and unfinished sessions and resumes.
 *
 * Resource-safety (see docs/PROJECT_PLAN.md → Robustness requirements):
 *  - **R1 (no unbounded loads):** the hot-path scans return only keys/counts via a
 *    `status` index — blobs are loaded one at a time with `getChunk`. `getPendingChunks`
 *    (full load) is kept for tests/inspection only.
 *  - **R2 (nothing lives forever):** dead chunks are tombstoned (blob freed) and
 *    completed sessions can be pruned by retention.
 *  - **R3 (quota):** `saveChunk` catches `QuotaExceededError`, tries to reclaim space,
 *    and throws a typed `StorageFullError` if still full.
 *  - **R4 (lifecycle):** the connection handles `onversionchange`/`onclose` and is
 *    transparently re-opened via `ensureDb()`.
 *
 * Design notes:
 *  - The `chunks` store uses a composite key `[sessionId, index]` (idempotent writes,
 *    ordered scans) and a `status` index (memory-safe pending queries).
 *  - The `sessions` store is keyed by `sessionId`.
 */

import { DB } from '../core/config';
import { logger } from '../core/Logger';
import type {
  ChunkKey,
  ChunkRecord,
  ChunkStatus,
  IChunkStore,
  SessionMeta,
} from '../recording/types';

/** Statuses that still require upload work (excludes 'uploaded' and 'dead'). */
const ACTIVE_STATUSES: ChunkStatus[] = ['pending', 'uploading', 'failed'];

const STATUS_INDEX = 'status';

/** Thrown when a write fails because storage is full and space could not be reclaimed. */
export class StorageFullError extends Error {
  constructor(cause?: unknown) {
    super('Storage quota exceeded — cannot persist more data');
    this.name = 'StorageFullError';
    if (cause !== undefined) this.cause = cause;
  }
}

/** True for the browser's quota-exceeded error. */
function isQuotaError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'QuotaExceededError';
}

export class ChunkStore implements IChunkStore {
  /** Cached open connection; set once `init()` succeeds, cleared on close. */
  private db: IDBDatabase | null = null;

  /**
   * Open (and if needed create/upgrade) the database. Safe to call repeatedly — a
   * no-op once a connection is cached; re-opens transparently after a close.
   */
  async init(): Promise<void> {
    if (this.db) return;

    try {
      this.db = await this.openDatabase();
      logger.success('IndexedDB opened', { source: 'ChunkStore.init' });
    } catch (error) {
      logger.error('Failed to open IndexedDB', { source: 'ChunkStore.init', error });
      throw error;
    }
  }

  /**
   * Persist a chunk (idempotent via composite key). On `QuotaExceededError` it tries
   * to reclaim space and retries once, otherwise throws {@link StorageFullError} (R3).
   */
  async saveChunk(record: ChunkRecord): Promise<void> {
    try {
      await this.putChunk(record);
    } catch (error) {
      if (!isQuotaError(error)) {
        logger.error('Failed to save chunk', {
          source: 'ChunkStore.saveChunk',
          context: { sessionId: record.sessionId, chunkIndex: record.index },
          error,
        });
        throw error;
      }

      logger.warning('Storage quota exceeded — attempting to reclaim space.', {
        source: 'ChunkStore.saveChunk',
        context: { sessionId: record.sessionId, chunkIndex: record.index },
      });
      await this.pruneCompletedSessions(0).catch(() => 0);

      try {
        await this.putChunk(record);
        logger.success('Reclaimed space and saved chunk.', {
          source: 'ChunkStore.saveChunk',
          context: { sessionId: record.sessionId, chunkIndex: record.index },
        });
      } catch (retryError) {
        logger.error('Storage still full after reclaim — cannot persist chunk.', {
          source: 'ChunkStore.saveChunk',
          context: { sessionId: record.sessionId, chunkIndex: record.index },
          error: retryError,
        });
        throw new StorageFullError(retryError);
      }
    }
  }

  /**
   * Update a chunk's status (and optionally its attempt count) in place. Warns and
   * returns if no matching chunk exists.
   */
  async updateChunkStatus(
    sessionId: string,
    index: number,
    status: ChunkStatus,
    attempts?: number,
  ): Promise<void> {
    try {
      const store = await this.objectStore(DB.chunkStore, 'readwrite');
      const existing = await this.request<ChunkRecord | undefined>(store.get([sessionId, index]));

      if (!existing) {
        logger.warning('Chunk not found for status update', {
          source: 'ChunkStore.updateChunkStatus',
          context: { sessionId, chunkIndex: index },
        });
        return;
      }

      existing.status = status;
      if (attempts !== undefined) existing.attempts = attempts;

      await this.request(store.put(existing));
      await this.done(store.transaction);
    } catch (error) {
      logger.error('Failed to update chunk status', {
        source: 'ChunkStore.updateChunkStatus',
        context: { sessionId, chunkIndex: index },
        error,
      });
      throw error;
    }
  }

  /**
   * Dead-letter a chunk: mark it 'dead' and replace its blob with an empty one so the
   * heavy payload is freed while a tombstone remains for diagnostics. Never retried (R2).
   */
  async markChunkDead(sessionId: string, index: number): Promise<void> {
    try {
      const store = await this.objectStore(DB.chunkStore, 'readwrite');
      const existing = await this.request<ChunkRecord | undefined>(store.get([sessionId, index]));
      if (!existing) return;

      existing.status = 'dead';
      existing.blob = new Blob([]); // free the payload, keep the tombstone
      await this.request(store.put(existing));
      await this.done(store.transaction);
    } catch (error) {
      logger.error('Failed to dead-letter chunk', {
        source: 'ChunkStore.markChunkDead',
        context: { sessionId, chunkIndex: index },
        error,
      });
      throw error;
    }
  }

  /** Remove a single chunk by its composite key. */
  async deleteChunk(sessionId: string, index: number): Promise<void> {
    try {
      const store = await this.objectStore(DB.chunkStore, 'readwrite');
      await this.request(store.delete([sessionId, index]));
      await this.done(store.transaction);
    } catch (error) {
      logger.error('Failed to delete chunk', {
        source: 'ChunkStore.deleteChunk',
        context: { sessionId, chunkIndex: index },
        error,
      });
      throw error;
    }
  }

  /** Load one chunk (with its blob) by key — the memory-safe way to fetch a payload (R1). */
  async getChunk(sessionId: string, index: number): Promise<ChunkRecord | undefined> {
    try {
      const store = await this.objectStore(DB.chunkStore, 'readonly');
      return await this.request<ChunkRecord | undefined>(store.get([sessionId, index]));
    } catch (error) {
      logger.error('Failed to read chunk', {
        source: 'ChunkStore.getChunk',
        context: { sessionId, chunkIndex: index },
        error,
      });
      throw error;
    }
  }

  /**
   * Keys of chunks still needing work, ordered by (sessionId, index). Uses the status
   * index's `getAllKeys`, so NO blobs are loaded into memory (R1).
   */
  async getPendingChunkKeys(): Promise<ChunkKey[]> {
    try {
      const store = await this.objectStore(DB.chunkStore, 'readonly');
      const index = store.index(STATUS_INDEX);
      const perStatus = await Promise.all(
        ACTIVE_STATUSES.map((status) =>
          this.request<IDBValidKey[]>(index.getAllKeys(IDBKeyRange.only(status))),
        ),
      );

      return perStatus
        .flat()
        .map((key) => {
          const [sessionId, chunkIndex] = key as [string, number];
          return { sessionId, index: chunkIndex };
        })
        .sort((a, b) => a.sessionId.localeCompare(b.sessionId) || a.index - b.index);
    } catch (error) {
      logger.error('Failed to read pending chunk keys', {
        source: 'ChunkStore.getPendingChunkKeys',
        error,
      });
      throw error;
    }
  }

  /** Count chunks still needing work, without loading any records (R1). */
  async countPendingChunks(): Promise<number> {
    try {
      const store = await this.objectStore(DB.chunkStore, 'readonly');
      const index = store.index(STATUS_INDEX);
      const counts = await Promise.all(
        ACTIVE_STATUSES.map((status) =>
          this.request<number>(index.count(IDBKeyRange.only(status))),
        ),
      );
      return counts.reduce((sum, n) => sum + n, 0);
    } catch (error) {
      logger.error('Failed to count pending chunks', {
        source: 'ChunkStore.countPendingChunks',
        error,
      });
      throw error;
    }
  }

  /**
   * All chunks still needing work, WITH blobs. Loads everything into memory — for
   * tests/inspection only; hot paths must use the key/count/getChunk methods (R1).
   */
  async getPendingChunks(): Promise<ChunkRecord[]> {
    try {
      const store = await this.objectStore(DB.chunkStore, 'readonly');
      const all = await this.request<ChunkRecord[]>(store.getAll());
      return all
        .filter((chunk) => chunk.status !== 'uploaded' && chunk.status !== 'dead')
        .sort((a, b) => a.sessionId.localeCompare(b.sessionId) || a.index - b.index);
    } catch (error) {
      logger.error('Failed to read pending chunks', {
        source: 'ChunkStore.getPendingChunks',
        error,
      });
      throw error;
    }
  }

  /** Persist session metadata (idempotent via sessionId key). */
  async saveSession(meta: SessionMeta): Promise<void> {
    try {
      const store = await this.objectStore(DB.sessionStore, 'readwrite');
      await this.request(store.put(meta));
      await this.done(store.transaction);
    } catch (error) {
      logger.error('Failed to save session', {
        source: 'ChunkStore.saveSession',
        context: { sessionId: meta.sessionId },
        error,
      });
      throw error;
    }
  }

  /** Fetch a session by id, or `undefined` if none exists. */
  async getSession(sessionId: string): Promise<SessionMeta | undefined> {
    try {
      const store = await this.objectStore(DB.sessionStore, 'readonly');
      return await this.request<SessionMeta | undefined>(store.get(sessionId));
    } catch (error) {
      logger.error('Failed to read session', {
        source: 'ChunkStore.getSession',
        context: { sessionId },
        error,
      });
      throw error;
    }
  }

  /** Sessions whose status is not yet "completed" (candidates for recovery). */
  async getUnfinishedSessions(): Promise<SessionMeta[]> {
    try {
      const store = await this.objectStore(DB.sessionStore, 'readonly');
      // Session records are small (no blobs), so a full read here is acceptable (R1).
      const all = await this.request<SessionMeta[]>(store.getAll());
      return all.filter((session) => session.status !== 'completed');
    } catch (error) {
      logger.error('Failed to read unfinished sessions', {
        source: 'ChunkStore.getUnfinishedSessions',
        error,
      });
      throw error;
    }
  }

  /** Mark a session as completed. Warns and returns if the session is missing. */
  async markSessionCompleted(sessionId: string): Promise<void> {
    try {
      const store = await this.objectStore(DB.sessionStore, 'readwrite');
      const existing = await this.request<SessionMeta | undefined>(store.get(sessionId));

      if (!existing) {
        logger.warning('Session not found to mark completed', {
          source: 'ChunkStore.markSessionCompleted',
          context: { sessionId },
        });
        return;
      }

      existing.status = 'completed';
      await this.request(store.put(existing));
      await this.done(store.transaction);
    } catch (error) {
      logger.error('Failed to mark session completed', {
        source: 'ChunkStore.markSessionCompleted',
        context: { sessionId },
        error,
      });
      throw error;
    }
  }

  /** Delete a session record by id (its chunks are removed separately). */
  async deleteSession(sessionId: string): Promise<void> {
    try {
      const store = await this.objectStore(DB.sessionStore, 'readwrite');
      await this.request(store.delete(sessionId));
      await this.done(store.transaction);
    } catch (error) {
      logger.error('Failed to delete session', {
        source: 'ChunkStore.deleteSession',
        context: { sessionId },
        error,
      });
      throw error;
    }
  }

  /**
   * Prune completed sessions whose `endedAt` is older than the cutoff, so bookkeeping
   * never grows without bound (R2). Returns how many were removed.
   */
  async pruneCompletedSessions(olderThanMs: number): Promise<number> {
    try {
      const cutoff = Date.now() - olderThanMs;
      const store = await this.objectStore(DB.sessionStore, 'readwrite');
      const all = await this.request<SessionMeta[]>(store.getAll());

      let removed = 0;
      for (const session of all) {
        if (session.status === 'completed' && (session.endedAt ?? 0) <= cutoff) {
          await this.request(store.delete(session.sessionId));
          removed += 1;
        }
      }
      await this.done(store.transaction);

      if (removed > 0) {
        logger.success(`Pruned ${removed} completed session(s).`, {
          source: 'ChunkStore.pruneCompletedSessions',
        });
      }
      return removed;
    } catch (error) {
      logger.error('Failed to prune completed sessions', {
        source: 'ChunkStore.pruneCompletedSessions',
        error,
      });
      throw error;
    }
  }

  // --- internals -----------------------------------------------------------

  /** Put a chunk (used by saveChunk; kept separate so quota handling can retry it). */
  private async putChunk(record: ChunkRecord): Promise<void> {
    const store = await this.objectStore(DB.chunkStore, 'readwrite');
    // `put` overwrites any existing record with the same [sessionId, index].
    await this.request(store.put(record));
    await this.done(store.transaction);
  }

  /** Open the database, creating/upgrading stores and the status index. */
  private openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open(DB.name, DB.version);

      open.onupgradeneeded = () => {
        const db = open.result;
        const upgradeTx = open.transaction; // the versionchange transaction

        const chunks = db.objectStoreNames.contains(DB.chunkStore)
          ? upgradeTx!.objectStore(DB.chunkStore)
          : db.createObjectStore(DB.chunkStore, { keyPath: ['sessionId', 'index'] });

        // Index on status enables memory-safe pending scans (keys/counts, no blobs).
        if (!chunks.indexNames.contains(STATUS_INDEX)) {
          chunks.createIndex(STATUS_INDEX, 'status', { unique: false });
        }

        if (!db.objectStoreNames.contains(DB.sessionStore)) {
          db.createObjectStore(DB.sessionStore, { keyPath: 'sessionId' });
        }
      };

      open.onsuccess = () => {
        const db = open.result;
        // R4: react to the connection becoming invalid so we transparently re-open.
        db.onversionchange = () => {
          logger.warning('IndexedDB version change in another tab — closing connection.', {
            source: 'ChunkStore.onversionchange',
          });
          db.close();
          this.db = null;
        };
        db.onclose = () => {
          this.db = null;
        };
        resolve(db);
      };

      open.onerror = () => reject(open.error);
    });
  }

  /** Ensure a live connection (re-opening if it was closed), then hand back the DB. */
  private async ensureDb(): Promise<IDBDatabase> {
    if (!this.db) await this.init();
    if (!this.db) throw new Error('ChunkStore: database unavailable');
    return this.db;
  }

  /** Get an object store from a fresh transaction on a guaranteed-live connection. */
  private async objectStore(
    storeName: string,
    mode: IDBTransactionMode,
  ): Promise<IDBObjectStore> {
    const db = await this.ensureDb();
    return db.transaction(storeName, mode).objectStore(storeName);
  }

  /** Wrap an `IDBRequest` in a Promise (resolve on success, reject on error). */
  private request<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /** Wait for a transaction to fully commit (or fail). */
  private done(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }
}
