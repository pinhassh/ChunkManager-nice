# ChunkManager — Jira Board (simulated)

A lightweight Kanban board simulating Jira. Each task has a card under
`docs/jira/CM-XX-*.md` with details, acceptance criteria, its Git branch, and
progress. Update the `Status` and `Progress` columns as work moves.

**Legend:** `To Do` · `In Progress` · `Done`

| ID | Title | Branch | Status | Progress |
|------|-------|--------|--------|----------|
| [CM-01](CM-01-tooling-setup.md) | Tooling & project scaffold | `feat/tooling-setup` | Done | 100% |
| [CM-02](CM-02-shared-contract.md) | Shared contract (config, types, Logger) | `feat/logger` | Done | 100% |
| [CM-03](CM-03-chunk-store.md) | ChunkStore (IndexedDB persistence) | `feat/storage-indexeddb` | Done | 100% |
| [CM-04](CM-04-screen-recorder.md) | ScreenRecorder (getDisplayMedia + stop/restart) | `feat/screen-recorder` | Done | 100% |
| [CM-05](CM-05-upload-manager.md) | ApiClient + UploadManager (queue, retry, resume) | `feat/upload-manager` | Done | 100% |
| [CM-06](CM-06-mock-server.md) | Mock server (Express) | `feat/mock-server` | Done | 100% |
| [CM-07](CM-07-ui-integration.md) | UI + main.ts integration | `feat/ui` | Done | 100% |
| [CM-08](CM-08-tests.md) | Tests (positive + negative flows) | `test/coverage` | Done | 100% |
| [CM-09](CM-09-docs.md) | Documentation & Jira board | `docs/project-docs` | Done | 100% |
| [CM-10](CM-10-verification.md) | Build, verify E2E, finalize | `chore/verification` | Done | 100% |
| [CM-11](CM-11-robustness-hardening.md) | Robustness & resource-safety hardening | `fix/resource-safety` | In Progress | 0% |

## Sprint goal
Deliver a runnable, tested, fault-tolerant chunk-upload mechanism with a
double-clickable `index.html`, a mock server, and full recovery from network
drops, shutdowns, and mid-upload failures.

## Progress log
- **CM-01** Done — scaffold, Vite/Vitest config, single-file build wiring.
- **CM-02** Done — shared types/ports, config, enriched Logger.
- **CM-03** Done — IndexedDB ChunkStore (composite key, pending scan).
- **CM-04** Done — ScreenRecorder stop/restart 30s chunking, async-stop handling.
- **CM-05** Done — ApiClient + UploadManager (retry, resume, race-free finalize).
- **CM-06** Done — Express mock server, idempotent storage, failure simulation.
- **CM-07** Done — AppUI + main.ts wiring; recovery banner on startup.
- **CM-08** Done — 26 tests passing (positive + negative flows).
- **CM-09** Done — ARCHITECTURE, RECOVERY, ENGINEERING_DECISIONS, README.
- **CM-10** Done — build + 26 tests + E2E verified; merged `develop → main`.
- **CM-11** In progress — resource-safety hardening (OOM, quota, dead-letter, stale
  DB, fetch timeout, MediaStream leak, log cap) from the ChunkStore review + audit.

**Sprint 1 complete (CM-01…CM-10).** Sprint 2 (CM-11) hardening in progress.
