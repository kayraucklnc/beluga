import { type AgentRef, CLAUDE_AGENT } from '../protocol.js';

/**
 * The agents you can pick as your default (BLG-444), as pop-up entries. Until other runtimes come,
 * it's Claude with each of its models; the value is the model ('' = Claude Code's default).
 */
export function agentChoices(models: ReadonlyArray<{ readonly value: string; readonly label: string }>): Array<{ value: string; label: string }> {
  return [{ value: '', label: 'Claude' }, ...models.filter((m) => m.value).map((m) => ({ value: m.value, label: `Claude · ${m.label}` }))];
}

/** The AgentRef a pop-up value stands for. */
export function agentForChoice(value: string): AgentRef {
  return value ? { ...CLAUDE_AGENT, model: value } : CLAUDE_AGENT;
}

/** The pop-up value for an agent you chose (undefined: Claude). */
export function choiceForAgent(ref: AgentRef | undefined): string {
  return ref?.runtime === 'claude' ? (ref.model ?? '') : '';
}
