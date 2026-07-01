/**
 * Application bootstrap.
 *
 * Constructs the four collaborators and wires the event flow between them:
 *
 *   AppUI ──start/stop──▶ ScreenRecorder ──onChunk──▶ UploadManager ──▶ ApiClient
 *     ▲                                                     │
 *     └───────────────── stats / logs ─────────────────────┘
 *
 * On load it recovers any work left behind by a previous run (crash/shutdown).
 */

import './styles.css';
import { CONNECTIVITY_POLL_MS } from './core/config';
import { ConnectivityMonitor } from './core/ConnectivityMonitor';
import { logger } from './core/Logger';
import { ChunkStore, StorageFullError } from './storage/ChunkStore';
import { ScreenRecorder, type RecorderChunk } from './recording/ScreenRecorder';
import { ApiClient } from './upload/ApiClient';
import { UploadManager } from './upload/UploadManager';
import { AppUI } from './ui/AppUI';
import type { ChunkRecord, SessionMeta } from './recording/types';

// --- Collaborators -----------------------------------------------------------

const store = new ChunkStore();
const api = new ApiClient();
const ui = new AppUI({ onStart: handleStart, onStop: handleStop });

const uploadManager = new UploadManager(store, api, {
  onStats: (stats) => ui.setCounts({ chunks: chunkCount, pending: stats.pending, uploaded: stats.uploaded }),
});

const recorder = new ScreenRecorder({
  onChunk: handleChunk,
  onSourceSelected: (_surface, label) => ui.setSource(label),
  onError: () => resetToIdle(),
  onStreamEnded: () => void handleStop(),
});

// --- Mutable session state ---------------------------------------------------

let currentSessionId: string | null = null;
let chunkCount = 0;
/** Set once storage is full; we stop accepting new chunks and end the session. */
let storageFull = false;

// --- Handlers ----------------------------------------------------------------

/** Begin a new recording session. */
async function handleStart(): Promise<void> {
  const sessionId = crypto.randomUUID();
  ui.setSource(null); // cleared before the picker; onSourceSelected sets the real value

  try {
    // Opens the browser's screen-share prompt; throws if the user cancels.
    await recorder.start();
  } catch {
    resetToIdle();
    return;
  }

  currentSessionId = sessionId;
  chunkCount = 0;
  storageFull = false;
  ui.setSessionId(sessionId);
  ui.setState('recording');
  ui.setCounts({ chunks: 0, pending: 0, uploaded: 0 });

  const session: SessionMeta = {
    sessionId,
    status: 'recording',
    startedAt: Date.now(),
    endedAt: null,
    mimeType: recorder.mimeType || 'video/webm',
    totalChunks: null,
    uploadedChunks: [],
  };
  await store.saveSession(session);

  logger.success('Recording session started.', {
    source: 'main.handleStart',
    context: { sessionId },
  });
}

/** Persist and enqueue each completed chunk. */
async function handleChunk(chunk: RecorderChunk): Promise<void> {
  // Once storage is full we stop accepting chunks (the final flush lands here too).
  if (!currentSessionId || storageFull) return;

  const record: ChunkRecord = {
    sessionId: currentSessionId,
    index: chunk.index,
    size: chunk.blob.size,
    durationMs: chunk.durationMs,
    mimeType: chunk.mimeType,
    createdAt: Date.now(),
    status: 'pending',
    attempts: 0,
    blob: chunk.blob,
  };

  // Counters are refreshed by the UploadManager's onStats callback below.
  chunkCount = chunk.index + 1;

  try {
    await uploadManager.enqueueChunk(record);
  } catch (error) {
    if (error instanceof StorageFullError) {
      // Degrade gracefully: stop recording, but already-saved chunks still upload.
      storageFull = true;
      logger.error('Storage is full — stopping recording to avoid corrupt data.', {
        source: 'main.handleChunk',
        context: { sessionId: record.sessionId, chunkIndex: record.index },
        error,
      });
      ui.showRecovery(
        'Storage full — recording stopped. Saved chunks will still upload; free space and reload to continue.',
      );
      void handleStop();
    } else {
      logger.error('Failed to enqueue chunk.', {
        source: 'main.handleChunk',
        context: { sessionId: record.sessionId, chunkIndex: record.index },
        error,
      });
    }
  }
}

/** Stop recording, mark the session stopped, and let the uploader finalize it. */
async function handleStop(): Promise<void> {
  if (!currentSessionId) return;
  const sessionId = currentSessionId;
  currentSessionId = null; // guard against double-stop / late track-ended events

  ui.setState('stopped');
  await recorder.stop(); // flushes the final chunk (awaited persistence)

  const session = await store.getSession(sessionId);
  if (session) {
    session.status = 'stopped';
    session.endedAt = Date.now();
    session.totalChunks = chunkCount;
    await store.saveSession(session);
  }

  logger.success('Recording stopped.', {
    source: 'main.handleStop',
    context: { sessionId, totalChunks: chunkCount },
  });

  await uploadManager.drain(); // upload any remaining chunks, then send `complete`
  ui.setState('idle');
  ui.setSource(null);
}

// --- Helpers -----------------------------------------------------------------

/** Return the UI to the idle state (used on denial / error). */
function resetToIdle(): void {
  currentSessionId = null;
  chunkCount = 0;
  ui.setSessionId(null);
  ui.setSource(null);
  ui.setState('idle');
}

// --- Startup -----------------------------------------------------------------

async function bootstrap(): Promise<void> {
  // Stream every log into the on-screen list.
  logger.subscribe((entry) => ui.appendLog(entry));

  // Drive the network indicator from real server reachability (not navigator.onLine),
  // and kick a drain the moment the server becomes reachable again.
  const connectivity = new ConnectivityMonitor(
    () => api.checkHealth(),
    (online) => {
      ui.setNetwork(online);
      if (online) void uploadManager.drain();
    },
    CONNECTIVITY_POLL_MS,
  );
  connectivity.start();

  try {
    await store.init();
  } catch {
    ui.showRecovery('Storage unavailable — recording cannot be persisted.');
    return;
  }

  uploadManager.attachNetworkListeners();
  ui.setState('idle');

  // Recover anything a previous run left behind (crash / shutdown / mid-upload).
  const summary = await uploadManager.resume();
  if (summary.pendingChunks > 0 || summary.sessions > 0) {
    ui.showRecovery(
      `Recovering ${summary.pendingChunks} pending chunk(s) from ${summary.sessions} interrupted session(s)…`,
    );
    // Hide the banner shortly after — the upload continues in the background.
    window.setTimeout(() => ui.showRecovery(null), 6000);
  }
}

void bootstrap();
