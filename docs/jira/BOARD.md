# ChunkManager — Jira Board (simulated)

A lightweight Kanban board simulating Jira. Each task has a card under
`docs/jira/CM-XX-*.md` with details, acceptance criteria, its Git branch, and
progress. Update the `Status` and `Progress` columns as work moves.

**Legend:** `To Do` · `In Progress` · `Done`

| ID | Title | Branch | Status | Progress |
|------|-------|--------|--------|----------|
| [CM-01](CM-01-tooling-setup.md) | Tooling & project scaffold | `feat/tooling-setup` | Done | 100% |
| [CM-02](CM-02-shared-contract.md) | Shared contract (config, types, Logger) | `feat/logger` | Done | 100% |
| [CM-03](CM-03-chunk-store.md) | ChunkStore (IndexedDB persistence) | `feat/storage-indexeddb` | To Do | 0% |
| [CM-04](CM-04-screen-recorder.md) | ScreenRecorder (getDisplayMedia + stop/restart) | `feat/screen-recorder` | To Do | 0% |
| [CM-05](CM-05-upload-manager.md) | ApiClient + UploadManager (queue, retry, resume) | `feat/upload-manager` | To Do | 0% |
| [CM-06](CM-06-mock-server.md) | Mock server (Express) | `feat/mock-server` | To Do | 0% |
| [CM-07](CM-07-ui-integration.md) | UI + main.ts integration | `feat/ui` | To Do | 0% |
| [CM-08](CM-08-tests.md) | Tests (positive + negative flows) | `test/coverage` | To Do | 0% |
| [CM-09](CM-09-docs.md) | Documentation & Jira board | `docs/project-docs` | In Progress | 40% |
| [CM-10](CM-10-verification.md) | Build, verify E2E, finalize | `chore/verification` | To Do | 0% |

## Sprint goal
Deliver a runnable, tested, fault-tolerant chunk-upload mechanism with a
double-clickable `index.html`, a mock server, and full recovery from network
drops, shutdowns, and mid-upload failures.

## Progress log
- **CM-01** Done — scaffold, Vite/Vitest config, single-file build wiring.
- **CM-02** Done — shared types/ports, config, enriched Logger.
- **CM-09** In progress — plan + board + cards created; component docs pending.
