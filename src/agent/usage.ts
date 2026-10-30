import { CLAUDE_AGENT, type AgentRef, type Profile, type ProviderUsage, type Usage } from '../protocol.js';

/** What a run or a refresh learned about one provider's usage (any part of it). */
export type UsageUpdate = Partial<Omit<ProviderUsage, 'agent' | 'updatedAt'>>;

/** Older Macs only knew Claude; at most this many providers are shared. */
const MAX_PROVIDERS = 8;

/**
 * Every provider's usage on a profile. An older Mac sends only `usage`, which was always Claude's;
 * a newer one sends `usages` (and keeps `usage` as Claude's for the older Macs).
 */
export function usagesOf(p: Pick<Profile, 'usage' | 'usages'> | undefined): readonly ProviderUsage[] {
  if (!p) return [];
  if (p.usages?.length) return p.usages;
  return p.usage ? [{ ...p.usage, agent: CLAUDE_AGENT }] : [];
}

/** One provider's usage on a profile (by runtime: one card per provider). */
export function usageFor(p: Pick<Profile, 'usage' | 'usages'> | undefined, runtime: string): ProviderUsage | undefined {
  return usagesOf(p).find((u) => u.agent.runtime === runtime);
}

/** The plain Usage an older Mac reads, from a provider's usage. */
function legacyOf(u: ProviderUsage): Usage {
  return { ...(u.plan ? { plan: u.plan } : {}), ...(u.fiveHour ? { fiveHour: u.fiveHour } : {}), ...(u.week ? { week: u.week } : {}), updatedAt: u.updatedAt };
}

/**
 * The profile patch for an update to one provider's usage: its entry in `usages` merged (or added),
 * and `usage` kept as Claude's so older Macs still read it.
 */
export function withUsage(p: Pick<Profile, 'usage' | 'usages'>, agent: AgentRef, update: UsageUpdate, now = Date.now()): Pick<Profile, 'usage' | 'usages'> {
  const list = usagesOf(p);
  const prev = list.find((u) => u.agent.runtime === agent.runtime);
  const next: ProviderUsage = { ...prev, ...update, agent: { ...prev?.agent, ...agent }, updatedAt: now };
  const usages = prev ? list.map((u) => (u === prev ? next : u)) : [...list, next].slice(-MAX_PROVIDERS);
  const claude = usages.find((u) => u.agent.runtime === CLAUDE_AGENT.runtime);
  return { usages, ...(claude ? { usage: legacyOf(claude) } : p.usage ? { usage: p.usage } : {}) };
}
