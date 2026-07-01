/**
 * AppUI — the thin presentation layer.
 *
 * Owns all DOM access: it binds the Start/Stop buttons, renders recording state,
 * upload counters, network status, a recovery banner, and a live log list. It has
 * no business logic — `main.ts` wires it to the recorder and upload engine.
 */

import { MAX_LOG_ENTRIES } from '../core/config';
import type { LogEntry, LogLevel } from '../core/Logger';

/** Recording lifecycle states reflected in the UI. */
export type UiState = 'idle' | 'recording' | 'stopped';

/** Callbacks the UI raises in response to user actions. */
export interface AppUIHandlers {
  onStart: () => void;
  onStop: () => void;
}

/** Counters shown in the status panel. */
export interface UiCounts {
  chunks: number;
  pending: number;
  uploaded: number;
}

/** Query a required element by id, failing loudly if the markup is missing. */
function required<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id) as T | null;
  if (!el) throw new Error(`AppUI: missing required element #${id}`);
  return el;
}

export class AppUI {
  private readonly startBtn = required<HTMLButtonElement>('start-btn');
  private readonly stopBtn = required<HTMLButtonElement>('stop-btn');
  private readonly stateEl = required('state');
  private readonly sessionEl = required('session-id');
  private readonly chunkCountEl = required('chunk-count');
  private readonly pendingCountEl = required('pending-count');
  private readonly uploadedCountEl = required('uploaded-count');
  private readonly networkEl = required('network');
  private readonly bannerEl = required('recovery-banner');
  private readonly logEl = required<HTMLUListElement>('log');

  constructor(handlers: AppUIHandlers) {
    this.startBtn.addEventListener('click', () => handlers.onStart());
    this.stopBtn.addEventListener('click', () => handlers.onStop());
    this.setNetwork(navigator.onLine);
  }

  /** Toggle the buttons and label for the current recording state. */
  setState(state: UiState): void {
    this.stateEl.textContent = state;
    const recording = state === 'recording';
    this.startBtn.disabled = recording;
    this.stopBtn.disabled = !recording;
  }

  setSessionId(sessionId: string | null): void {
    this.sessionEl.textContent = sessionId ?? '—';
  }

  setCounts(counts: UiCounts): void {
    this.chunkCountEl.textContent = String(counts.chunks);
    this.pendingCountEl.textContent = String(counts.pending);
    this.uploadedCountEl.textContent = String(counts.uploaded);
  }

  setNetwork(online: boolean): void {
    this.networkEl.textContent = online ? 'online' : 'offline';
    this.networkEl.style.color = online ? 'var(--success)' : 'var(--error)';
  }

  /** Show a recovery banner (e.g. "resuming N chunks"); pass null to hide it. */
  showRecovery(message: string | null): void {
    if (!message) {
      this.bannerEl.classList.add('banner--hidden');
      this.bannerEl.textContent = '';
      return;
    }
    this.bannerEl.textContent = message;
    this.bannerEl.classList.remove('banner--hidden');
  }

  /** Append a single log entry to the on-screen list (newest at the bottom). */
  appendLog(entry: LogEntry): void {
    const li = document.createElement('li');
    li.className = `log--${entry.level satisfies LogLevel}`;

    const head = `${entry.timestamp.split('T')[1]?.replace('Z', '') ?? ''} — ${entry.message}`;
    const meta = document.createElement('span');
    meta.className = 'log__meta';
    const parts = [entry.source, entry.origin && `@ ${entry.origin}`, entry.errorMessage]
      .filter(Boolean)
      .join('  ');
    meta.textContent = `\n${parts}`;

    li.textContent = head;
    li.appendChild(meta);
    this.logEl.appendChild(li);

    // Cap the list so it can't grow without bound over a long session (R6).
    while (this.logEl.childElementCount > MAX_LOG_ENTRIES) {
      this.logEl.removeChild(this.logEl.firstElementChild!);
    }

    this.logEl.scrollTop = this.logEl.scrollHeight;
  }
}
