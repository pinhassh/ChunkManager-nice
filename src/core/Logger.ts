/**
 * Structured logger with three levels (success / warning / error).
 *
 * Requirement: every entry — especially errors — must say *exactly where in the
 * code* the call originated and carry an informative message plus useful context.
 * We satisfy this with:
 *   - `source`: an explicit "Module.method" string passed by the caller, AND
 *   - `origin`: the first app stack frame (file:line) auto-extracted from the
 *     error (or a fresh stack), so a failed call points back to real code.
 */

export type LogLevel = 'success' | 'warning' | 'error';

/** Extra structured context attached to a log entry. */
export interface LogContext {
  sessionId?: string;
  chunkIndex?: number;
  attempt?: number;
  httpStatus?: number;
  method?: string;
  url?: string;
  [key: string]: unknown;
}

export interface LogOptions {
  /** Explicit code location, e.g. "UploadManager.uploadChunk". */
  source: string;
  /** Structured, queryable context. */
  context?: LogContext;
  /** The underlying error, if any — its stack is mined for the origin frame. */
  error?: unknown;
}

/** A single emitted log record (also the shape observers receive). */
export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  source: string;
  /** First meaningful stack frame: "file:line:col". */
  origin: string;
  context?: LogContext;
  errorMessage?: string;
}

/** Observers (e.g. the UI) can subscribe to render logs in the app. */
export type LogListener = (entry: LogEntry) => void;

const CONSOLE_STYLES: Record<LogLevel, string> = {
  success: 'color: #2e7d32; font-weight: bold',
  warning: 'color: #ed6c02; font-weight: bold',
  error: 'color: #d32f2f; font-weight: bold',
};

/**
 * Extract the first stack frame that belongs to our own code (skips the logger
 * frames themselves and node/internal noise). Returns "file:line:col".
 */
function extractOrigin(stack: string | undefined): string {
  if (!stack) return 'unknown';
  const lines = stack.split('\n').slice(1); // drop the "Error" header line
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.includes('Logger.') || trimmed.includes('/core/Logger')) continue;
    // Pull "(path:line:col)" or "at path:line:col".
    const match = trimmed.match(/\(?([^()\s]+:\d+:\d+)\)?$/);
    if (match) return match[1];
  }
  return 'unknown';
}

export class Logger {
  private readonly listeners = new Set<LogListener>();

  /** Subscribe to log entries; returns an unsubscribe function. */
  subscribe(listener: LogListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  success(message: string, options: LogOptions): void {
    this.emit('success', message, options);
  }

  warning(message: string, options: LogOptions): void {
    this.emit('warning', message, options);
  }

  error(message: string, options: LogOptions): void {
    this.emit('error', message, options);
  }

  private emit(level: LogLevel, message: string, options: LogOptions): void {
    const error = options.error;
    const stack =
      error instanceof Error && error.stack ? error.stack : new Error().stack;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      source: options.source,
      origin: extractOrigin(stack),
      context: options.context,
      errorMessage: error instanceof Error ? error.message : error ? String(error) : undefined,
    };

    this.toConsole(entry);
    for (const listener of this.listeners) {
      listener(entry);
    }
  }

  private toConsole(entry: LogEntry): void {
    const method = entry.level === 'error' ? 'error' : entry.level === 'warning' ? 'warn' : 'log';
    const head = `%c[${entry.level.toUpperCase()}]`;
    const where = `${entry.source} @ ${entry.origin}`;
    const details: Record<string, unknown> = { where };
    if (entry.context) details.context = entry.context;
    if (entry.errorMessage) details.error = entry.errorMessage;
    // eslint-disable-next-line no-console
    console[method](head, CONSOLE_STYLES[entry.level], entry.message, details);
  }
}

/** Shared singleton used across the app. */
export const logger = new Logger();
