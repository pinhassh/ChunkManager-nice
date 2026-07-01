/**
 * ChunkStore resource-safety tests (CM-11): memory-safe queries, dead-letter,
 * quota handling, pruning, and transparent reconnection after a closed DB.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { ChunkStore, StorageFullError } from '../src/storage/ChunkStore';
import type { ChunkRecord, SessionMeta } from '../src/recording/types';

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

function makeChunk(sessionId: string, index: number): ChunkRecord {
  return {
    sessionId,
    index,
    size: 10,
    durationMs: 30_000,
    mimeType: 'video/webm',
    createdAt: 1_000 + index,
    status: 'pending',
    attempts: 0,
    blob: new Blob(['x'.repeat(10)], { type: 'video/webm' }),
  };
}

function makeSession(sessionId: string, over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId,
    status: 'recording',
    startedAt: 1_000,
    endedAt: null,
    mimeType: 'video/webm',
    totalChunks: null,
    uploadedChunks: [],
    ...over,
  };
}

async function freshStore(): Promise<ChunkStore> {
  const store = new ChunkStore();
  await store.init();
  return store;
}

describe('ChunkStore — memory-safe queries (R1)', () => {
  it('counts and lists only active (non-uploaded, non-dead) chunk keys', async () => {
    const store = await freshStore();
    await store.saveChunk(makeChunk('s1', 0)); // pending
    await store.saveChunk(makeChunk('s1', 1));
    await store.updateChunkStatus('s1', 1, 'uploaded'); // excluded
    await store.saveChunk(makeChunk('s1', 2));
    await store.markChunkDead('s1', 2); // excluded

    expect(await store.countPendingChunks()).toBe(1);
    expect(await store.getPendingChunkKeys()).toEqual([{ sessionId: 's1', index: 0 }]);
  });

  it('getChunk loads a single record by key', async () => {
    const store = await freshStore();
    await store.saveChunk(makeChunk('s1', 5));

    expect((await store.getChunk('s1', 5))?.index).toBe(5);
    expect(await store.getChunk('s1', 99)).toBeUndefined();
  });
});

describe('ChunkStore — dead-letter (R2)', () => {
  it('tombstones a chunk: excluded from pending, kept as dead', async () => {
    const store = await freshStore();
    await store.saveChunk(makeChunk('s1', 0));
    await store.markChunkDead('s1', 0);

    expect(await store.countPendingChunks()).toBe(0);
    expect(await store.getPendingChunkKeys()).toHaveLength(0);
    expect((await store.getChunk('s1', 0))?.status).toBe('dead');
  });

  it('prunes completed sessions older than the cutoff', async () => {
    const store = await freshStore();
    await store.saveSession(makeSession('old', { status: 'completed', endedAt: 1_000 }));
    await store.saveSession(makeSession('recent', { status: 'completed', endedAt: Date.now() }));
    await store.saveSession(makeSession('active', { status: 'stopped', endedAt: 2_000 }));

    const removed = await store.pruneCompletedSessions(60_000); // older than 60s

    expect(removed).toBe(1);
    expect(await store.getSession('old')).toBeUndefined();
    expect(await store.getSession('recent')).toBeDefined();
    expect(await store.getSession('active')).toBeDefined();
  });
});

describe('ChunkStore — quota handling (R3)', () => {
  it('throws StorageFullError when storage stays full after reclaim', async () => {
    const store = await freshStore();
    // Force the low-level write to always hit quota.
    (store as unknown as { putChunk: () => Promise<void> }).putChunk = vi
      .fn()
      .mockRejectedValue(new DOMException('full', 'QuotaExceededError'));

    await expect(store.saveChunk(makeChunk('s1', 0))).rejects.toBeInstanceOf(StorageFullError);
  });

  it('recovers when space is reclaimed after a quota error', async () => {
    const store = await freshStore();
    const put = vi
      .fn()
      .mockRejectedValueOnce(new DOMException('full', 'QuotaExceededError'))
      .mockResolvedValueOnce(undefined);
    (store as unknown as { putChunk: () => Promise<void> }).putChunk = put;

    await expect(store.saveChunk(makeChunk('s1', 0))).resolves.toBeUndefined();
    expect(put).toHaveBeenCalledTimes(2); // failed once, retried and succeeded
  });
});

describe('ChunkStore — connection lifecycle (R4)', () => {
  it('transparently re-opens the connection after it was closed', async () => {
    const store = await freshStore();
    await store.saveChunk(makeChunk('s1', 0));

    // Simulate the browser closing the connection (e.g. user cleared data / versionchange).
    const internals = store as unknown as { db: IDBDatabase | null };
    internals.db?.close();
    internals.db = null;

    // The next operation should re-open without the caller doing anything.
    expect(await store.getPendingChunkKeys()).toHaveLength(1);
  });
});
