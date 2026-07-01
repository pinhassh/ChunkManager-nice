/**
 * Mock upload server for ChunkManager.
 *
 * Simulates the remote cloud endpoint that recording chunks are uploaded to.
 * The real recorder splits a screen recording into sequential .webm chunks and
 * uploads them one-by-one; when recording finishes it POSTs a manifest so the
 * backend can process the chunks. This server stands in for that backend during
 * local development and manual resilience testing.
 *
 * Responsibilities:
 *   - Accept and persist chunk blobs by (sessionId, index) — idempotently.
 *   - Accept the finalize manifest and persist it.
 *   - Report which chunk indexes are already on disk (for resume/reconcile).
 *   - Optionally simulate transient upload failures (MOCK_FAIL_RATE / ?fail=1).
 *
 * Actual processing of the recording (stitching, transcoding, etc.) is out of
 * scope — this server only receives and stores.
 *
 * Run via: `npm run mock-server` (tsx server/mockServer.ts). Node 22, ESM.
 */

import express, { type Request, type Response } from 'express';
import cors from 'cors';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeChunks, orderedChunkFiles } from './videoMerger';

/** Payload the client sends to finalize a recording (mirrors the shared CompletePayload). */
interface CompletePayload {
  sessionId: string;
  totalChunks: number;
  startedAt: number;
  endedAt: number;
  mimeType: string;
  chunks: Array<{ index: number; size: number; durationMs: number }>;
}

// --- Configuration -----------------------------------------------------------

const PORT = Number(process.env.PORT) || 4000;

/** Fraction (0..1) of chunk uploads to reject with 503 for resilience testing. */
const FAIL_RATE = clampRate(Number.parseFloat(process.env.MOCK_FAIL_RATE ?? ''));

/** Uploads live next to this file, resolved independently of process.cwd(). */
const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(SERVER_DIR, 'uploads');

// --- Structured logging (self-contained; no browser Logger import) -----------

type Level = 'success' | 'warning' | 'error';

/** Print `[LEVEL] <ISO timestamp> <message>` plus a structured context object. */
function log(level: Level, message: string, context: Record<string, unknown> = {}): void {
  const line = `[${level.toUpperCase()}] ${new Date().toISOString()} ${message}`;
  const method = level === 'error' ? console.error : level === 'warning' ? console.warn : console.log;
  method(line, context);
}

// --- Helpers -----------------------------------------------------------------

