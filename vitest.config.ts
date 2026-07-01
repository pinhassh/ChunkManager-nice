import { defineConfig } from 'vitest/config';

/**
 * Test config. Uses jsdom so browser globals (window, navigator, events) exist,
 * and a setup file that installs an in-memory IndexedDB polyfill.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
  },
});
