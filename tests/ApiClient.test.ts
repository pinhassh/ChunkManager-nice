/**
 * ApiClient tests — request building for each endpoint, and mapping of non-2xx
 * responses and network failures to informative HttpErrors.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, HttpError } from '../src/upload/ApiClient';

const BASE = 'http://localhost:4000';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetch(impl: (...args: unknown[]) => unknown): ReturnType<typeof vi.fn> {
  const mock = vi.fn(impl as never);
  vi.stubGlobal('fetch', mock);
  return mock;
}

describe('ApiClient — uploadChunk', () => {
  it('POSTs the blob to the chunk endpoint on success', async () => {
    const fetchMock = stubFetch(() => Promise.resolve({ ok: true, status: 200 }));
    const api = new ApiClient(BASE);
    const blob = new Blob(['chunk-data'], { type: 'video/webm' });

    await api.uploadChunk('sess-1', 3, blob);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/recordings/sess-1/chunks/3`);
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).body).toBe(blob);
  });

  it('throws HttpError with the status on a non-2xx response', async () => {
    stubFetch(() => Promise.resolve({ ok: false, status: 503 }));
    const api = new ApiClient(BASE);

    const error = await api.uploadChunk('s', 0, new Blob(['x'])).catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(503);
  });

  it('throws HttpError with status=null on a network failure', async () => {
    stubFetch(() => Promise.reject(new Error('connection refused')));
    const api = new ApiClient(BASE);

    const error = await api.uploadChunk('s', 0, new Blob(['x'])).catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBeNull();
  });
});

describe('ApiClient — completeRecording & status', () => {
  it('POSTs the finalize payload as JSON', async () => {
    const fetchMock = stubFetch(() => Promise.resolve({ ok: true, status: 200 }));
    const api = new ApiClient(BASE);

    await api.completeRecording({
      sessionId: 'sess-1',
      totalChunks: 2,
      startedAt: 1,
      endedAt: 2,
      mimeType: 'video/webm',
      chunks: [{ index: 0, size: 1, durationMs: 30_000 }],
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/recordings/sess-1/complete`);
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse((init as RequestInit).body as string).totalChunks).toBe(2);
  });

  it('reads received indexes from the status endpoint', async () => {
    stubFetch(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ receivedIndexes: [0, 1, 2] }) }));
    const api = new ApiClient(BASE);

    const status = await api.getSessionStatus('sess-1');
    expect(status.receivedIndexes).toEqual([0, 1, 2]);
  });
});
