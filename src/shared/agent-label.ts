import { type AgentRef, CLAUDE_AGENT } from '../protocol.js';

/**
 * The words screens and messages say for an agent (BLG-435): "your Claude", "Kayra's Codex",
 * "bob's Claude (Opus)". Nothing user-facing writes "Claude" itself: it says the agent's label,
 * so a Codex or a local model is named as what it is. Missing ref: Claude (an older Mac's).
 * Browser-safe: the Mac app and the phone import it.
 */

export interface AgentLabelOptions {
  /** Add the model: "bob's Claude (Opus)". */
  readonly model?: boolean;
  /** Start of a sentence: "Your Claude". */
  readonly capital?: boolean;
}

/** Model ids as people say them: "opus" → "Opus", "gpt-5" → "GPT-5", "claude-sonnet-4-5" → "Sonnet 4.5". */
export function modelName(model: string): string {
  const m = model.trim().replace(/^claude-/i, '');
  if (/^gpt/i.test(m)) return m.replace(/^gpt/i, 'GPT');
  // A dated id's date ("-20250929") isn't said.
  const [first = '', ...rest] = m.split('-').filter((p) => !/^\d{8}$/.test(p));
  const version = rest.filter((p) => /^\d+$/.test(p)).join('.');
  const words = rest.filter((p) => !/^\d+$/.test(p));
  return [first.charAt(0).toUpperCase() + first.slice(1), ...words, version].filter(Boolean).join(' ');
}

/** Just the agent: "Claude", or "Codex (GPT-5)" with `model`. */
export function agentName(ref: AgentRef | undefined, opts: Pick<AgentLabelOptions, 'model'> = {}): string {
  const r = ref ?? CLAUDE_AGENT;
  return opts.model && r.model ? `${r.label} (${modelName(r.model)})` : r.label;
}

/**
 * Whose agent it is, as one phrase. `self`: it's yours ("your Codex"); else `owner`'s
 * ("mia's Codex"); no owner: just its name.
 */
export function agentLabel(ref: AgentRef | undefined, owner: string | undefined, self: boolean, opts: AgentLabelOptions = {}): string {
  const name = agentName(ref, opts);
  const phrase = self ? `your ${name}` : owner ? `${owner}'s ${name}` : name;
  return opts.capital ? phrase.charAt(0).toUpperCase() + phrase.slice(1) : phrase;
}
