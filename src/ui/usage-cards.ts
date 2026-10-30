import { usagesOf } from '../agent/usage.js';
import { type AgentRef, CLAUDE_AGENT, type PeerInfo, type Profile, type ProviderUsage } from '../protocol.js';

/** A plan window ready to draw: "5-hour", "Weekly", or the provider's own name for it. */
export interface CardWindow {
  readonly label: string;
  /** Two or three letters for tight rows ("5h", "wk"). */
  readonly short: string;
  readonly pct: number;
  readonly resetsAt?: number;
}

/**
 * One provider on the Usage tab (Mac and phone): quota windows where its plan has them, tokens and
 * speed where it doesn't (a local model), or nothing yet until its first run.
 */
export interface ProviderCard {
  /** Its runtime: one card per provider. */
  readonly key: string;
  readonly agent: AgentRef;
  readonly shape: 'quota' | 'tokens' | 'empty';
  readonly windows: readonly CardWindow[];
  readonly plan?: string;
  readonly tokens?: { readonly input: number; readonly output: number };
  readonly tokensPerSec?: number;
  readonly signedIn: boolean;
  /** The agent that answers when nobody names one (the make-default chip's state). */
  readonly isDefault: boolean;
  readonly updatedAt?: number;
}

/** A provider's quota windows in order: 5-hour, weekly, then its own. */
export function windowsOf(u: Pick<ProviderUsage, 'fiveHour' | 'week' | 'windows'> | undefined): CardWindow[] {
  if (!u) return [];
  const out: CardWindow[] = [];
  if (u.fiveHour) out.push({ label: '5-hour', short: '5h', ...u.fiveHour });
  if (u.week) out.push({ label: 'Weekly', short: 'wk', ...u.week });
  for (const w of u.windows ?? []) out.push({ label: w.label, short: w.label.slice(0, 3).toLowerCase(), pct: w.pct, ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}) });
  return out;
}

function cardOf(agent: AgentRef, u: ProviderUsage | undefined, isDefault: boolean): ProviderCard {
  const windows = windowsOf(u);
  const shape = windows.length ? 'quota' : u?.tokens || u?.tokensPerSec !== undefined ? 'tokens' : 'empty';
  return {
    key: agent.runtime,
    agent: u?.agent ?? agent,
    shape,
    windows,
    ...(u?.plan ? { plan: u.plan } : {}),
    ...(u?.tokens ? { tokens: u.tokens } : {}),
    ...(u?.tokensPerSec !== undefined ? { tokensPerSec: u.tokensPerSec } : {}),
    signedIn: u?.signedIn !== false,
    isDefault,
    ...(u ? { updatedAt: u.updatedAt } : {}),
  };
}

/**
 * Your providers as cards: Claude always, then every other one you run or that reported usage, in a
 * stable order (tapping make-default never moves them). `defaultAgent` is your setting's.
 */
export function providerCards(self: Pick<Profile, 'usage' | 'usages' | 'agents'> | undefined, defaultAgent: AgentRef | undefined): ProviderCard[] {
  const usages = usagesOf(self);
  const agents = new Map<string, AgentRef>([[CLAUDE_AGENT.runtime, CLAUDE_AGENT]]);
  for (const a of self?.agents ?? []) if (!agents.has(a.runtime)) agents.set(a.runtime, a);
  for (const u of usages) if (!agents.has(u.agent.runtime)) agents.set(u.agent.runtime, u.agent);
  const def = (defaultAgent ?? CLAUDE_AGENT).runtime;
  return [...agents.values()].map((a) => cardOf(a, usages.find((u) => u.agent.runtime === a.runtime), a.runtime === def));
}

/** One friend's provider with quota windows: whose agent has room left. */
export interface FriendRoom {
  readonly peerId: string;
  readonly name: string;
  readonly agent: AgentRef;
  readonly windows: readonly CardWindow[];
  /** Percent left in its tightest window. */
  readonly left: number;
  /** It's the agent that answers when you ask them without naming one. */
  readonly isDefault: boolean;
}

/** Friends' providers that share quota windows, their default agent first, then by name. */
export function friendRooms(peers: readonly PeerInfo[], selfId: string | undefined): FriendRoom[] {
  return peers
    .filter((p) => p.peerId !== selfId)
    .flatMap((p) => {
      const def = (p.defaultAgent ?? p.agents?.[0] ?? CLAUDE_AGENT).runtime;
      return usagesOf(p)
        .map((u) => ({ peerId: p.peerId, name: p.name, agent: u.agent, windows: windowsOf(u), isDefault: u.agent.runtime === def }))
        .filter((r) => r.windows.length)
        .map((r) => ({ ...r, left: 100 - Math.max(...r.windows.map((w) => w.pct)) }))
        .sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
    });
}

/** "1.2M", "84k", "512" tokens. */
export function shortTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}
