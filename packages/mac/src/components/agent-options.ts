import { useMemo } from 'react';
import { agentChoices } from '@beluga/ui/agent-choice.js';
import { runtimeMark } from '@beluga/shared/agent-marks.js';
import { agentName } from '@beluga/shared/agent-label.js';
import { useApp } from '../lib/beluga.js';
import { useMyAgent } from '../lib/agent-words.js';
import type { SelectEntry, SelectOption } from './select-parts.js';

/** The pop-up value for "your agent" (whatever your default is when the work starts). */
export const YOUR_AGENT = '';

/**
 * Who does a piece of work (BLG-497), as pop-up entries: "Your agent (Claude)" first (value '',
 * following your default), then every agent and model you can pick, a section per runtime, each
 * with its runtime's mark beside the name. One not set up here stays greyed, saying why. Values
 * are agentChoices' `runtime:model` (agentForChoice turns one into an AgentRef).
 */
export function useAgentEntries(): SelectEntry<string>[] {
  const runtimes = useApp((s) => s.runtimes);
  const models = useApp((s) => s.models);
  const mine = useMyAgent();
  return useMemo(() => {
    const options = agentChoices(runtimes, models);
    const groups = [...new Set(options.map((o) => o.group))];
    const yours: SelectOption<string> = { value: YOUR_AGENT, label: `Your agent (${agentName(mine)})`, icon: runtimeMark(mine.runtime), description: 'Whatever your default agent is when the work starts' };
    return [
      yours,
      ...groups.map((group) => ({
        section: group,
        options: options
          .filter((o) => o.group === group)
          .map((o): SelectOption<string> => ({ value: o.value, label: o.label, icon: o.mark, ...(o.disabled ? { disabled: true } : {}), ...(o.why ? { description: o.why } : {}) })),
      })),
    ];
  }, [runtimes, models, mine]);
}
