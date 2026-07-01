/**
 * ChunkStore tests — persistence CRUD, pending-only queries, session lifecycle,
 * and durability across a simulated "restart" (a second connection to the same DB).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { ChunkStore } from '../src/storage/ChunkStore';
import type { ChunkRecord, ChunkStatus, SessionMeta } from '../src/recording/types';

// A clean, isolated in-memory IndexedDB for every test.
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

function makeChunk(sessionId: string, index: number, status: ChunkStatus = 'pending'): ChunkRecord {
  return {
    sessionId,
    index,
    size: 10,
    durationMs: 30_000,
    mimeType: 'video/webm',
    createdAt: 1_000 + index,
    status,
    attempts: 0,
    blob: new Blob(['x'.repeat(10)], { type: 'video/webm' }),
  };
}

function makeSession(sessionId: string, status: SessionMeta['status'] = 'recording'): SessionMeta {
  return {
    sessionId,
    status,
    startedAt: 1_000,
    endedAt: null,
    mimeType: 'video/webm',
    totalChunks: null,
    uploadedChunks: [],
  };
}

async function freshStore(): Promise<ChunkStore> {
  const store = new ChunkStore();
  await store.init();
  return store;
}

describe('ChunkStore — chunks', () => {
  it('saves a chunk and lists it as pending', async () => {
    const store = await freshStore();
    await store.saveChunk(makeChunk('s1', 0));

    const pending = await store.getPendingChunks();
    expect(pending).toHaveLength(1);
    expect(pending[0].sessionId).toBe('s1');
    expect(pending[0].size).toBe(10);
    expect(pending[0].blob).toBeDefined();
  });

  it('excludes uploaded chunks from the pending list', async () => {
    const store = await freshStore();
    await store.saveChunk(makeChunk('s1', 0));
    await store.updateChunkStatus('s1', 0, 'uploaded');

    expect(await store.getPendingChunks()).toHaveLength(0);
  });

  it('deletes a chunk by composite key', async () => {
    const store = await freshStore();
    await store.saveChunk(makeChunk('s1', 0));
    await store.deleteChunk('s1', 0);

    expect(await store.getPendingChunks()).toHaveLength(0);
  });

  it('returns pending chunks ordered by (sessionId, index)', async () => {
    const store = await freshStore();
    await store.saveChunk(makeChunk('s2', 1));
    await store.saveChunk(makeChunk('s1', 2));
    await store.saveChunk(makeChunk('s1', 0));

    const order = (await store.getPendingChunks()).map((c) => `${c.sessionId}:${c.index}`);
    expect(order).toEqual(['s1:0', 's1:2', 's2:1']);
  });

  it('overwrites (idempotent) when saving the same key twice', async () => {
    const store = await freshStore();
    await store.saveChunk(makeChunk('s1', 0));
    await store.saveChunk({ ...makeChunk('s1', 0), size: 99 });

    const pending = await store.getPendingChunks();
    expect(pending).toHaveLength(1);
    expect(pending[0].size).toBe(99);
  });

  it('warns (does not throw) when updating a missing chunk', async () => {
    const store = await freshStore();
    await expect(store.updateChunkStatus('nope', 5, 'uploaded')).resolves.toBeUndefined();
  });
});

describe('ChunkStore — sessions', () => {
  it('saves and reads a session', async () => {
    const store = await freshStore();
    await store.saveSession(makeSession('s1'));

    const s = await store.getSession('s1');
    expect(s?.status).toBe('recording');
  });

  it('lists only unfinished sessions', async () => {
    const store = await freshStore();
    await store.saveSession(makeSession('s1', 'stopped'));
    await store.saveSession(makeSession('s2', 'completed'));

    const unfinished = await store.getUnfinishedSessions();
    expect(unfinished.map((s) => s.sessionId)).toEqual(['s1']);
  });

  it('marks a session completed', async () => {
    const store = await freshStore();
    await store.saveSession(makeSession('s1', 'stopped'));
    await store.markSessionCompleted('s1');

    expect((await store.getSession('s1'))?.status).toBe('completed');
  });
});

describe('ChunkStore — durability', () => {
  it('data survives a simulated restart (new connection, same DB)', async () => {
    const first = await freshStore();
    await first.saveChunk(makeChunk('s1', 0));
    await first.saveSession(makeSession('s1'));

    // Simulate the app restarting: a brand-new ChunkStore over the SAME database.
    const second = await freshStore();
    expect(await second.getPendingChunks()).toHaveLength(1);
    expect(await second.getSession('s1')).toBeDefined();
  });
});
