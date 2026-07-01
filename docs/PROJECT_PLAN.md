# ChunkManager — Project Plan

> This is the in-repo copy of the approved implementation plan. It is the single
> source of truth for scope, architecture, and the recovery mechanism.

## Context

A screen-recording app runs on a service rep's machine. It records the screen,
splits the recording into **30-second chunks**, and uploads them to the cloud.
The problem we solve: **never lose anything that was recorded** — even when the
network drops for a minute, the computer shuts down mid-shift, or a single upload
fails midway. The heart of the task is the **recovery mechanism**.

## Approved decisions

- **Chunk generation:** Stop/Restart `MediaRecorder` every 30s → each chunk is a
  complete, standalone, independently playable `.webm` file.
- **Durability / recovery:** IndexedDB stores each chunk's blob + metadata until
  its upload is confirmed. On restart we resume from where we left off.
- **Tooling:** Vanilla TypeScript + Vite. `vite-plugin-singlefile` emits a
  self-contained **root `index.html`** that runs on double-click (`file://`).
  Tests with Vitest + `fake-indexeddb`.

## Architecture (separation of concerns)

| Layer | File | Responsibility |
|-------|------|----------------|
| Bootstrap | `src/main.ts` | Wires UI ↔ Recorder ↔ UploadManager |
| Config | `src/core/config.ts` | Chunk length, retry/backoff, server URL |
| Logging | `src/core/Logger.ts` | success/warning/error + `source` + origin frame |
| Contract | `src/recording/types.ts` | Shared types & ports (interfaces) |
| Recording | `src/recording/ScreenRecorder.ts` | getDisplayMedia + stop/restart loop |
| Storage | `src/storage/ChunkStore.ts` | IndexedDB persistence |
| Upload | `src/upload/ApiClient.ts` | HTTP calls to mock server |
| Upload | `src/upload/UploadManager.ts` | Queue, retry, online/offline, resume, finalize |
| UI | `src/ui/AppUI.ts` | Buttons, status, log rendering |
| Server | `server/mockServer.ts` | Express: chunk upload, complete, status |

### Data flow
1. UI start → `ScreenRecorder.start()` opens `getDisplayMedia`.
2. Every 30s the recorder stops, emits a full chunk, and immediately restarts.
3. Each chunk is saved to IndexedDB as `pending` **before** any upload attempt.
4. `UploadManager` drains the queue via `ApiClient`, marks `uploaded`, deletes blob.
5. Stop → session marked `stopped`; once all chunks are up, send `complete`.

## Recovery mechanism (the heart)

- **Network drop:** uploads wrapped in retry + exponential backoff; failures keep
  the chunk `pending`. `online`/`offline` listeners trigger an immediate drain.
  Recording never stops during an outage.
- **Computer shutdown:** blobs already in IndexedDB. On boot, `resume()` scans for
  pending chunks + unfinished sessions and continues uploading + finalizing.
- **Mid-upload failure:** chunk stays `pending` until 2xx. Server is idempotent
  (write by `sessionId/index`), so re-uploads never duplicate.
- **Guaranteed finalize:** `complete` is part of the queue, sent only after all
  chunks are confirmed, retried until it succeeds.

## Mock server (Express, port 4000, CORS open)

- `POST /recordings/:sessionId/chunks/:index` — binary body → disk (idempotent).
- `POST /recordings/:sessionId/complete` — JSON with everything needed to process.
- `GET /recordings/:sessionId/status` — which indexes arrived (for recovery).

## npm scripts

- `npm run dev` — Vite dev server.
- `npm run build` — emits self-contained `./index.html`.
- `npm run mock-server` — runs the Express mock server.
- `npm run test` — Vitest.

## Git conventions

- `main` (stable) ← `develop` (integration) ← `feat/*` / `test/*` / `docs/*`.
- Conventional Commits: `feat:`, `fix:`, `test:`, `docs:`, `chore:`, `refactor:`.
- Small, logical commits — one component/idea per commit.

## Tests (positive + negative)

- ChunkStore: save/list/update/delete, pending-only query, survives "restart".
- UploadManager: drains in order; `complete` only after all uploaded; retry on
  failure; max-attempts leaves `pending`; offline→online drain; `resume()`.
- ScreenRecorder: mocked media APIs, stop/restart emits a chunk per cycle,
  share-cancel handled cleanly.
- ApiClient: request building; non-2xx → error.

## Verification (end-to-end)

1. `npm install`.
2. `npm run mock-server`.
3. `npm run build` → double-click root `index.html`.
4. Record → chunks every 30s land in `server/uploads/<sessionId>/`.
5. Kill the server for a minute → retry warnings; restart → queue drains.
6. Refresh mid-pending → `resume` completes the upload.
7. Stop → server receives `complete` with full metadata.
8. `npm run test` passes.
