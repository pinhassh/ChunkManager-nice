# CM-01 — Tooling & project scaffold

- **Branch:** `feat/tooling-setup`
- **Status:** Done
- **Progress:** 100%

## Description
Set up the Vanilla TypeScript + Vite project so it builds to a single,
double-clickable `index.html`, and configure Vitest for tests.

## Acceptance criteria
- [x] `package.json` with `dev` / `build` / `mock-server` / `test` scripts.
- [x] `tsconfig.json` (strict).
- [x] `vite.config.ts` with `vite-plugin-singlefile`, output to root `index.html`.
- [x] `vitest.config.ts` (jsdom + fake-indexeddb setup).
- [x] `.gitignore` (node_modules, server/uploads, build artifacts).
- [x] `src/index.html` dev template + `src/styles.css`.

## Notes
Build uses `root: 'src'`, `outDir: '..'`, `emptyOutDir: false` to emit the
self-contained bundle at the project root without clobbering source.
