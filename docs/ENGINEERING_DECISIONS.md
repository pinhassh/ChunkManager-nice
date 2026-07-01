# Engineering Decisions

Notes for the presentation: the key choices, what was tricky, and what I'd do
with more time.

## Key choices

### Stop/restart chunking (not `MediaRecorder` timeslice)
The requirement is explicit: chunks must be **independently playable**. A single
`MediaRecorder` with a `timeslice` emits fragments of one stream where only the
first carries the WebM header — later fragments can't be played alone. So instead
we fully stop the recorder every 30s (flushing a complete, self-contained `.webm`)
and immediately start a new one on the same `MediaStream`. Trade-off: a few
milliseconds may be lost at each restart boundary; in return every chunk is a
valid file that can be uploaded, processed, and played on its own.

### IndexedDB as the durable queue
Chunks are binary Blobs, potentially large — `localStorage` can't hold them and
isn't durable enough. IndexedDB stores Blobs natively, survives reloads/shutdowns,
and lets us scan for pending work on startup. It is the single source of truth;
the whole recovery story falls out of "persist before upload, delete after confirm".

### Idempotent server keyed by `sessionId/index`
Makes retries safe: a re-upload after a partial failure overwrites the same file
instead of duplicating. This is what lets the client retry aggressively without
coordination.

### Retry policy separated from transport
`ApiClient` only does `fetch` and normalizes errors; all retry/backoff/queue
policy lives in `UploadManager`. Each is small and independently testable, and the
policy is trivial to tune from `config.ts`.

### Single-file build for the double-click requirement
`vite-plugin-singlefile` inlines everything into one root `index.html`. `file://`
is a secure context, so `getDisplayMedia` and IndexedDB work without a server.

### Enriched logging
Every log carries a `level`, an explicit `source` (`Module.method`), and an
auto-extracted **code origin** (`file:line`) mined from the error stack, plus
structured context (sessionId, chunkIndex, attempt, httpStatus, url). When an
upload falls over you can see exactly which call failed and from where.

## What was tricky

- **Finalizing without races.** The last chunk is emitted asynchronously on
  `MediaRecorder.stop()`, and a drain can already be in flight when the user hits
  Stop. Two mechanisms fix this: `ScreenRecorder.stop()` awaits the final chunk's
  persistence, and `UploadManager.drain()` is single-flight with a `rerun` flag so
  a state change during a drain (session → `stopped`) is reprocessed rather than lost.
- **Retry attempts vs. lifetime.** Attempts are capped **per drain**, not for the
  chunk's lifetime, so a chunk that exhausted its retries during an outage still
  gets a fresh set of tries on the next `online` event or app start.
- **Recovering a session that never got a Stop.** A shutdown mid-recording leaves
  a session marked `recording`; `resume()` adopts it as `stopped` so it can be
  finalized.
- **Testing browser APIs.** `getDisplayMedia`/`MediaRecorder` are faked and driven
  with fake timers; IndexedDB uses `fake-indexeddb`. (One quirk: Blob `.size`
  doesn't survive fake-indexeddb's clone in jsdom, so tests assert on the stored
  metadata instead — a test-env artifact, not a runtime issue.)

## What I'd do with more time

- **Delete blobs sooner with a metadata-only record**, to cap memory during very
  long sessions (currently metadata is accumulated on the session and the blob is
  deleted on confirm — already good, but chunk records could be slimmer).
- **Reconcile against `GET /status`** on resume to skip re-uploading chunks the
  server already has (the endpoint exists; the client could use it to trim work).
- **Backpressure / disk-quota handling** — surface `QuotaExceededError` and pause
  recording gracefully if storage fills.
- **Audio + track selection**, richer MIME negotiation, and configurable chunk length.
- **Integration test** driving the real mock server over HTTP (supertest), on top
  of the current unit coverage.
- **A small state machine** for session lifecycle to make transitions explicit.
