/**
 * ScreenRecorder tests — the stop/restart chunking loop and error handling.
 *
 * getDisplayMedia and MediaRecorder are faked. A fake MediaRecorder emits one
 * data blob and fires `onstop` synchronously when stopped, so we can drive the
 * 30s cycle with fake timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScreenRecorder, type RecorderChunk } from '../src/recording/ScreenRecorder';
import { CHUNK_DURATION_MS } from '../src/core/config';

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported = (): boolean => true;

  state: 'inactive' | 'recording' = 'inactive';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;

  constructor(public stream: unknown, public options?: unknown) {
    FakeMediaRecorder.instances.push(this);
  }

  start(): void {
    this.state = 'recording';
  }

  stop(): void {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    // Flush one complete "file", then signal stop — mimics a real MediaRecorder.
    this.ondataavailable?.({ data: new Blob(['video-bytes'], { type: 'video/webm' }) });
    this.onstop?.();
  }
}

function makeStream() {
  const track = { stop: vi.fn(), addEventListener: vi.fn() };
  return { getVideoTracks: () => [track], getTracks: () => [track], track };
}

let stream: ReturnType<typeof makeStream>;
let getDisplayMedia: ReturnType<typeof vi.fn>;

beforeEach(() => {
  FakeMediaRecorder.instances = [];
  stream = makeStream();
  getDisplayMedia = vi.fn().mockResolvedValue(stream);
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getDisplayMedia },
  });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ScreenRecorder — recording loop', () => {
  it('emits one independently playable chunk per 30s cycle', async () => {
    const chunks: RecorderChunk[] = [];
    const rec = new ScreenRecorder({ onChunk: (c) => void chunks.push(c) });

    await rec.start();
    expect(getDisplayMedia).toHaveBeenCalledOnce();
    expect(rec.isRecording).toBe(true);
    expect(FakeMediaRecorder.instances).toHaveLength(1); // first cycle running

    // One 30s cycle elapses → current recorder stops, chunk 0 emitted, next starts.
    await vi.advanceTimersByTimeAsync(CHUNK_DURATION_MS);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].index).toBe(0);
    expect(chunks[0].blob.size).toBeGreaterThan(0);
    expect(FakeMediaRecorder.instances).toHaveLength(2); // next cycle started
  });

  it('flushes the final chunk and stops all tracks on stop()', async () => {
    const chunks: RecorderChunk[] = [];
    const rec = new ScreenRecorder({ onChunk: (c) => void chunks.push(c) });

    await rec.start();
    await vi.advanceTimersByTimeAsync(CHUNK_DURATION_MS); // chunk 0
    await rec.stop(); // flush final chunk 1

    expect(chunks.map((c) => c.index)).toEqual([0, 1]);
    expect(rec.isRecording).toBe(false);
    expect(stream.track.stop).toHaveBeenCalled();
  });
});

describe('ScreenRecorder — error handling', () => {
  it('rejects and reports when screen capture is denied', async () => {
    getDisplayMedia.mockRejectedValueOnce(new Error('Permission denied'));
    const onError = vi.fn();
    const rec = new ScreenRecorder({ onChunk: vi.fn(), onError });

    await expect(rec.start()).rejects.toThrow('Permission denied');
    expect(onError).toHaveBeenCalledOnce();
    expect(rec.isRecording).toBe(false);
  });

  it('handles the user ending the share from the browser UI', async () => {
    const onStreamEnded = vi.fn();
    const rec = new ScreenRecorder({ onChunk: vi.fn(), onStreamEnded });

    await rec.start();
    // The recorder subscribed to the video track's "ended" event.
    const [eventName, handler] = stream.track.addEventListener.mock.calls[0];
    expect(eventName).toBe('ended');

    handler(); // simulate the browser's native "Stop sharing"
    expect(onStreamEnded).toHaveBeenCalledOnce();
  });

  it('releases the MediaStream if MediaRecorder construction fails (no leak) (CM-11 / R4)', async () => {
    // Capture is granted, but constructing the recorder throws.
    class ThrowingRecorder {
      static isTypeSupported = (): boolean => true;
      constructor() {
        throw new Error('MediaRecorder unsupported');
      }
    }
    vi.stubGlobal('MediaRecorder', ThrowingRecorder);
    const onError = vi.fn();
    const rec = new ScreenRecorder({ onChunk: vi.fn(), onError });

    await expect(rec.start()).rejects.toThrow('MediaRecorder unsupported');
    expect(stream.track.stop).toHaveBeenCalled(); // stream released — not leaked
    expect(rec.isRecording).toBe(false);
    expect(onError).toHaveBeenCalled();
  });
});
