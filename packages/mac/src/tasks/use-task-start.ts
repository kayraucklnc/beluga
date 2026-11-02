import type { Issue } from '@beluga/core/board/model.js';
import type { AgentRef } from '@beluga/protocol.js';
import { agentName } from '@beluga/shared/agent-label.js';
import { useStartWith } from '../components/agent-options.js';
import type { ActionItem } from '../components/SpecMenu.js';
import { useMyAgent } from '../lib/agent-words.js';
import { useApp } from '../lib/beluga.js';
import { useTaskActions } from './use-tasks.js';

/** Who starts a task, and how (see useTaskStart). */
export interface TaskStart {
  /** The agent the main Start uses, in words: "Codex", "your agent". */
  readonly who: string;
  /** Start it in a new worktree with `agent` this once; none: the default. → what act() gave back. */
  readonly start: (agent?: AgentRef) => Promise<unknown>;
  /** Start with ▸ rows for every agent, the default checked; `pick` gets the agent to start with (none: the default). */
  readonly items: (pick: (agent: AgentRef | undefined) => void) => ActionItem[];
}

/**
 * Who starts a task (BLG-506): its own agent, else its plan's, else yours. The main Start uses
 * that one; Start with ▸ another, for this start only (the task's own agent stays as it is).
 */
export function useTaskStart(issue: Issue): TaskStart {
  const { api, act } = useTaskActions();
  const planAgent = useApp((s) => (issue.plan ? s.plans.plans.find((p) => p.id === issue.plan!.id)?.agent : undefined));
  const mine = useMyAgent();
  const startWith = useStartWith();
  const own = issue.agent ?? planAgent;
  const start = (agent?: AgentRef): Promise<unknown> => {
    const who = agent ?? own;
    return act(() => api.start(issue.id, { claude: true, ...(who ? { agent: who } : {}) }));
  };
  // "Your agent" picked over a task (or plan) with its own: yours, by name (none would mean its own again).
  const items = (pick: (agent: AgentRef | undefined) => void): ActionItem[] => startWith(own, (a) => pick(a ?? (own ? mine : undefined)));
  return { who: own ? agentName(own) : 'your agent', start, items };
}
