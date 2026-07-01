# CM-08 — Tests (positive + negative flows)

- **Branch:** `test/coverage`
- **Status:** Done
- **Progress:** 100%

## Description
Cover the critical logic with positive and negative flows.

## Acceptance criteria
- [ ] `ChunkStore.test.ts` — CRUD, pending-only query, survives "restart".
- [ ] `UploadManager.test.ts` — ordered drain; `complete` only after all uploaded;
  retry on failure; max-attempts leaves `pending`; offline→online drain; `resume()`.
- [ ] `ScreenRecorder.test.ts` — mocked media APIs; chunk emitted per cycle;
  share-cancel handled.
- [ ] `ApiClient.test.ts` — request building; non-2xx → error.
- [ ] `npm run test` green.

## Notes
Uses fake-indexeddb + mocked `fetch`/`MediaRecorder`/`getDisplayMedia`.
