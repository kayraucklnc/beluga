/**
 * A skill or custom command Claude Code can use in a conversation's folder (BLG-217): listed in
 * the message box's / menu. `name` is what follows the slash ("review", "supabase:migrate").
 * Browser-safe: types only.
 */
export interface ClaudeSkill {
  readonly name: string;
  readonly description: string;
  /** A skill (skills/<name>/SKILL.md) or a custom command (commands/<name>.md). */
  readonly kind: 'skill' | 'command';
  /** The project's own, yours (~/.claude), or one of your plugins'. */
  readonly source: 'project' | 'user' | 'plugin';
  /** A command's argument hint ("[file] [focus]"). */
  readonly args?: string;
  /** What of it doesn't carry over to Codex ("Not on Codex: its allowed tools"), when something doesn't. */
  readonly onCodex?: string;
}

/** Frontmatter that changes how Claude Code runs a skill or command, with no Codex equivalent (BLG-456). */
export const NOT_ON_CODEX: Readonly<Record<string, string>> = {
  'allowed-tools': 'its allowed tools',
  model: 'its model',
  context: 'its own context',
  agent: 'its agent',
  hooks: 'its hooks',
};

/** A skill's frontmatter fields that don't map to Codex, in words (empty: it all does). */
export const notOnCodex = (fields: Readonly<Record<string, string>>): string[] => Object.keys(fields).flatMap((f) => (NOT_ON_CODEX[f] ? [NOT_ON_CODEX[f]] : []));
