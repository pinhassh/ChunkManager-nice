# CM-03 — ChunkStore (IndexedDB persistence)

- **Branch:** `feat/storage-indexeddb`
- **Status:** Done
- **Progress:** 100%

## Description
Durable storage for chunks + sessions so nothing is lost across page reloads or
computer shutdowns. Implements `IChunkStore`.

## Acceptance criteria
- [ ] Two object stores: `chunks` (key `[sessionId, index]`) and `sessions` (key `sessionId`).
- [ ] `saveChunk`, `updateChunkStatus`, `deleteChunk`.
- [ ] `getPendingChunks()` returns non-uploaded chunks ordered by (sessionId, index).
- [ ] `saveSession`, `getSession`, `getUnfinishedSessions`, `markSessionCompleted`.
- [ ] Robust error handling with `Logger` (source = `ChunkStore.<method>`).

## Notes
Blobs are stored directly (IndexedDB supports Blob). Key design enables idempotent
overwrite and efficient pending scan on startup.
