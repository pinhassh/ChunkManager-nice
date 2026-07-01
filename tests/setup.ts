/**
 * Vitest global setup.
 *
 * Installs an in-memory IndexedDB implementation so storage tests run without a
 * real browser, and makes a `structuredClone`-friendly Blob available.
 */
import 'fake-indexeddb/auto';
