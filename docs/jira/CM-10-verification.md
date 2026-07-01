# CM-10 — Build, verify E2E, finalize

- **Branch:** `chore/verification`
- **Status:** To Do
- **Progress:** 0%

## Description
Prove the whole thing runs and merge to `main`.

## Acceptance criteria
- [ ] `npm install` clean.
- [ ] `npm run build` emits root `index.html`.
- [ ] `npm run test` all green.
- [ ] Manual E2E: record → chunks on disk; kill server → retries; restart → drain;
  refresh → resume; stop → `complete` received.
- [ ] `develop` merged to `main`.

## Notes
Verification steps mirror `docs/PROJECT_PLAN.md` → Verification.
