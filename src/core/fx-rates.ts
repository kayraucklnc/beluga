import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FxRates } from './earnings-store.js';
import { klaudHome } from './home.js';
import type { Store } from './store.js';

/**
 * Exchange rates for adding up earnings in several currencies: the European Central Bank's daily
 * rates from frankfurter.app (free, no account; the request says nothing about you). Fetched
 * only while some project has Stripe connected, alongside the daily Stripe count, at most once
 * every 20 hours, kept in ~/.klaud/fx.json so the last ones work offline (and a newly chosen
 * currency converts right away with them).
 */

const SOURCE = 'https://api.frankfurter.app/latest?from=USD';
const STALE_MS = 20 * 60 * 60 * 1000;
const CHECK_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 15_000;

export interface FxDeps {
  readonly store: Store;
  /** null: keep nothing on disk (the demo, tests). */
  readonly file?: string | null;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

const fxFile = (): string => path.join(klaudHome(), 'fx.json');

/** Rates from frankfurter's answer ({ base: 'USD', rates: { EUR: 0.92, … } }), checked. */
export function parseRates(body: unknown, at: number): FxRates | undefined {
  const rates = (body as { rates?: unknown })?.rates;
  if (!rates || typeof rates !== 'object') return undefined;
  const out: Record<string, number> = {};
  for (const [code, value] of Object.entries(rates)) {
    if (/^[A-Z]{3}$/.test(code) && typeof value === 'number' && Number.isFinite(value) && value > 0) out[code.toLowerCase()] = value;
  }
  return Object.keys(out).length ? { rates: out, at } : undefined;
}

export class FxService {
  private timer?: NodeJS.Timeout;
  private off?: () => void;
  private fetching = false;

  constructor(private readonly deps: FxDeps) {
    const cached = this.load();
    if (cached) deps.store.dispatch({ type: 'fx_rates', fx: cached });
  }

  private get file(): string | null {
    return this.deps.file === undefined ? fxFile() : this.deps.file;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private load(): FxRates | undefined {
    if (!this.file) return undefined;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { rates?: unknown; at?: unknown };
      return typeof raw.at === 'number' ? parseRates({ rates: Object.fromEntries(Object.entries((raw.rates ?? {}) as Record<string, number>).map(([k, v]) => [k.toUpperCase(), v])) }, raw.at) : undefined;
    } catch {
      return undefined;
    }
  }

  private save(fx: FxRates): void {
    if (!this.file) return;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(fx));
    renameSync(tmp, this.file);
  }

  /** Fetch new rates if some project earns and the ones we have are old (or missing). */
  async refreshIfStale(): Promise<void> {
    const state = this.deps.store.getState();
    if (!Object.keys(state.earnings).length || this.fetching) return;
    if (state.fx && this.now() - state.fx.at < STALE_MS) return;
    this.fetching = true;
    try {
      const res = await (this.deps.fetch ?? fetch)(SOURCE, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } });
      if (!res.ok) return;
      const fx = parseRates(await res.json(), this.now());
      if (!fx) return;
      this.deps.store.dispatch({ type: 'fx_rates', fx });
      this.save(fx);
    } catch {
      // Offline or the service is down: the last rates (if any) keep working.
    } finally {
      this.fetching = false;
    }
  }

  /**
   * Keep the rates as fresh as the earnings: check now, when the first project connects Stripe,
   * whenever a Stripe count starts (the daily refresh, or Refresh Now), when you choose another
   * currency, and every hour. Each check fetches only if the rates are a day old.
   */
  start(): void {
    void this.refreshIfStale();
    let last = this.watched();
    this.off = this.deps.store.subscribe(() => {
      // Most changes are elsewhere in the state: skip them cheaply.
      const state = this.deps.store.getState();
      if (state.earnings === last.earnings && state.prefs.earningsCurrency === last.currency) return;
      const now = this.watched();
      const connected = now.connected && !last.connected;
      const counting = now.counting.some((root) => !last.counting.includes(root));
      const currency = now.currency !== last.currency;
      last = now;
      if (connected || counting || currency) void this.refreshIfStale();
    });
    this.timer = setInterval(() => void this.refreshIfStale(), CHECK_MS);
    this.timer.unref();
  }

  /** What, in the state, may call for fresh rates. */
  private watched(): { earnings: object; connected: boolean; counting: string[]; currency: string | undefined } {
    const state = this.deps.store.getState();
    const entries = Object.entries(state.earnings);
    return { earnings: state.earnings, connected: entries.length > 0, counting: entries.filter(([, e]) => e.refreshing).map(([root]) => root), currency: state.prefs.earningsCurrency };
  }

  stop(): void {
    this.off?.();
    clearInterval(this.timer);
  }
}
