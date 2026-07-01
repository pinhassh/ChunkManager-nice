# ChunkManager

A fault-tolerant screen-recording upload mechanism, written in **Vanilla TypeScript**
(with a Vite build, no framework). It records the screen with `getDisplayMedia`,
splits the recording into **independently playable 30-second chunks**, persists
each chunk durably, and uploads it to a local mock server — recovering
automatically from network drops, computer shutdowns, and mid-upload failures so
**nothing recorded is ever lost**.

---

## Quick start

```bash
npm install

# 1) Start the mock upload server (terminal A)
npm run mock-server        # listens on http://localhost:4000

# 2a) Development, with hot reload (terminal B)
npm run dev

# 2b) …or build the double-clickable single-file app
npm run build              # emits ./index.html — open it with a double-click
```

Then click **Start recording**, choose a Tab / Window / Screen, and watch the
logs. Chunks land on disk under `server/uploads/<sessionId>/`.

```bash
npm run test               # run the test suite (Vitest)
```

## npm scripts

| Script | What it does |
|--------|--------------|
| `npm run dev` | Vite dev server (hot reload). |
| `npm run build` | Builds a **self-contained `index.html`** at the project root (double-click to run). |
| `npm run mock-server` | Runs the Express mock upload server on port 4000. |
| `npm run test` | Runs all Vitest tests (positive + negative flows). |

## Project structure

```
src/
├── main.ts                  Bootstrap: wires UI ↔ recorder ↔ upload engine
├── core/
│   ├── config.ts            Chunk length, retry/backoff, server URL, MIME list
│   └── Logger.ts            success/warning/error logs with code-origin tracking
├── recording/
│   ├── types.ts             Shared domain types & ports (interfaces)
│   └── ScreenRecorder.ts    getDisplayMedia + stop/restart 30s chunking
├── storage/
│   └── ChunkStore.ts        Durable IndexedDB persistence (crash-safe)
├── upload/
│   ├── ApiClient.ts         HTTP client for the mock server
│   └── UploadManager.ts     Queue, retry, online/offline, resume, finalize
└── ui/
    └── AppUI.ts             Buttons, status panel, live log list
server/
└── mockServer.ts            Express: chunk upload, complete, status
tests/                       Vitest suites (storage, upload, recorder, api)
docs/                        Architecture, recovery, decisions, and Jira board
```

## How it works (in one paragraph)

The recorder emits one complete `.webm` file every 30 seconds. Each chunk is
written to **IndexedDB first** (so it survives a crash), then handed to the
`UploadManager`, which uploads it to the server with retries and exponential
backoff. On success the blob is deleted and its metadata kept. When recording
stops, a `complete` request is sent with everything the backend needs to process
the chunks — but only after every chunk has been confirmed. On startup the app
scans IndexedDB for unfinished work and resumes it.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and
[`docs/RECOVERY.md`](docs/RECOVERY.md) for the full picture, and
[`docs/jira/BOARD.md`](docs/jira/BOARD.md) for the task board.

## Requirements & compatibility

- Node 18+ (developed on Node 22).
- A Chromium-based browser is recommended (`getDisplayMedia` + IndexedDB).
- `getDisplayMedia` requires a **secure context**; `file://` qualifies, so the
  built `index.html` works on double-click.

## Manual end-to-end verification

1. `npm run mock-server`, then `npm run build` and open `index.html`.
2. Record; confirm chunk files appear in `server/uploads/<sessionId>/`.
3. **Network drop:** stop the server for a minute mid-recording → retry warnings;
   restart it → the queue drains and the files arrive.
4. **Shutdown:** refresh the page while chunks are pending → on reload the app
   shows a recovery banner and finishes uploading.
5. **Finalize:** click Stop → the server receives `complete` with full metadata
   (see `server/uploads/<sessionId>/manifest.json`).

> Tip: simulate flaky uploads with `MOCK_FAIL_RATE=0.3 npm run mock-server`.
