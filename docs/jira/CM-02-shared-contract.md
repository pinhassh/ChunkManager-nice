# CM-02 — Shared contract (config, types, Logger)

- **Branch:** `feat/logger`
- **Status:** Done
- **Progress:** 100%

## Description
The shared foundation every component depends on: domain types & ports, central
config, and a structured logger.

## Acceptance criteria
- [x] `src/recording/types.ts` — `ChunkStatus`, `ChunkMeta`, `ChunkRecord`,
  `SessionMeta`, and ports `IChunkStore`, `IApiClient`, `CompletePayload`.
- [x] `src/core/config.ts` — `CHUNK_DURATION_MS=30000`, retry/backoff, DB names,
  MIME candidates, `backoffDelayMs()`.
- [x] `src/core/Logger.ts` — `success/warning/error` with `source` + auto origin
  frame (file:line), structured `context`, and subscribe() for UI.

## Notes
`source` requirement: every error log carries both an explicit `Module.method`
string and the first app stack frame extracted from the error.
