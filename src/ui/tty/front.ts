/** How long a terminal that can't report focus counts as in front after its last key or click. */
export const IDLE_MS = 5 * 60_000;

/**
 * Whether this terminal window is in front, for notifications. Terminals that report focus
 * say so. For the ones that don't, the window counts as in front while you use it and as away
 * after a while without a key or a click, so a terminal you forgot about doesn't keep the
 * conversation it shows quiet on every other screen.
 */
export class FrontTracker {
  private reports = false;
  private away = false;
  private last: number;

  constructor(
    private readonly onAway: (away: boolean) => void,
    private readonly idleMs = IDLE_MS,
    private readonly now: () => number = Date.now,
  ) {
    this.last = now();
  }

  /** The terminal reported gaining or losing focus (from then on, that's all that counts). */
  focus(focused: boolean): void {
    this.reports = true;
    this.set(!focused);
  }

  /** A key, a click or a paste. */
  input(): void {
    this.last = this.now();
    if (!this.reports) this.set(false);
  }

  /** Call every so often: an unused terminal without focus reports goes away. */
  tick(): void {
    if (!this.reports && this.now() - this.last >= this.idleMs) this.set(true);
  }

  private set(away: boolean): void {
    if (away === this.away) return;
    this.away = away;
    this.onAway(away);
  }
}
