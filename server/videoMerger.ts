/**
 * videoMerger — joins a session's independently-recorded WebM chunks into one
 * playable video named after the session.
 *
 * Why not just concatenate the bytes? The chunks are COMPLETE standalone WebM
 * files (the recorder uses stop/restart so each is independently playable), so a
 * byte-level concat is invalid: it would contain multiple EBML headers/Segments
 * and each chunk's timestamps restart at 0. We remux them into a single valid
 * WebM using ffmpeg's concat demuxer with stream copy (`-c copy`) — no re-encode
 * (fast, lossless), which is correct because all chunks share the same codec.
 *
 * ffmpeg comes from the `ffmpeg-static` package (a bundled binary), so no manual
 * system install is required.
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

export interface MergeResult {
  /** Absolute path of the merged video. */
  outputFile: string;
  /** How many chunks were joined. */
  mergedChunks: number;
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
 * the same dir). Idempotent — re-running overwrites the output. Rejects if ffmpeg
 * is unavailable or the merge fails.
 */
export async function mergeChunks(
  sessionDir: string,
  files: string[],
  outputName: string,
): Promise<MergeResult> {
  if (!ffmpegPath) {
    throw new Error('ffmpeg binary not available (ffmpeg-static did not resolve a path)');
  }
  if (files.length === 0) {
    throw new Error('no chunks to merge');
  }

  const listPath = path.join(sessionDir, CONCAT_LIST);
  await fs.writeFile(listPath, buildConcatList(files));

  try {
    // -f concat + -c copy: remux (no re-encode). -y overwrites for idempotency.
    await execFileAsync(
      ffmpegPath,
      ['-y', '-f', 'concat', '-safe', '0', '-i', CONCAT_LIST, '-c', 'copy', outputName],
      { cwd: sessionDir },
    );
    return { outputFile: path.join(sessionDir, outputName), mergedChunks: files.length };
  } finally {
    await fs.rm(listPath, { force: true });
  }
}
