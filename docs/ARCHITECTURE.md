# Architecture

## High-level view

ChunkManager is split into small, single-responsibility layers. The browser app
records and uploads; a local Express server stands in for the cloud backend.

```
┌─────────────────────────────── Browser (Vanilla TS) ───────────────────────────────┐
│                                                                                      │
│   AppUI ──start/stop──▶ ScreenRecorder ──onChunk──▶ UploadManager ──▶ ApiClient ──┐  │
│    ▲  ▲                  (getDisplayMedia +           (queue, retry,      (fetch)  │  │
│    │  │                   MediaRecorder,               resume, finalize)           │  │
│    │  │                   stop/restart)                    │                       │  │
│    │  └───────── logs ────────── Logger ◀──────────────────┤                       │  │
│    │                                                       ▼                       │  │
│    └──────── stats ───────────────────────────────── ChunkStore (IndexedDB)       │  │
│                                                    (durable, crash-safe queue)     │  │
└────────────────────────────────────────────────────────────────────────────────┼──┘
                                                                                   │ HTTP
                                                                                   ▼
                                                    ┌──────────────────────────────────┐
                                                    │ mockServer (Express, :4000)       │
                                                    │  POST /chunks/:index  (idempotent)│
                                                    │  POST /complete       (manifest)  │
                                                    │  GET  /status         (reconcile) │
                                                    └──────────────────────────────────┘
```

## Components

| Component | File | Responsibility |
|-----------|------|----------------|
| **AppUI** | `src/ui/AppUI.ts` | All DOM access: buttons, status panel, network indicator, recovery banner, live log list. No business logic. |
| **ScreenRecorder** | `src/recording/ScreenRecorder.ts` | Owns `getDisplayMedia` + `MediaRecorder`. Produces one complete, independently playable chunk every 30s via stop/restart. |
| **ChunkStore** | `src/storage/ChunkStore.ts` | Durable IndexedDB persistence for chunks and sessions. The crash-recovery backbone and single source of truth. |
| **ApiClient** | `src/upload/ApiClient.ts` | Thin HTTP client; turns non-2xx / network errors into informative `HttpError`s. No policy. |
| **UploadManager** | `src/upload/UploadManager.ts` | The resilient engine: ordered queue, retry + backoff, online/offline handling, `resume()`, and `complete` finalization. |
| **Logger** | `src/core/Logger.ts` | success/warning/error logging with an explicit `source` and an auto-extracted code origin (`file:line`). |
| **config** | `src/core/config.ts` | All tunables: chunk length, retry policy, DB names, server URL, MIME candidates. |
| **types** | `src/recording/types.ts` | Shared domain types and **ports** (`IChunkStore`, `IApiClient`) so layers depend on interfaces, not concretions. |
| **mockServer** | `server/mockServer.ts` | Express server simulating the cloud endpoint. Stores chunks idempotently; accepts the finalize manifest; triggers the merge. |
| **videoMerger** | `server/videoMerger.ts` | On `/complete`, remuxes the session's chunks into one `<sessionId>.webm` via ffmpeg (`ffmpeg-static`), stream-copy, in index order. |

## Why these boundaries

- **The store is the source of truth.** A chunk is safe once persisted and only
  removed once the server confirms it. Everything else is stateless-ish around
  that invariant, which is what makes recovery simple and reliable.
- **Ports over concretions.** `UploadManager` depends on `IChunkStore` and
  `IApiClient`, so it is trivially unit-tested with fakes and a real in-memory DB.
- **Policy vs. mechanism.** `ApiClient` only performs requests; all retry/queue
  policy lives in `UploadManager`. Each is small and independently testable.
- **UI is a thin shell.** `AppUI` never talks to the network or storage; `main.ts`
  is the only wiring point.

## Data flow (happy path)

1. `AppUI` Start → `ScreenRecorder.start()` opens the screen-share prompt.
2. Every 30s the recorder stops (flushing a complete `.webm`), emits the chunk,
   and immediately restarts — no gap between chunks.
3. `main` builds a `ChunkRecord` and calls `UploadManager.enqueueChunk()`, which
   **persists to IndexedDB first**, then triggers a drain.
4. `UploadManager` uploads pending chunks in order via `ApiClient`; each success
   records the chunk's metadata on the session and deletes the heavy blob.
5. On Stop, the session is marked `stopped` with its total count; once all chunks
   are confirmed, `complete` is sent with the full manifest.

## Build & run model

- **Dev:** `src/index.html` is the Vite entry (`root: 'src'`).
- **Build:** `vite-plugin-singlefile` inlines all JS/CSS into one file emitted to
  the project root as `index.html`, runnable via double-click (`file://`).
- **Tests:** Vitest in a jsdom environment with `fake-indexeddb`.
