# The Recovery Mechanism

This is the heart of the assignment: **never lose anything that was recorded.**
The design rests on one invariant:

> A chunk is only considered safe once it is **persisted to IndexedDB**, and it is
> only **deleted once the server has confirmed** it (HTTP 2xx).

Because IndexedDB survives page reloads and process death, and because the server
is idempotent, this invariant is enough to recover from all three failure modes.

---

## 1. Network drops (internet down for a minute)

**What happens:** `fetch` rejects or returns a non-2xx status.

**How we recover:**
- Every upload is wrapped in **retry with exponential backoff**
  (`1s → 2s → 4s → 8s …`, capped — see `config.RETRY`). A failed chunk stays
  `pending` and is retried.
- We listen for the browser's `online` / `offline` events. Going offline pauses
  draining (and logs a warning); coming back online triggers an **immediate drain**.
- **Recording never stops during an outage** — new chunks keep being written to
  IndexedDB, so the buffer simply grows and drains later.

_Relevant code:_ `UploadManager.uploadWithRetry`, `attachNetworkListeners`,
`config.backoffDelayMs`.

## 2. Computer shutdown mid-shift

**What happens:** the tab/process dies abruptly. In-memory state is gone, but
IndexedDB is intact — it holds every chunk not yet confirmed, plus the session
record (possibly still marked `recording`).

**How we recover:** on the next app start, `UploadManager.resume()`:
1. **Reconciles interrupted sessions** — a session still marked `recording` was
   clearly cut off, so we transition it to `stopped`, computing `totalChunks` from
   what is on hand (uploaded + pending).
2. **Drains** all `pending` chunks (with the same retry logic).
3. **Finalizes** each stopped, fully-uploaded session by sending `complete`.

The UI shows a recovery banner (“Recovering N pending chunks…”) while this runs.

_Relevant code:_ `UploadManager.resume`, `reconcileInterruptedSessions`,
`ChunkStore.getPendingChunks`, `getUnfinishedSessions`.

## 3. Failure in the middle of an upload

**What happens:** a single chunk upload fails partway (connection dropped, server
hiccup).

**How we recover:**
- The chunk is not deleted until a 2xx arrives, so it remains `pending` and is
  retried.
- The server is **idempotent**: chunks are written by `sessionId/index`, so a
  retried upload **overwrites** the same file — never a duplicate.

_Relevant code:_ `UploadManager.uploadWithRetry`, `mockServer` chunk handler.

---

## Guaranteed, race-free finalization

The `complete` signal (which tells the backend the recording is done, with all
metadata to process it) is only sent **after every chunk of a stopped session is
confirmed**, and it is itself retried until it succeeds.

Two subtleties are handled explicitly:
- **The last chunk:** `ScreenRecorder.stop()` awaits the final chunk's
  persistence before resolving, so we never finalize before the last chunk is saved.
- **Concurrent drains:** `UploadManager.drain()` is single-flight with a `rerun`
  flag, so a drain requested while one is in progress (e.g. right after Stop marks
  the session `stopped`) is not lost — the state change is reprocessed and the
  session is finalized.

_Relevant code:_ `UploadManager.drain`, `finalizeReadySessions`, `finalizeSession`;
`ScreenRecorder.handleCycleStop`.

## What the server receives on completion

`POST /recordings/:sessionId/complete` with everything needed to process the chunks
(processing itself is out of scope):

```json
{
  "sessionId": "…",
  "totalChunks": 12,
  "startedAt": 1719830000000,
  "endedAt":   1719830360000,
  "mimeType":  "video/webm;codecs=vp9",
  "chunks": [ { "index": 0, "size": 1048576, "durationMs": 30000 }, … ]
}
```

The server persists this as `manifest.json` and reports how many chunk files it
actually holds, for reconciliation.
