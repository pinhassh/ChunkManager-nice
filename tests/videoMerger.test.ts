/**
 * videoMerger tests: chunk ordering / concat-list building (pure), plus a real
 * end-to-end merge using the bundled ffmpeg on generated WebM chunks.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import { buildConcatList, mergeChunks, orderedChunkFiles } from '../server/videoMerger';

const execFileAsync = promisify(execFile);

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-merge-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** Generate a tiny 1-second VP8 WebM file in the temp dir. */
async function writeChunk(name: string): Promise<void> {
  await execFileAsync(
    ffmpegPath as string,
    ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=32x24:d=1:r=10', '-c:v', 'libvpx', '-an', name],
    { cwd: dir },
  );
}

describe('videoMerger — ordering & list (pure)', () => {
  it('orders chunk files numerically and ignores non-chunk files', async () => {
    for (const name of [
      '10.webm',
      '2.webm',
      '0.webm',
      'manifest.json',
      'deadbeef-session.webm', // the merged output — must be ignored
      '.concat-list.txt',
    ]) {
      await fs.writeFile(path.join(dir, name), 'x');
    }

    expect(await orderedChunkFiles(dir)).toEqual(['0.webm', '2.webm', '10.webm']);
  });

  it('returns [] for a missing directory', async () => {
    expect(await orderedChunkFiles(path.join(dir, 'does-not-exist'))).toEqual([]);
  });

  it('builds an ffmpeg concat list', () => {
    expect(buildConcatList(['0.webm', '1.webm'])).toBe("file '0.webm'\nfile '1.webm'\n");
  });
});

describe('videoMerger — real ffmpeg merge (integration)', () => {
  it('merges chunks into one WebM named after the session, keeping the chunks', async () => {
    await writeChunk('0.webm');
    await writeChunk('1.webm');
    const sessionId = 'session-abc';

    const files = await orderedChunkFiles(dir);
    expect(files).toEqual(['0.webm', '1.webm']);

    const result = await mergeChunks(dir, files, `${sessionId}.webm`);

    const stat = await fs.stat(result.outputFile);
    expect(stat.size).toBeGreaterThan(0);
    expect(result.mergedChunks).toBe(2);
    expect(path.basename(result.outputFile)).toBe('session-abc.webm');

    // Original chunks remain and the merged output is NOT counted as a chunk.
    expect(await orderedChunkFiles(dir)).toEqual(['0.webm', '1.webm']);
    // The temp concat list was cleaned up.
    await expect(fs.stat(path.join(dir, '.concat-list.txt'))).rejects.toThrow();
  }, 30_000);

  it('rejects when there are no chunks to merge', async () => {
    await expect(mergeChunks(dir, [], 'x.webm')).rejects.toThrow(/no chunks/);
  });
});
