# CM-05 — ApiClient + UploadManager (queue, retry, resume)

- **Branch:** `feat/upload-manager`
- **Status:** To Do
- **Progress:** 0%

## Description
The upload engine: an HTTP client and a resilient queue that survives network
drops and shutdowns.

## Acceptance criteria (ApiClient)
- [ ] `uploadChunk`, `completeRecording`, `getSessionStatus` against the mock server.
- [ ] Non-2xx responses map to informative errors (method/url/status).

## Acceptance criteria (UploadManager)
- [ ] `enqueue(chunk)` persists then uploads in order.
- [ ] Retry with exponential backoff; keeps chunk `pending` on exhaustion.
- [ ] `online`/`offline` listeners trigger an immediate drain.
- [ ] `resume()` on startup re-uploads pending chunks and finalizes unfinished sessions.
- [ ] `finalize(session)` sends `complete` only after all chunks are uploaded, with retry.

## Notes
Idempotent server + status-based reconciliation prevent duplicates after partial
failures.
