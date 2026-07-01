# CM-11 — Robustness & resource-safety hardening

- **Branch:** `fix/resource-safety`
- **Status:** Done
- **Progress:** 100%
- **Result:** All 9 findings fixed; 14 new negative/stress tests added (40 tests total, tsc clean).
- **Origin:** Code review of `ChunkStore` surfaced four issues; a system-wide audit
  found the same classes amplified across other layers.

## Problem

Four issue classes threaten long-running / degraded-network use:
- **(A) Unbounded in-memory loads** — loading whole collections (with blobs) into RAM.
- **(B) Resource exhaustion** — `QuotaExceededError` not handled; recording halts silently.
- **(C) Unmanaged resource lifecycle** — DB stale handle, MediaStream leak, hung fetch.
- **(D) Unbounded growth** — dead chunks/sessions never GC'd; DOM log grows forever.

## Findings (system-wide audit)

| # | Class | Location | Issue |
|---|-------|----------|-------|
| F1 | D | `ChunkStore.markSessionCompleted`, chunks store | Dead/abandoned sessions' chunks + completed session records never pruned. |
| F2 | B | `ChunkStore.saveChunk` | `QuotaExceededError` only logged & rethrown → recording crashes ungracefully. |
| F3 | C | `ChunkStore.openDatabase` | No `onversionchange`/`onclose`; cached `this.db` can go stale, no re-init. |
| F4 | A | `ChunkStore.getPendingChunks` / `getUnfinishedSessions` | `getAll()` loads every record **including blobs** → OOM. |
| F5 | A | `UploadManager` (drain loop L175, `emitStats` L345, finalize, reconcile) | Calls the blob-loading `getPendingChunks` repeatedly — even just to count → O(N²) blob loads. |
| F6 | D | `AppUI.appendLog` | Log `<li>` list appended forever, no cap → memory/perf leak. |
| F7 | C | `ApiClient.send` | No request timeout/AbortController; a hung connection stalls the single-flight drain forever. |
| F8 | C | `ScreenRecorder.start` / `startCycle` | If `new MediaRecorder` throws after capture starts, the MediaStream tracks leak. |
| F9 | D | `UploadManager.uploadWithRetry` | Permanently-failing chunk retried every drain forever; no dead-letter. |

## Acceptance criteria

**Storage (A/B/C/D):**
- [x] Add `countPendingChunks()` (uses `.count()`, no blobs) and `getPendingChunkKeys()`
  (key cursor, no blobs) and `getChunk(sessionId,index)` (loads ONE blob) to `IChunkStore`.
- [x] `saveChunk` catches `QuotaExceededError`, attempts reclaim (prune), and throws a
  typed `StorageFullError` if still full.
- [x] `openDatabase` sets `onversionchange`/`onclose`; every op calls `ensureDb()` to
  transparently re-open a closed connection.
- [x] `pruneCompletedSessions(olderThanMs)` + `deleteSession()`; dead chunks are deleted.

**Upload (A/D):**
- [x] `UploadManager` never loads full blob sets: counts via `countPendingChunks`,
  iterates via `getPendingChunkKeys`, loads one blob at a time via `getChunk`.
- [x] Dead-letter: after `RETRY.maxLifetimeAttempts`, mark chunk `dead` (excluded from
  pending) and stop retrying; free its blob.
- [x] `StorageFullError` from enqueue is surfaced to the UI and stops recording gracefully.

**Network (C):**
- [x] `ApiClient` bounds every request with an AbortController timeout
  (`REQUEST_TIMEOUT_MS`) → `HttpError(status=null)` on timeout.

**Recorder (C):**
- [x] `ScreenRecorder.start` releases the MediaStream and resets state if setup fails
  after capture is granted.

**UI (D):**
- [x] `AppUI` caps the on-screen log to the last `MAX_LOG_ENTRIES`.

## Required tests (negative / stress)

- [x] ChunkStore: `countPendingChunks`/`getPendingChunkKeys` return correct data;
  `getChunk` loads a single record; `saveChunk` → `StorageFullError` on mocked quota;
  `ensureDb` re-opens after a simulated close; `pruneCompletedSessions` removes old ones;
  dead chunks excluded from pending.
- [x] UploadManager: dead-letter after max lifetime attempts (not retried forever);
  drain/stats never call the blob-loading path (spy on `getPendingChunks`); enqueue
  surfaces `StorageFullError`.
- [x] ApiClient: request timeout → `HttpError(null)`.
- [x] AppUI: log list length capped at `MAX_LOG_ENTRIES`.
- [x] ScreenRecorder: `MediaRecorder` ctor throws → tracks stopped, `start()` rejects, `isRecording=false`.

## Out of scope (noted)
- Server-side disk GC of old `server/uploads/<sessionId>` folders (F10) — low priority;
  the mock server is a stand-in for the real backend.
