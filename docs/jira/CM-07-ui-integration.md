# CM-07 — UI + main.ts integration

- **Branch:** `feat/ui`
- **Status:** To Do
- **Progress:** 0%

## Description
Wire the pieces together and render status + logs to the user.

## Acceptance criteria
- [ ] `AppUI` binds Start/Stop buttons, renders state, counters, network, logs.
- [ ] `main.ts` constructs ChunkStore, ApiClient, UploadManager, ScreenRecorder
  and connects the event flow.
- [ ] On load, runs `resume()` and shows a recovery banner if pending work exists.
- [ ] Start disables Start / enables Stop and vice-versa.

## Notes
Log subscription feeds the on-screen log list with success/warning/error styling.
