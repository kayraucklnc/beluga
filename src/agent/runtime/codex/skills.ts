import { fillArguments, findSkill } from '../../../core/claude-code/skills.js';
import { CLAUDE_BUILT_INS, notOnCodex } from '../../../shared/skills.js';

export { fillArguments };

/**
 * Claude Code's skills and custom commands on Codex (BLG-456). A message starting `/name` means
 * one of them on Claude, which expands it itself; Codex doesn't know them, so Beluga maps what maps:
 * - a skill (skills/<name>/SKILL.md) goes in as Codex's own skill input (Codex reads the file);
 * - a custom command (commands/<name>.md) becomes the prompt, $ARGUMENTS filled in;
 * - what has no Codex equivalent (Claude Code's built-in commands, a skill's allowed-tools, model,
 *   forked context, agent or hooks) is said in a "not on Codex" note, never dropped silently.
 * Capability `skills: 'mapped'` tells the screens so.
 */

export interface MappedPrompt {
  /** The message as Codex gets it. */
  readonly prompt: string;
  /** A skill to give Codex with it (UserInput `skill`). */
  readonly skill?: { readonly name: string; readonly path: string };
  /** What didn't map, in words, for the chat. */
  readonly notes: readonly string[];
}

export async function mapSlash(prompt: string, cwd: string, home: string): Promise<MappedPrompt> {
  // "//name": the / menu's way of saying a skill that shares a Beluga command's name.
  const m = /^\/\/?([\w.:-]+)(?:\s+([\s\S]*))?$/.exec(prompt.trim());
  if (!m) return { prompt, notes: [] };
  const name = m[1]!;
  const args = (m[2] ?? '').trim();
  const found = await findSkill(name, cwd, home);
  if (!found) {
    if (CLAUDE_BUILT_INS.has(name)) return { prompt, notes: [`/${name} is one of Claude Code's own commands: not on Codex, so it went in as plain text.`] };
    return { prompt, notes: [] };
  }
  const unmapped = notOnCodex(found.fields);
  const notes = unmapped.length ? [`/${name} runs on Codex without ${unmapped.join(', ')} (not on Codex).`] : [];
  if (found.kind === 'skill') return { prompt: args ? `Use the ${name} skill: ${args}` : `Use the ${name} skill.`, skill: { name, path: found.file }, notes };
  return { prompt: fillArguments(found.body, args, found.source === 'plugin' ? found.dir : undefined), notes };
}
