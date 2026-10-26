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
}
