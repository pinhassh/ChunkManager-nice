# CM-13 — Explicit capture source selection (Screen / Window / Tab)

- **Branch:** `feat/source-selection`
- **Status:** In Progress (WIP saved, NOT merged to main)
- **Progress:** ~85%

## Context
The spec requires the user to choose between Screen / Window / Tab. This choice is
provided by the browser's native `getDisplayMedia` picker (it cannot be replaced by
app UI, for security). It already worked; this task makes the choice **explicit and
visible** — we read back and surface which source the user picked.

## Done (committed on this branch)
- `src/recording/ScreenRecorder.ts`
  - New `DisplaySurface` type + `displaySurfaceLabel()` helper + `SURFACE_LABELS`.
  - `onSourceSelected(surface, label)` callback; `get source` getter; `selectedSurface` field.
  - `readSelectedSurface()` reads `videoTrack.getSettings().displaySurface`.
  - `getDisplayMedia({ video: true })` documented as offering ALL surfaces; start log
    now includes the chosen surface.
- `src/ui/AppUI.ts` — `sourceEl` + `setSource(label)`.
- `src/index.html` — new "Source" status row (`#source`).
- `src/main.ts` — wires `onSourceSelected → ui.setSource`; resets source on start/stop/idle.
- Tests:
  - `tests/ScreenRecorder.test.ts` — fake track `getSettings`; picker offers all surfaces;
    reports selected surface; label mapping; "unknown" fallback.
  - `tests/AppUI.test.ts` — `#source` in DOM + `setSource` shows/resets.

## Remaining (to finish CM-13)
- [ ] Re-run `npm run test` to confirm green (last run had 1 failing test which was
      just fixed — the "unknown" fallback used a default-param pitfall; not re-verified).
- [ ] `npx tsc --noEmit` clean.
- [ ] `npm run build` to refresh the double-click `index.html` (NOT yet rebuilt).
- [ ] Docs: note in `README.md` + `docs/ARCHITECTURE.md` that the browser picker
      provides the Screen/Window/Tab choice and we surface the selection.
- [ ] Add CM-13 to `docs/jira/BOARD.md`.
- [ ] Merge `feat/source-selection → develop → main` and push.

## Note
Paused here at the user's request to handle an urgent task on `main`. This WIP is
committed on `feat/source-selection` and pushed; `main` was intentionally left
without these changes.