/** Coerce an env-derived number into a valid 0..1 rate, defaulting to 0. */
function clampRate(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Absolute path to a session's upload folder. */
function sessionDir(sessionId: string): string {
  return path.join(UPLOADS_DIR, sessionId);
}

/** Read the sorted list of chunk indexes already stored for a session. */
async function readReceivedIndexes(sessionId: string): Promise<number[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(sessionDir(sessionId));
  } catch (err) {
    // Missing folder simply means nothing has been received yet.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  return entries
    .map((name) => /^(\d+)\.webm$/.exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
}

/** Decide whether this chunk upload should be simulated as a failure. */
function shouldSimulateFailure(req: Request): boolean {
  if (req.query.fail === '1') return true;
  return FAIL_RATE > 0 && Math.random() < FAIL_RATE;
}

/**
 * Merge a session's chunks into `<sessionId>.webm` (in the session folder).
 * Returns a summary, or null if there was nothing to merge or it failed — a merge
 * failure never blocks finalize, since the individual chunks are already safe.
 */
async function mergeSessionVideo(
  dir: string,
  sessionId: string,
): Promise<{ file: string; mergedChunks: number } | null> {
  try {
    const files = await orderedChunkFiles(dir);
    if (files.length === 0) {
      log('warning', 'No chunks to merge for session', { sessionId });
      return null;
    }

    const result = await mergeChunks(dir, files, `${sessionId}.webm`);
    const file = path.basename(result.outputFile);
    log('success', 'Merged chunks into a single video', {
      sessionId,
      file,
      mergedChunks: result.mergedChunks,
    });
    return { file, mergedChunks: result.mergedChunks };
  } catch (err) {
    log('error', 'Failed to merge chunks into a single video', { sessionId, error: String(err) });
    return null;
  }
}

// --- App ---------------------------------------------------------------------

const app = express();

// Allow any origin (including file://) so the browser client can reach us.
app.use(cors());

/**
 * Receive a single chunk (raw .webm binary) and store it by (sessionId, index).
 *
 * Idempotent: writing to `<sessionId>/<index>.webm` means a re-upload after a
 * partial failure overwrites the same file — chunks are never duplicated.
 *
 * Failure simulation: when MOCK_FAIL_RATE is set (or `?fail=1` is passed) the
 * request is rejected with 503 *before* writing, to exercise client retries.
 */
app.post(
  '/recordings/:sessionId/chunks/:index',
  // `type: () => true` parses the body as a Buffer regardless of (or a missing)
  // Content-Type, so uploads work even if a client omits the header.
  express.raw({ type: () => true, limit: '100mb' }),
  async (req: Request, res: Response) => {
    const { sessionId } = req.params;
    const index = Number(req.params.index);

    try {
      if (!Number.isInteger(index) || index < 0) {
        res.status(400).json({ ok: false, error: 'invalid chunk index' });
        return;
      }

      if (shouldSimulateFailure(req)) {
        log('warning', 'Simulated chunk upload failure', {
          sessionId,
          index,
          failRate: FAIL_RATE,
          forced: req.query.fail === '1',
        });
        res.status(503).json({ ok: false, error: 'simulated upload failure' });
        return;
      }

      const body = req.body as Buffer;
      const bytes = Buffer.isBuffer(body) ? body.length : 0;

      const dir = sessionDir(sessionId);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, `${index}.webm`), body);

      log('success', 'Chunk received', { sessionId, index, bytes });
      res.status(200).json({ ok: true, sessionId, index, bytes });
    } catch (err) {
      log('error', 'Failed to store chunk', { sessionId, index, error: String(err) });
      res.status(500).json({ ok: false, error: String(err) });
    }
  },
);

/**
 * Finalize a recording: persist the manifest, MERGE the chunks into a single video
 * named after the session, and report how many chunk files are on disk so the
 * client can reconcile against `totalChunks`.
 */
app.post('/recordings/:sessionId/complete', express.json(), async (req: Request, res: Response) => {
  const { sessionId } = req.params;

  try {
    const payload = req.body as CompletePayload;
    const dir = sessionDir(sessionId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(payload, null, 2));

    const received = (await readReceivedIndexes(sessionId)).length;

    log('success', 'Recording complete', {
      sessionId,
      totalChunks: payload?.totalChunks,
      received,
    });

    // Merge all chunks into `<sessionId>.webm`. A merge failure must not fail the
    // request — the individual chunks remain safe on disk either way.
    const merged = await mergeSessionVideo(dir, sessionId);

    res.status(200).json({ ok: true, sessionId, received, merged });
  } catch (err) {
    log('error', 'Failed to finalize recording', { sessionId, error: String(err) });
    res.status(500).json({ ok: false, error: String(err) });
  }
});

/**
 * Report the sorted indexes of chunks already stored for a session, so the
 * client can resume/reconcile after an interruption.
 */
app.get('/recordings/:sessionId/status', async (req: Request, res: Response) => {
  const { sessionId } = req.params;

  try {
    const receivedIndexes = await readReceivedIndexes(sessionId);
    res.status(200).json({ sessionId, receivedIndexes });
  } catch (err) {
    log('error', 'Failed to read session status', { sessionId, error: String(err) });
    res.status(500).json({ ok: false, error: String(err) });
  }
});

/** Liveness probe. */
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ ok: true });
});

// --- Startup -----------------------------------------------------------------

async function start(): Promise<void> {
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  app.listen(PORT, () => {
    log('success', 'Mock upload server listening', {
      url: `http://localhost:${PORT}`,
      uploadsDir: UPLOADS_DIR,
      failRate: FAIL_RATE,
    });
  });
}

start().catch((err) => {
  log('error', 'Failed to start mock server', { error: String(err) });
  process.exitCode = 1;
});
