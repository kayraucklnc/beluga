import type { PeerInfo } from '../protocol.js';
import type { Settings, TrustLevel } from './settings.js';
import { type Store, peerName } from './store.js';
import { TRUST_INFO } from './trust.js';

export interface PeopleDeps {
  readonly store: Store;
  readonly selfId: () => string;
  /** Trust levels chosen in earlier sessions, by key-derived peer id. */
  readonly saved: Settings['people'];
  readonly save: (people: Settings['people']) => void;
  /**
   * What's saved right now. Another Beluga with your identity (in another room, say)
   * shares the file and may have chosen since this one started: each change starts from it.
   */
  readonly load?: () => Settings['people'];
  readonly toast: (text: string, level?: 'info' | 'success' | 'warn' | 'error') => void;
}

/**
 * Who you trust and how much. Levels are remembered per person (their id comes from their
 * own signing key, so nobody else can take it) and come back when they rejoin. Someone new
 * gets a one-click "how much do you trust them?" card.
 */
export class People {
  private saved: Settings['people'];

  constructor(private readonly deps: PeopleDeps) {
    this.saved = { ...deps.saved };
    deps.store.dispatch({ type: 'remembered', people: this.saved });
  }

  /** Pick up choices made by another Beluga with your identity since. */
  private refresh(): void {
    const disk = this.deps.load?.();
    if (!disk) return;
    this.saved = { ...disk };
    this.deps.store.dispatch({ type: 'remembered', people: this.saved });
  }

  /** Change one person's entry on top of what's saved now (never the whole list from memory). */
  private persist(change: (people: Settings['people']) => Settings['people']): void {
    this.refresh();
    this.saved = change(this.saved);
    this.deps.save(this.saved);
    this.deps.store.dispatch({ type: 'remembered', people: this.saved });
  }

  /** Saved choices, for Settings → People. */
  get remembered(): Settings['people'] {
    return this.saved;
  }

  onPeers(before: readonly PeerInfo[], after: readonly PeerInfo[]): void {
    const self = this.deps.selfId();
    const known = new Set(before.map((p) => p.peerId));
    if (after.some((p) => p.peerId !== self && !known.has(p.peerId) && !p.guest)) this.refresh();
    for (const p of after) {
      // Guests came with a link: what they may do was decided when you let them in.
      if (p.peerId === self || known.has(p.peerId) || p.guest) continue;
      const saved = this.saved[p.peerId];
      if (saved) {
        this.deps.store.dispatch({ type: 'trust_level', peerId: p.peerId, level: saved.trust });
        continue;
      }
      this.deps.store.dispatch({ type: 'trust_prompt', peerId: p.peerId, show: true });
    }
  }

  /** Pick how much you trust someone; remembered for next time. */
  setTrust(peerId: string, level: TrustLevel, quiet = false): void {
    const state = this.deps.store.getState();
    if (peerId === this.deps.selfId()) return;
    this.deps.store.dispatch({ type: 'trust_level', peerId, level });
    this.deps.store.dispatch({ type: 'trust_prompt', peerId, show: false });
    const name = peerName(state, peerId);
    this.persist((people) => ({ ...people, [peerId]: { name: name.slice(0, 32), trust: level } }));
    if (!quiet) this.deps.toast(`${name}: ${TRUST_INFO[level].label}. ${TRUST_INFO[level].detail}`, 'success');
  }

  /** Forget a saved choice (they fall back to your default). */
  forget(peerId: string): void {
    this.persist(({ [peerId]: _gone, ...rest }) => rest);
    this.deps.store.dispatch({ type: 'trust_level', peerId });
  }

  dismissPrompt(peerId: string): void {
    this.deps.store.dispatch({ type: 'trust_prompt', peerId, show: false });
  }
}
