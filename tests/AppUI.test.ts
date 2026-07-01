/**
 * AppUI tests (CM-11): the on-screen log list is capped so it can't grow without
 * bound (R6), plus basic button wiring / state toggling.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppUI } from '../src/ui/AppUI';
import { MAX_LOG_ENTRIES } from '../src/core/config';
import type { LogEntry } from '../src/core/Logger';

function setupDom(): void {
  document.body.innerHTML = `
    <button id="start-btn"></button>
    <button id="stop-btn" disabled></button>
    <span id="state"></span>
    <span id="session-id"></span>
    <span id="source"></span>
    <span id="chunk-count"></span>
    <span id="pending-count"></span>
    <span id="uploaded-count"></span>
    <span id="network"></span>
    <section id="recovery-banner"></section>
    <ul id="log"></ul>`;
}

function logEntry(message: string): LogEntry {
  return {
    timestamp: '2020-01-01T00:00:00.000Z',
    level: 'success',
    message,
    source: 'test',
    origin: 'test:1:1',
  };
}

beforeEach(() => {
  setupDom();
});

describe('AppUI — log cap (R6)', () => {
  it('keeps at most MAX_LOG_ENTRIES rows in the DOM', () => {
    const ui = new AppUI({ onStart: () => {}, onStop: () => {} });

    for (let i = 0; i < MAX_LOG_ENTRIES + 75; i++) {
      ui.appendLog(logEntry(`entry ${i}`));
    }

    const list = document.getElementById('log')!;
    expect(list.childElementCount).toBe(MAX_LOG_ENTRIES);
    // The oldest entries were trimmed; the newest remains.
    expect(list.lastElementChild?.textContent).toContain(`entry ${MAX_LOG_ENTRIES + 74}`);
  });
});

describe('AppUI — controls', () => {
  it('wires Start/Stop buttons and toggles disabled state', () => {
    const onStart = vi.fn();
    const onStop = vi.fn();
    const ui = new AppUI({ onStart, onStop });

    const startBtn = document.getElementById('start-btn') as HTMLButtonElement;
    const stopBtn = document.getElementById('stop-btn') as HTMLButtonElement;

    startBtn.click();
    expect(onStart).toHaveBeenCalledOnce();

    ui.setState('recording');
    expect(startBtn.disabled).toBe(true);
    expect(stopBtn.disabled).toBe(false);

    stopBtn.click();
    expect(onStop).toHaveBeenCalledOnce();

    ui.setState('idle');
    expect(startBtn.disabled).toBe(false);
    expect(stopBtn.disabled).toBe(true);
  });

  it('shows the selected capture source and resets it', () => {
    const ui = new AppUI({ onStart: () => {}, onStop: () => {} });
    const source = document.getElementById('source')!;

    ui.setSource('Entire screen');
    expect(source.textContent).toBe('Entire screen');

    ui.setSource(null);
    expect(source.textContent).toBe('—');
  });
});
