/**
 * videoMerger — joins a session's independently-recorded WebM chunks into one
 * playable video named after the session.
 *
 * Why not just concatenate the bytes? The chunks are COMPLETE standalone WebM
 * files (the recorder uses stop/restart so each is independently playable), so a
 * byte-level concat is invalid: it would contain multiple EBML headers/Segments
 * and each chunk's timestamps restart at 0. We remux them with ffmpeg's concat
 * demuxer.
 *
 * Strategy: try **stream copy** first (`-c copy` — fast, lossless, correct when the
 * chunks share a codec). Real MediaRecorder output can have timestamp quirks that
 * make copy fail, so we **fall back to re-encoding**, which always produces a clean
 * continuous file. ffmpeg comes from the bundled `ffmpeg-static` (no system install).
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';

const execFileAsync = promisify(execFile);

/** Chunk files are named `<index>.webm`; anything else in the dir is ignored. */
const CHUNK_FILE = /^(\d+)\.webm$/;

/** Temporary concat-list filename written into the session dir during a merge. */
const CONCAT_LIST = '.concat-list.txt';

/** Path to the bundled ffmpeg binary, or null if it could not be resolved. */
export const ffmpegBinaryPath: string | null = ffmpegPath ?? null;

export type MergeStrategy = 'copy' | 'reencode';

export interface MergeResult {
  /** Absolute path of the merged video. */
  outputFile: string;
  /** How many chunks were joined. */
  mergedChunks: number;
  /** Which ffmpeg strategy produced the output. */
  strategy: MergeStrategy;
}

/**
 * The chunk filenames in a session dir, ordered by numeric index. Non-chunk files
 * (the manifest, the merged output, the concat list) are ignored.
 */
export async function orderedChunkFiles(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  return entries
    .map((name) => ({ name, match: CHUNK_FILE.exec(name) }))
    .filter((e): e is { name: string; match: RegExpExecArray } => e.match !== null)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]))
    .map((e) => e.name);
}

/**
 * Build the ffmpeg concat-demuxer list content. Uses bare basenames (ffmpeg runs
 * with `cwd` = the session dir), so there is no path escaping to worry about.
 */
export function buildConcatList(files: string[]): string {
  return files.map((file) => `file '${file}'`).join('\n') + '\n';
}

/**
 * Merge the given ordered chunk files in `sessionDir` into `outputName` (written to
 * the same dir). Tries stream copy, then re-encode. Idempotent (`-y` overwrites).
 * Rejects (with the ffmpeg error detail) if ffmpeg is unavailable or both fail.
 */
export async function mergeChunks(
  sessionDir: string,
  files: string[],
  outputName: string,
): Promise<MergeResult> {
  if (!ffmpegBinaryPath) {
    throw new Error('ffmpeg binary not available (ffmpeg-static did not resolve a path)');
  }
  if (files.length === 0) {
    throw new Error('no chunks to merge');
  }

  const listPath = path.join(sessionDir, CONCAT_LIST);
  await fs.writeFile(listPath, buildConcatList(files));

  const base = ['-y', '-f', 'concat', '-safe', '0', '-i', CONCAT_LIST];
  const outputFile = path.join(sessionDir, outputName);

  try {
    // Fast path: stream copy (no re-encode).
    await runFfmpeg([...base, '-c', 'copy', outputName], sessionDir);
    return { outputFile, mergedChunks: files.length, strategy: 'copy' };
  } catch (copyError) {
    // Safe path: re-encode. Fixes timestamp/container quirks that break stream copy.
    try {
      await runFfmpeg(
        [...base, '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '32', '-row-mt', '1', '-an', outputName],
        sessionDir,
      );
      return { outputFile, mergedChunks: files.length, strategy: 'reencode' };
    } catch (encodeError) {
      throw new Error(
        `merge failed — copy: ${(copyError as Error).message}; reencode: ${(encodeError as Error).message}`,
      );
    }
  } finally {
    await fs.rm(listPath, { force: true });
  }
}

/** Run ffmpeg and, on failure, surface the tail of its stderr in the thrown error. */
async function runFfmpeg(args: string[], cwd: string): Promise<void> {
  try {
    await execFileAsync(ffmpegBinaryPath as string, args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    const e = err as { stderr?: string | Buffer; message?: string };
    const stderr = e.stderr ? e.stderr.toString() : '';
    const tail = (stderr || e.message || String(err)).trim().split('\n').slice(-4).join(' | ');
    throw new Error(tail || 'ffmpeg failed');
  }
}
