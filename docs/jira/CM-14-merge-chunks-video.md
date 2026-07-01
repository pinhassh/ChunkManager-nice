# CM-14 — Merge chunks into a single session video

- **Branch:** `feat/merge-video`
- **Status:** Done
- **Progress:** 100%

## Requirement
In each session's upload folder, alongside the individual chunk files, produce one
additional video that is **all the chunks joined into a single video, in order**,
**named after the session id** (same as the folder name):

```
server/uploads/<sessionId>/
├── 0.webm, 1.webm, 2.webm   ← individual chunks (kept)
├── manifest.json
└── <sessionId>.webm         ← merged single video (new)
```

## Why it needs a real remux (not a byte concat)
Chunks are complete standalone WebM files (recorder uses stop/restart), each with
its own EBML header and timestamps restarting at 0. Concatenating the bytes yields
an invalid file that plays only the first chunk. We remux with **ffmpeg's concat
demuxer + stream copy** (`-c copy`) — no re-encode (fast, lossless), correct because
all chunks share one codec.

## Implementation
- **Dependency:** `ffmpeg-static` (bundled ffmpeg binary — no manual system install).
- **`server/videoMerger.ts`**
  - `orderedChunkFiles(dir)` — chunk filenames sorted by numeric index; ignores the
    manifest, the merged output, and the concat list.
  - `buildConcatList(files)` — ffmpeg concat-demuxer list (pure, testable).
  - `mergeChunks(sessionDir, files, outputName)` — runs ffmpeg (`-y -f concat -safe 0
    -i list -c copy <sessionId>.webm`) with `cwd = sessionDir`; idempotent; cleans up.
- **`server/mockServer.ts`** — `/complete` now calls `mergeSessionVideo()` after
  writing the manifest, returns `{ merged: { file, mergedChunks } | null }`, and logs
  success/failure. **A merge failure never fails finalize** — the chunks stay safe.

## Behaviour decisions
- Missing chunks (e.g. dead-lettered) → merge whatever is present, in order.
- Idempotent: re-POST `/complete` regenerates the merged file (`-y`).
- ffmpeg failure → logged, `merged: null`, chunks untouched.

## Tests
- [x] `tests/videoMerger.test.ts` — ordering ignores non-chunks; concat-list format;
  missing dir → []; **real ffmpeg integration**: two generated WebM chunks merged into
  `<sessionId>.webm`, chunks preserved, temp list cleaned up; empty input rejected.
- [x] Full suite green (50 tests), tsc clean.
- [x] Manual E2E: uploaded 2 real 1s chunks → `/complete` → verified
  `<sessionId>.webm` on disk, **Duration 00:00:02.00** (correct order & continuity).
