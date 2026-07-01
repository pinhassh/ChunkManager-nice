/**
 * Shared domain contract for ChunkManager.
 *
 * Every component (recorder, storage, upload, UI, mock-server) depends on these
 * types so the pieces fit together without guessing each other's shapes.
 */

/**
 * Lifecycle of a single chunk as it moves from "just recorded" to "on the server".
 * `dead` = exceeded the lifetime retry cap; kept as a tombstone (blob freed) and
 * never retried again.
 */
export type ChunkStatus = 'pending' | 'uploading' | 'uploaded' | 'failed' | 'dead';

/** Composite identity of a chunk (the IndexedDB key), without any payload. */
export interface ChunkKey {
  sessionId: string;
  index: number;
}

/** Metadata describing a chunk, without the heavy binary payload. */
export interface ChunkMeta {
  /** Session this chunk belongs to. */
  sessionId: string;
  /** 0-based sequential position of the chunk within its session. */
  index: number;
  /** Size of the chunk blob in bytes. */
  size: number;
  /** Approximate recorded duration in milliseconds (~30000). */
  durationMs: number;
  /** MIME type the chunk was recorded with (e.g. "video/webm;codecs=vp9"). */
  mimeType: string;
  /** Epoch ms when the chunk was produced. */
  createdAt: number;
  /** Current upload lifecycle status. */
  status: ChunkStatus;
  /** How many upload attempts have been made so far. */
  attempts: number;
}

/** A chunk together with its recorded binary payload (as stored in IndexedDB). */
export interface ChunkRecord extends ChunkMeta {
  blob: Blob;
}

/** Lifecycle of a whole recording session. */
export type SessionStatus = 'recording' | 'stopped' | 'completed';

/** Metadata describing a recording session. */
export interface SessionMeta {
  sessionId: string;
  status: SessionStatus;
  /** Epoch ms when recording started. */
  startedAt: number;
  /** Epoch ms when recording stopped, or null while still recording. */
  endedAt: number | null;
  /** MIME type used for the session's chunks. */
  mimeType: string;
  /** Total number of chunks produced; known once the session is stopped. */
  totalChunks: number | null;
  /**
   * Metadata of chunks confirmed uploaded, accumulated as uploads succeed.
   * Lets us build the `complete` payload after the heavy blobs are deleted.
   */
  uploadedChunks?: Array<{ index: number; size: number; durationMs: number }>;
}

/**
 * Persistence port. `ChunkStore` implements this over IndexedDB; tests and other
 * layers depend on the interface, not the concrete class.
 */
export interface IChunkStore {
  init(): Promise<void>;
  saveChunk(record: ChunkRecord): Promise<void>;
  updateChunkStatus(
    sessionId: string,
    index: number,
    status: ChunkStatus,
    attempts?: number,
  ): Promise<void>;
  deleteChunk(sessionId: string, index: number): Promise<void>;
  /** Dead-letter a chunk: status → 'dead' and free its blob; never retried again (R2). */
  markChunkDead(sessionId: string, index: number): Promise<void>;
  /** Load a single chunk (with its blob) by key, or undefined. Memory-safe (R1). */
  getChunk(sessionId: string, index: number): Promise<ChunkRecord | undefined>;
  /** Keys of chunks still needing work (not uploaded/dead) — NO blobs loaded (R1). */
  getPendingChunkKeys(): Promise<ChunkKey[]>;
  /** Count of chunks still needing work, without loading any records (R1). */
  countPendingChunks(): Promise<number>;
  /**
   * All chunks still needing work, WITH blobs. Loads everything into memory, so
   * it is for tests/inspection only — never call it on a hot path (R1).
   */
  getPendingChunks(): Promise<ChunkRecord[]>;
  saveSession(meta: SessionMeta): Promise<void>;
  getSession(sessionId: string): Promise<SessionMeta | undefined>;
  /** Sessions whose status is not yet "completed" (used for crash recovery). */
  getUnfinishedSessions(): Promise<SessionMeta[]>;
  markSessionCompleted(sessionId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  /** Prune completed sessions older than the cutoff; returns how many were removed (R2). */
  pruneCompletedSessions(olderThanMs: number): Promise<number>;
}

/** Payload sent to the server when a recording finishes — everything needed to process the chunks. */
export interface CompletePayload {
  sessionId: string;
  totalChunks: number;
  startedAt: number;
  endedAt: number;
  mimeType: string;
  chunks: Array<{ index: number; size: number; durationMs: number }>;
}

/**
 * HTTP port to the mock server. `ApiClient` implements this; `UploadManager`
 * depends on the interface so it can be tested with a fake.
 */
export interface IApiClient {
  uploadChunk(sessionId: string, index: number, blob: Blob): Promise<void>;
  completeRecording(payload: CompletePayload): Promise<void>;
  getSessionStatus(sessionId: string): Promise<{ receivedIndexes: number[] }>;
}
