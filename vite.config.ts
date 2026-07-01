import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * Build config.
 *
 * The dev source template lives in `src/index.html` (so `root: 'src'`).
 * `vite-plugin-singlefile` inlines all JS/CSS into a single HTML file, and we
 * emit it to the project root as `index.html` so it can be opened with a
 * double-click (file://) — no dev server required, as the requirements demand.
 */
export default defineConfig({
  root: 'src',
  plugins: [viteSingleFile()],
  build: {
    // Output to the project root (one level up from `src`).
    outDir: '..',
    // Do NOT wipe the project root before building.
    emptyOutDir: false,
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 100_000_000,
  },
});
