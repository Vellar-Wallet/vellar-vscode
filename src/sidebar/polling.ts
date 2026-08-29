/**
 * One polled data source, generic over what it fetches. This is the piece every
 * sidebar section shares — wallet balance, endpoint catalog, and settlement history
 * are all one of these, differing only in `intervalMs` and the `fetcher` function.
 *
 * Three properties held deliberately, not incidentally:
 *
 *  1. The interval is a HARD FLOOR, not just a timer cadence. `refresh()` checks the
 *     real elapsed time since the last actual network call and skips (returning the
 *     cached result) if called again too soon — from a stray extra `refresh()` call,
 *     a rapid resume/pause cycle, anything. "Max one request per N seconds" holds
 *     regardless of what's asking, not just because nothing else asks more often
 *     today.
 *  2. Pausing stops the timer outright (`clearInterval`), it does not just skip
 *     inside the tick — so a paused source makes zero network calls, not
 *     zero-that-happen-to-get-rate-limited.
 *  3. Every fetch failure is caught HERE, once, and turned into a `{status:"error"}`
 *     result — callers (TreeDataProviders) never see a raw rejected promise, and the
 *     raw error goes only to whatever `onError` was given, which is expected to be
 *     `logAndGenericError`, never anything user-facing directly.
 */
export type PollResult<T> = { status: "loading" } | { status: "ok"; data: T } | { status: "error" };

export class PollingSource<T> {
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastFetchAt = 0;
  private latest: PollResult<T> = { status: "loading" };
  private readonly listeners = new Set<(result: PollResult<T>) => void>();
  private inFlight: Promise<void> | undefined;

  constructor(
    private readonly intervalMs: number,
    private readonly fetcher: () => Promise<T>,
    private readonly onError: (error: unknown) => void,
  ) {}

  get current(): PollResult<T> {
    return this.latest;
  }

  onDidUpdate(listener: (result: PollResult<T>) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private emit(result: PollResult<T>): void {
    this.latest = result;
    for (const listener of this.listeners) listener(result);
  }

  /** Runs a fetch now if the rate floor allows it, otherwise a no-op. Safe to call
   *  as often as something likes, e.g. on every focus/visibility change — the floor
   *  is what actually protects the network, not caller discipline. */
  async refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight; // never run two fetches concurrently
    const elapsed = Date.now() - this.lastFetchAt;
    if (this.lastFetchAt !== 0 && elapsed < this.intervalMs) return;

    this.inFlight = (async () => {
      this.lastFetchAt = Date.now();
      try {
        const data = await this.fetcher();
        this.emit({ status: "ok", data });
      } catch (err) {
        this.onError(err);
        this.emit({ status: "error" });
      } finally {
        this.inFlight = undefined;
      }
    })();
    return this.inFlight;
  }

  /** Starts the timer AND fires an immediate refresh — a freshly visible view
   *  shouldn't wait a full interval for its first real data. */
  start(): void {
    if (this.timer) return; // already running
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.intervalMs);
  }

  /** Fully stops ticking. No network calls happen while paused, this is not a
   *  softer "skip sometimes." */
  pause(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  dispose(): void {
    this.pause();
    this.listeners.clear();
  }
}

/**
 * Combines window focus and view visibility into one condition, and starts/pauses a
 * set of pollers together as that condition changes. "Poll only while the developer
 * is actually looking at this" — both signals have to be true, either one going
 * false pauses everything driven by this gate.
 */
/** Only the lifecycle surface a gate needs, never the data-carrying part of
 *  PollingSource<T> — a class generic is invariant in T, so a PollingSource<X>
 *  cannot structurally become a PollingSource<unknown>. start/pause/dispose
 *  never reference T at all, so a plain interface over just those, which every
 *  PollingSource<T> satisfies regardless of T, is the correct fix, not a cast. */
export interface Pausable {
  start(): void;
  pause(): void;
  dispose(): void;
}

export class FocusVisibilityGate {
  private focused = true;
  private visible = true;
  private readonly sources: Pausable[] = [];

  add(source: Pausable): void {
    this.sources.push(source);
    if (this.shouldPoll()) source.start();
  }

  setFocused(focused: boolean): void {
    this.focused = focused;
    this.apply();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.apply();
  }

  private shouldPoll(): boolean {
    return this.focused && this.visible;
  }

  private apply(): void {
    for (const source of this.sources) {
      if (this.shouldPoll()) source.start();
      else source.pause();
    }
  }

  dispose(): void {
    for (const source of this.sources) source.dispose();
  }
}
