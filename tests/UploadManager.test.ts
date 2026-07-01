/**
 * UploadManager tests — the recovery core.
 *
 * Covers positive drain + finalize, retry/backoff on failure, giving up after
 * max attempts (chunk stays pending), offline→online resumption, and crash
 * recovery via resume() (including a session interrupted mid-recording).
 *
 * Uses a real ChunkStore over fake-indexeddb and a fake ApiClient. Backoff waits
 * are stubbed to resolve instantly so tests are fast and deterministic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { ChunkStore, StorageFullError } from '../src/storage/ChunkStore';
import { UploadManager } from '../src/upload/UploadManager';
import { RETRY } from '../src/core/config';
import type { ChunkRecord, CompletePayload, IApiClient, SessionMeta } from '../src/recording/types';

class FakeApi implements IApiClient {
  uploadChunk = vi.fn(async (_s: string, _i: number, _b: Blob) => {});
  completeRecording = vi.fn(async (_payload: CompletePayload) => {});
  getSessionStatus = vi.fn(async () => ({ receivedIndexes: [] as number[] }));
}

const noSleep = () => Promise.resolve();

function setOnline(value: boolean): void {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => value });
}

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

let store: ChunkStore;
let api: FakeApi;

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  setOnline(true);
  store = new ChunkStore();
  await store.init();
  api = new FakeApi();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('UploadManager — happy path', () => {
  it('uploads all pending chunks in order and finalizes the session', async () => {
    await store.saveSession(makeSession('s1', { status: 'stopped', totalChunks: 3, endedAt: 2_000 }));
    for (const i of [0, 1, 2]) await store.saveChunk(makeChunk('s1', i));

    const um = new UploadManager(store, api, { sleep: noSleep });
    await um.drain();

    expect(api.uploadChunk).toHaveBeenCalledTimes(3);
    expect(api.uploadChunk.mock.calls.map((c) => c[1])).toEqual([0, 1, 2]);
    expect(await store.getPendingChunks()).toHaveLength(0);

    expect(api.completeRecording).toHaveBeenCalledTimes(1);
    const payload = api.completeRecording.mock.calls[0][0] as unknown as { totalChunks: number; chunks: unknown[] };
    expect(payload.totalChunks).toBe(3);
    expect(payload.chunks).toHaveLength(3);
    expect((await store.getSession('s1'))?.status).toBe('completed');
  });

  it('does NOT finalize while the session is still recording', async () => {
    await store.saveSession(makeSession('s1')); // status: recording
    await store.saveChunk(makeChunk('s1', 0));

    const um = new UploadManager(store, api, { sleep: noSleep });
    await um.drain();

    expect(api.uploadChunk).toHaveBeenCalledTimes(1);
    expect(api.completeRecording).not.toHaveBeenCalled();
  });
});

describe('UploadManager — failures & retries', () => {
  it('retries with backoff and eventually succeeds', async () => {
    api.uploadChunk
      .mockRejectedValueOnce(new Error('net'))
      .mockRejectedValueOnce(new Error('net'))
      .mockResolvedValueOnce(undefined);

    await store.saveSession(makeSession('s1'));
    await store.saveChunk(makeChunk('s1', 0));

    const um = new UploadManager(store, api, { sleep: noSleep });
    await um.drain();

    expect(api.uploadChunk).toHaveBeenCalledTimes(3);
    expect(await store.getPendingChunks()).toHaveLength(0);
  });

  it('gives up after max attempts and leaves the chunk pending', async () => {
    api.uploadChunk.mockRejectedValue(new Error('always down'));

    await store.saveSession(makeSession('s1'));
    await store.saveChunk(makeChunk('s1', 0));

    const um = new UploadManager(store, api, { sleep: noSleep });
    await um.drain();

    expect(api.uploadChunk).toHaveBeenCalledTimes(RETRY.maxAttempts);
    expect(await store.getPendingChunks()).toHaveLength(1);
    expect(api.completeRecording).not.toHaveBeenCalled();
  });
});

describe('UploadManager — network resilience', () => {
  it('skips draining while offline, then uploads when back online', async () => {
    setOnline(false);
    await store.saveSession(makeSession('s1'));
    await store.saveChunk(makeChunk('s1', 0));

    const um = new UploadManager(store, api, { sleep: noSleep });
    um.attachNetworkListeners();

    await um.drain(); // offline → no-op
    expect(api.uploadChunk).not.toHaveBeenCalled();
    expect(await store.getPendingChunks()).toHaveLength(1);

    setOnline(true);
    window.dispatchEvent(new Event('online')); // triggers an async drain

    // Poll until the event-driven drain finishes (robust to IndexedDB async hops).
    await vi.waitFor(async () => {
      expect(await store.countPendingChunks()).toBe(0);
    });
    expect(api.uploadChunk).toHaveBeenCalledTimes(1);
    um.detachNetworkListeners();
  });
});

describe('UploadManager — crash recovery', () => {
  it('enqueueChunk persists before uploading (durability)', async () => {
    setOnline(false); // prevent the background drain from consuming it
    const um = new UploadManager(store, api, { sleep: noSleep });

    await um.enqueueChunk(makeChunk('s1', 0));

    expect(await store.getPendingChunks()).toHaveLength(1);
    expect(api.uploadChunk).not.toHaveBeenCalled();
  });

  it('resume() recovers an interrupted (still-"recording") session, uploads and finalizes', async () => {
    // Simulate state left behind by a mid-shift shutdown.
    await store.saveSession(makeSession('s1')); // status stayed 'recording'
    await store.saveChunk(makeChunk('s1', 0));
    await store.saveChunk(makeChunk('s1', 1));

    const um = new UploadManager(store, api, { sleep: noSleep });
    const summary = await um.resume();

    expect(summary.pendingChunks).toBe(2);
    expect(api.uploadChunk).toHaveBeenCalledTimes(2);
    expect(api.completeRecording).toHaveBeenCalledTimes(1);

    const session = await store.getSession('s1');
    expect(session?.status).toBe('completed');
    const payload = api.completeRecording.mock.calls[0][0] as unknown as { totalChunks: number };
    expect(payload.totalChunks).toBe(2); // reconciled from uploaded + pending
  });
});

describe('UploadManager — resource safety (CM-11)', () => {
  it('dead-letters a chunk after the lifetime retry cap and stops retrying (R2)', async () => {
    api.uploadChunk.mockRejectedValue(new Error('permafail'));
    await store.saveSession(makeSession('s1'));
    await store.saveChunk(makeChunk('s1', 0));

    const um = new UploadManager(store, api, { sleep: noSleep });
    // Drain repeatedly; each drain adds up to maxAttempts to the cumulative count.
    for (let i = 0; i < 12 && (await store.countPendingChunks()) > 0; i++) {
      await um.drain();
    }

    expect(await store.countPendingChunks()).toBe(0); // dead-lettered, no longer pending
    const callsAfterDeath = api.uploadChunk.mock.calls.length;
    await um.drain(); // further drains must not retry it
    expect(api.uploadChunk.mock.calls.length).toBe(callsAfterDeath);
  });

  it('never loads full blob sets during a drain — uses count/keys only (R1)', async () => {
    await store.saveSession(makeSession('s1', { status: 'stopped', totalChunks: 2, endedAt: 2_000 }));
    await store.saveChunk(makeChunk('s1', 0));
    await store.saveChunk(makeChunk('s1', 1));

    const fullLoadSpy = vi.spyOn(store, 'getPendingChunks');
    const um = new UploadManager(store, api, { sleep: noSleep, onStats: () => {} });
    await um.drain();

    expect(fullLoadSpy).not.toHaveBeenCalled();
    expect(api.uploadChunk).toHaveBeenCalledTimes(2);
  });

  it('surfaces StorageFullError from enqueueChunk so recording can stop gracefully (R3)', async () => {
    vi.spyOn(store, 'saveChunk').mockRejectedValueOnce(new StorageFullError());
    const um = new UploadManager(store, api, { sleep: noSleep });

    await expect(um.enqueueChunk(makeChunk('s1', 0))).rejects.toBeInstanceOf(StorageFullError);
  });
});
