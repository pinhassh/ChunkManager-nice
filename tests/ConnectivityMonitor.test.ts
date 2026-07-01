/**
 * ConnectivityMonitor tests: the network indicator is driven by real reachability,
 * treats a hard navigator "offline" as authoritative, and emits only on transitions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectivityMonitor } from '../src/core/ConnectivityMonitor';

function setOnline(value: boolean): void {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => value });
}

beforeEach(() => {
  setOnline(true);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ConnectivityMonitor', () => {
  it('reports reachable=true after a successful probe', async () => {
    const probe = vi.fn().mockResolvedValue(true);
    const changes: boolean[] = [];
    const monitor = new ConnectivityMonitor(probe, (o) => changes.push(o), 1_000);

    monitor.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(changes).toEqual([true]);
    monitor.stop();
  });

  it('reports offline WITHOUT probing when navigator.onLine is false', async () => {
    setOnline(false);
    const probe = vi.fn().mockResolvedValue(true);
    const changes: boolean[] = [];
    const monitor = new ConnectivityMonitor(probe, (o) => changes.push(o), 1_000);

    monitor.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(changes).toEqual([false]);
    expect(probe).not.toHaveBeenCalled();
    monitor.stop();
  });

  it('emits only on transitions and detects the server going down', async () => {
    const probe = vi
      .fn()
      .mockResolvedValueOnce(true) // up
      .mockResolvedValueOnce(true) // still up — no emit
      .mockResolvedValue(false); // down
    const changes: boolean[] = [];
    const monitor = new ConnectivityMonitor(probe, (o) => changes.push(o), 1_000);

    monitor.start();
    await vi.advanceTimersByTimeAsync(0); // immediate check → true
    await vi.advanceTimersByTimeAsync(1_000); // → true (no change)
    await vi.advanceTimersByTimeAsync(1_000); // → false

    expect(changes).toEqual([true, false]);
    monitor.stop();
  });
});
