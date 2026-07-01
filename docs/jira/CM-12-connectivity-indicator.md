# CM-12 — Network indicator shows "online" with no connectivity

- **Branch:** `fix/connectivity-indicator`
- **Status:** Done
- **Progress:** 100%
- **Reported by:** user (manual testing of the built app)

## Problem
The UI "Network" status stayed `online` even when disconnected from the network,
and showed `online` on a fresh load with no network at all.

## Root cause
The indicator was driven solely by `navigator.onLine` and the `online`/`offline`
events. `navigator.onLine` is unreliable: it is `true` whenever the machine has any
network interface up (Wi-Fi to a router with no internet, a VPN/virtual adapter,
etc.), and the `offline` event does not fire in those cases. For an upload app the
meaningful question is "can I reach the server", which `navigator.onLine` does not
answer.

## Fix
- New `ConnectivityMonitor` (`src/core/ConnectivityMonitor.ts`) actively probes the
  server's `/health` endpoint every `CONNECTIVITY_POLL_MS` (5s) and on browser
  online/offline hints, emitting only on transitions. A hard `navigator.onLine ===
  false` is trusted as "offline" without wasting a probe.
- `ApiClient.checkHealth()` — reachability probe (uses the request timeout; returns
  false instead of throwing).
- `main.ts` drives the indicator from the monitor, and kicks a `drain()` the moment
  the server becomes reachable again (faster recovery than waiting for the next chunk).
- The indicator starts as `checking…` instead of a guessed value.

## Tests
- [x] `ConnectivityMonitor`: reachable→true after probe; offline without probing when
  `navigator.onLine` is false; emits only on transitions (detects server going down).
- [x] `ApiClient.checkHealth`: true on 200, false on failure.
- [x] Full suite green (45 tests), tsc clean.

## Manual verification
- Start the app with the mock server **down** → indicator shows `offline`.
- Start the server → within ~5s indicator flips to `online` and pending uploads drain.
- Stop the server mid-session → indicator flips to `offline`.
