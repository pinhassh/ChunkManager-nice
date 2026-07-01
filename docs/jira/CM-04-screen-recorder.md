# CM-04 — ScreenRecorder (getDisplayMedia + stop/restart)

- **Branch:** `feat/screen-recorder`
- **Status:** Done
- **Progress:** 100%

## Description
Capture the screen and produce independently playable 30s chunks via the
stop/restart strategy.

## Acceptance criteria
- [ ] `start()` opens `getDisplayMedia`, picks a supported MIME type.
- [ ] Every 30s: stop the recorder → emit a complete chunk → immediately restart.
- [ ] `stop()` flushes the final chunk and releases the media tracks.
- [ ] `onChunk` callback delivers `{ blob, index, durationMs, mimeType }`.
- [ ] Handles user-cancelled share / permission denial with a clean error log.

## Notes
Stop/restart (not `timeslice`) is required so each chunk has its own header and
is playable on its own.
