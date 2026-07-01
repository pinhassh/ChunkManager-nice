/**
 * Durable persistence layer over IndexedDB.
 *
 * `ChunkStore` is the crash-recovery backbone of ChunkManager: every recorded
 * chunk and every session is written here *before* it is uploaded, so that a page
 * reload, browser crash, or computer shutdown never loses data. On restart the app
 * scans this store for pending chunks and unfinished sessions and resumes.
 *
 * Design notes:
 *  - The `chunks` store uses a composite key `[sessionId, index]`, which makes
 *    writes idempotent (re-saving the same chunk overwrites rather than duplicates)
 *    and keeps records naturally ordered for the pending scan.
 *  - The `sessions` store is keyed by `sessionId`.
 *  - All IndexedDB requests/transactions are wrapped in Promises so callers work
 *    with async/await. Failures are logged with a precise `source` and re-thrown.
 */

import { DB } from '../core/config';
import { logger } from '../core/Logger';
import type {
  ChunkRecord,
  ChunkStatus,
  IChunkStore,
  SessionMeta,
} from '../recording/types';

export class ChunkStore implements IChunkStore {
  /** Cached open connection; set once `init()` succeeds. */
  private db: IDBDatabase | null = null;

  /**
   * Open (and if needed create) the database. Safe to call repeatedly — it is a
   * no-op once a connection is already cached.
   */
  async init(): Promise<void> {
    if (this.db) return; // already open — no-op

    try {
      this.db = await this.openDatabase();
      logger.success('IndexedDB opened', { source: 'ChunkStore.init' });
    } catch (error) {
      logger.error('Failed to open IndexedDB', { source: 'ChunkStore.init', error });
      throw error;
    }
  }

  /** Persist a chunk (idempotent via composite key). Stores the blob natively. */
  async saveChunk(record: ChunkRecord): Promise<void> {
    try {
      const store = this.tx(DB.chunkStore, 'readwrite');
      // `put` overwrites any existing record with the same [sessionId, index].
      await this.request(store.put(record));
      await this.done(store.transaction);
    } catch (error) {
      logger.error('Failed to save chunk', {
        source: 'ChunkStore.saveChunk',
        context: { sessionId: record.sessionId, chunkIndex: record.index },
        error,
      });
      throw error;
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
      const store = this.tx(DB.chunkStore, 'readwrite');
      const existing = await this.request<ChunkRecord | undefined>(
        store.get([sessionId, index]),
      );

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

  /** Remove a single chunk by its composite key. */
  async deleteChunk(sessionId: string, index: number): Promise<void> {
    try {
      const store = this.tx(DB.chunkStore, 'readwrite');
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

  /** All chunks not yet uploaded, ordered by (sessionId, index) ascending. */
  async getPendingChunks(): Promise<ChunkRecord[]> {
    try {
      const store = this.tx(DB.chunkStore, 'readonly');
      const all = await this.request<ChunkRecord[]>(store.getAll());
      await this.done(store.transaction);

      // Anything not confirmed uploaded still needs work.
      return all
        .filter((chunk) => chunk.status !== 'uploaded')
        .sort(
          (a, b) =>
            a.sessionId.localeCompare(b.sessionId) || a.index - b.index,
        );
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
      const store = this.tx(DB.sessionStore, 'readwrite');
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
      const store = this.tx(DB.sessionStore, 'readonly');
      const session = await this.request<SessionMeta | undefined>(
        store.get(sessionId),
      );
      await this.done(store.transaction);
      return session;
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
      const store = this.tx(DB.sessionStore, 'readonly');
      const all = await this.request<SessionMeta[]>(store.getAll());
      await this.done(store.transaction);
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
      const store = this.tx(DB.sessionStore, 'readwrite');
      const existing = await this.request<SessionMeta | undefined>(
        store.get(sessionId),
      );

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

  // --- internals -----------------------------------------------------------

  /** Open the database and create object stores on first use / version bump. */
  private openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open(DB.name, DB.version);

      open.onupgradeneeded = () => {
        const db = open.result;

        // Composite key [sessionId, index]: idempotent writes + ordered scans.
        if (!db.objectStoreNames.contains(DB.chunkStore)) {
          db.createObjectStore(DB.chunkStore, { keyPath: ['sessionId', 'index'] });
        }
        // Sessions keyed by their id.
        if (!db.objectStoreNames.contains(DB.sessionStore)) {
          db.createObjectStore(DB.sessionStore, { keyPath: 'sessionId' });
        }
      };

      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
  }

  /** Get an object store from a fresh transaction; throws if not initialised. */
  private tx(storeName: string, mode: IDBTransactionMode): IDBObjectStore {
    if (!this.db) {
      throw new Error('ChunkStore.init() must be called before use');
    }
    return this.db.transaction(storeName, mode).objectStore(storeName);
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
