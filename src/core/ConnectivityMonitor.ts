/**
 * ConnectivityMonitor — reports whether the upload server is actually reachable.
 *
 * Why not just `navigator.onLine`? That flag only reflects whether the machine has
 * *some* network interface up (Wi-Fi connected, a VPN/virtual adapter, etc.). It is
 * routinely `true` when there is no real internet or the server is down, and the
 * `offline` event does not fire in those cases. For an app whose whole job is
 * uploading, the meaningful status is "can I reach the server", so we actively probe
 * a health endpoint on an interval (and react to the browser's online/offline hints).
 *
 * `navigator.onLine === false` is treated as a reliable "definitely offline" signal
 * (we skip the probe); anything else is confirmed by an actual request.
 */

export class ConnectivityMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Last reported reachability; null until the first probe so the first result always emits. */
  private online: boolean | null = null;

  constructor(
    private readonly probe: () => Promise<boolean>,
    private readonly onChange: (online: boolean) => void,
    private readonly intervalMs: number,
  ) {}

  /** Begin probing immediately and on an interval, plus react to online/offline hints. */
  start(): void {
    void this.check();
    this.timer = setInterval(() => void this.check(), this.intervalMs);
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.hint);
      window.addEventListener('offline', this.hint);
    }
  }

  /** Stop probing and remove listeners. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.hint);
      window.removeEventListener('offline', this.hint);
    }
  }

  /** A browser online/offline event just fired — re-check now instead of waiting. */
  private readonly hint = (): void => {
    void this.check();
  };

  /** Determine reachability and emit only when it changes. */
  private async check(): Promise<void> {
    const reachable =
      typeof navigator !== 'undefined' && navigator.onLine === false
        ? false // trust a hard "offline" without wasting a request
        : await this.probe();

    if (reachable !== this.online) {
      this.online = reachable;
      this.onChange(reachable);
    }
  }
}
