# CM-06 — Mock server (Express)

- **Branch:** `feat/mock-server`
- **Status:** Done
- **Progress:** 100%

## Description
A local Express server simulating the remote cloud endpoint.

## Acceptance criteria
- [ ] `POST /recordings/:sessionId/chunks/:index` — stores binary to
  `server/uploads/<sessionId>/<index>.webm` (idempotent), returns 200.
- [ ] `POST /recordings/:sessionId/complete` — accepts full metadata, marks done.
- [ ] `GET /recordings/:sessionId/status` — returns received indexes.
- [ ] CORS open (fetch works from `file://`).
- [ ] Optional failure simulation flag for manual resilience testing.
- [ ] Structured request logging.

## Notes
Runs via `npm run mock-server` (tsx). Does not implement actual processing.
