import { KNOWN_RUNTIMES, type RuntimeChoice } from '../../../src/shared/agent-runtimes';
import { type AgentOption, agentChoices, agentForChoice } from '../../../src/ui/agent-choice';
import type { AgentPickerView, HomeView } from './link/protocol';
import { store } from './store';

/**
 * The agents a new task, a new plan (BLG-498) can be given, as the Mac's pop-ups list them
 * (src/ui/agent-choice.ts): every runtime with its models. The phone has no list of its own outside
 * a conversation, so it takes the newest one the Mac sent (a conversation's, a task's or a plan's
 * agent picker); before any came, the agents your Mac runs (Home's usage), each with its default
 * model. "Your agent" (none) is always first, and the default.
 */

export interface AgentPicks {
  readonly options: readonly AgentOption[];
  readonly runtimes: readonly RuntimeChoice[];
  /** Your default agent's runtime, when known (its mark for "Your agent"). */
  readonly defaultRuntime?: string;
}

/** The Mac takes `agent` on companion.addTask and plans.create from SINCE.workAgents (BLG-498). */
export function agentPicksSupported(): boolean {
  return store.getState().proto ? store.supports('workAgents') : store.getState().mode === 'demo';
}

const isPicker = (p: unknown): p is AgentPickerView => Boolean(p && typeof p === 'object' && Array.isArray((p as AgentPickerView).groups) && (p as AgentPickerView).groups.length);

/** The newest agent picker any kept view carries (ConvView.agent, PlanView / TaskPageView.agents). */
function newestPicker(): AgentPickerView | undefined {
  for (const [, v] of store.cachedViews()) {
    const d = v.data as { agent?: unknown; agents?: unknown } | undefined;
    if (isPicker(d?.agents)) return d.agents;
    if (isPicker(d?.agent)) return d.agent;
  }
  return undefined;
}

export function agentPicks(): AgentPicks {
  const picker = newestPicker();
  if (picker) {
    const runtimes: RuntimeChoice[] = picker.groups.map((g) => ({
      id: g.runtime,
      label: g.label,
      available: g.available,
      ...(g.why ? { why: g.why } : {}),
      models: g.models.map((m) => ({ value: m.value, label: m.label, description: m.description })),
    }));
    const claude = runtimes.find((r) => r.id === 'claude')?.models ?? [];
    const def = picker.groups.find((g) => g.isDefault)?.runtime;
    return { options: agentChoices(runtimes, claude), runtimes, ...(def ? { defaultRuntime: def } : {}) };
  }
  // No picker yet: the agents your Mac runs, by their runtimes (their own default models).
  const usage = store.view<HomeView>('home')?.data.usage ?? [];
  const runtimes: RuntimeChoice[] = KNOWN_RUNTIMES.filter((k) => usage.some((u) => u.runtime === k.id)).map((k) => {
    const u = usage.find((x) => x.runtime === k.id)!;
    return { id: k.id, label: k.label, available: u.signedIn !== false, ...(u.signedIn === false ? { why: `${k.label} isn't signed in on your Mac` } : {}), models: [] };
  });
  const def = usage.find((u) => u.isDefault)?.runtime;
  return { options: runtimes.length ? agentChoices(runtimes, []) : [], runtimes, ...(def ? { defaultRuntime: def } : {}) };
}

export { agentForChoice };
