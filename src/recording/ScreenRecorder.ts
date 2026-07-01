/**
 * ScreenRecorder — captures the screen and emits INDEPENDENTLY PLAYABLE chunks.
 *
 * Strategy: STOP/RESTART (not MediaRecorder timeslice).
 * A MediaRecorder started with a `timeslice` argument emits blob *fragments* of
 * a single continuous stream: only the first fragment carries the WebM header
 * (EBML/Segment/Tracks), so later fragments are NOT independently playable.
 *
 * Instead, every {@link CHUNK_DURATION_MS} we fully `stop()` the current
 * MediaRecorder. Stopping flushes a complete, self-contained .webm file (its own
 * header + cluster data), which we emit as one chunk. We then immediately spin up
 * a fresh MediaRecorder on the SAME MediaStream, so each chunk is a standalone
 * file that any player can open on its own — ideal for fault-tolerant, resumable
 * upload where an individual chunk must be usable even if others are missing.
 */

import { CHUNK_DURATION_MS, MIME_CANDIDATES } from '../core/config';
import { logger } from '../core/Logger';

/** One completed, independently playable recording chunk. */
export interface RecorderChunk {
  blob: Blob;
  index: number;
  durationMs: number;
  mimeType: string;
}

/** Callbacks the host wires into the recorder lifecycle. */
export interface ScreenRecorderCallbacks {
  /** Called for every completed chunk (0-based index). */
  onChunk: (chunk: RecorderChunk) => void | Promise<void>;
  /** Called on a fatal error (e.g. permission denial). */
  onError?: (error: unknown) => void;
  /** Called when the user clicks the browser's native "Stop sharing". */
  onStreamEnded?: () => void;
}

export class ScreenRecorder {
  private readonly callbacks: ScreenRecorderCallbacks;

  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chosenMimeType = '';

  private recording = false;
  private chunkIndex = 0;

  /** Blob parts collected for the CURRENT cycle. */
  private parts: Blob[] = [];
  /** Wall-clock start of the current cycle, for duration measurement. */
  private cycleStartedAt = 0;
  /** Timer that ends the current cycle after CHUNK_DURATION_MS. */
  private cycleTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Resolves once the FINAL recorder's `onstop` has run during {@link stop}.
   * Because stopping a MediaRecorder is asynchronous, this lets `stop()` truly
   * await the last chunk before releasing the stream tracks.
   */
  private finalStopResolve: (() => void) | null = null;

  constructor(callbacks: ScreenRecorderCallbacks) {
    this.callbacks = callbacks;
  }

  /** The negotiated MIME type ('' until {@link start} succeeds / browser default). */
  get mimeType(): string {
    return this.chosenMimeType;
  }

  /** Whether a recording session is currently active. */
  get isRecording(): boolean {
    return this.recording;
  }

  /**
   * Open the screen-capture prompt and begin recording.
   * @throws Re-throws if the user cancels or `getDisplayMedia` fails.
   */
  async start(): Promise<void> {
    if (this.recording) return; // idempotent guard

    try {
      this.stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });
    } catch (error) {
      logger.error('Screen capture was denied or failed.', {
        source: 'ScreenRecorder.start',
        error,
      });
      this.callbacks.onError?.(error);
      throw error;
    }

    this.chosenMimeType = this.pickMimeType();
    this.chunkIndex = 0;
    this.recording = true;

    // The user can stop sharing from the browser UI; the video track then ends.
    this.watchForUserStop(this.stream);

    this.startCycle();

    logger.success('Screen recording started.', {
      source: 'ScreenRecorder.start',
      context: { mimeType: this.chosenMimeType || '(browser default)' },
    });
  }

  /**
   * Stop recording: flush the final chunk, then release all tracks.
   * Idempotent and safe to call more than once.
   */
  async stop(): Promise<void> {
    if (!this.recording) {
      this.releaseStream();
      return;
    }

    this.recording = false; // signals onstop that this is a FINAL stop
    this.clearCycleTimer();

    // Wait for the active recorder's onstop to emit the last chunk.
    await this.stopActiveRecorderAndAwait();

    this.releaseStream();
  }

  /** Choose the first supported candidate MIME type, or '' for the browser default. */
  private pickMimeType(): string {
    for (const type of MIME_CANDIDATES) {
      if (MediaRecorder.isTypeSupported(type)) return type;
    }
    return '';
  }

  /** Detect the user ending the share via the browser's native control. */
  private watchForUserStop(stream: MediaStream): void {
    const [videoTrack] = stream.getVideoTracks();
    if (!videoTrack) return;

    videoTrack.addEventListener(
      'ended',
      () => {
        if (!this.recording) return; // already stopping through stop()
        logger.warning('User ended screen sharing from the browser UI.', {
          source: 'ScreenRecorder.watchForUserStop',
        });
        this.callbacks.onStreamEnded?.();
        // Gracefully finalise the current chunk and release resources.
        void this.stop();
      },
      { once: true },
    );
  }

  /**
   * Begin one recording cycle: a fresh MediaRecorder that will produce exactly
   * one complete .webm file when it stops.
   */
  private startCycle(): void {
    if (!this.stream) return;

    this.parts = [];
    this.cycleStartedAt = Date.now();

    const options = this.chosenMimeType ? { mimeType: this.chosenMimeType } : undefined;
    const recorder = new MediaRecorder(this.stream, options);
    this.recorder = recorder;

    recorder.ondataavailable = (event: BlobEvent): void => {
      if (event.data && event.data.size > 0) this.parts.push(event.data);
    };

    recorder.onstop = (): void => this.handleCycleStop();

    // No timeslice: we want a single, self-contained file flushed on stop().
    recorder.start();

    // End this cycle after the configured duration; onstop chains the next one.
    this.cycleTimer = setTimeout(() => {
      if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    }, CHUNK_DURATION_MS);
  }

  /**
   * Runs when a cycle's MediaRecorder has fully stopped and flushed its file.
   * Emits the assembled chunk, then either chains the next cycle (still
   * recording) or resolves the final-stop promise (session ending).
   */
  private handleCycleStop(): void {
    const type = this.chosenMimeType || 'video/webm';
    const blob = new Blob(this.parts, { type });
    this.parts = [];

    if (blob.size > 0) {
      const chunk: RecorderChunk = {
        blob,
        index: this.chunkIndex,
        durationMs: Date.now() - this.cycleStartedAt,
        mimeType: type,
      };
      this.chunkIndex += 1;

      logger.success('Chunk recorded.', {
        source: 'ScreenRecorder.handleCycleStop',
        context: { chunkIndex: chunk.index },
      });

      void this.callbacks.onChunk(chunk);
    }

    if (this.recording) {
      // Still recording: immediately start the next cycle so no time is lost.
      this.startCycle();
    } else {
      // Final stop: unblock stop()'s await.
      this.finalStopResolve?.();
      this.finalStopResolve = null;
      this.recorder = null;
    }
  }

  /** Stop the active recorder and resolve once its final `onstop` has fired. */
  private stopActiveRecorderAndAwait(): Promise<void> {
    const recorder = this.recorder;
    if (!recorder || recorder.state === 'inactive') return Promise.resolve();

    return new Promise<void>((resolve) => {
      this.finalStopResolve = resolve;
      recorder.stop(); // triggers handleCycleStop() asynchronously
    });
  }

  private clearCycleTimer(): void {
    if (this.cycleTimer !== null) {
      clearTimeout(this.cycleTimer);
      this.cycleTimer = null;
    }
  }

  /** Stop and drop all stream tracks. */
  private releaseStream(): void {
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
  }
}
