/**
 * A skill or custom command Claude Code can use in a conversation's folder (BLG-217): listed in
 * the message box's / menu. `name` is what follows the slash ("review", "supabase:migrate").
 * Browser-safe: no imports.
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

/** Claude Code's own commands (its terminal's, not skills): no runtime in Beluga runs them as typed. */
export const CLAUDE_BUILT_INS: ReadonlySet<string> = new Set(['add-dir', 'agents', 'bug', 'clear', 'compact', 'config', 'context', 'cost', 'doctor', 'export', 'help', 'hooks', 'ide', 'init', 'install-github-app', 'login', 'logout', 'mcp', 'memory', 'model', 'output-style', 'permissions', 'plugin', 'pr-comments', 'privacy-settings', 'release-notes', 'resume', 'review', 'rewind', 'security-review', 'status', 'statusline', 'terminal-setup', 'todos', 'upgrade', 'usage', 'vim']);

const SETTINGS = 'Beluga’s own settings are in Settings (/settings).';

/**
 * What Beluga offers instead of a Claude Code built-in typed in a conversation, in a sentence
 * (BLG-505); undefined: not one of them, or Beluga has a command of that name, or it's a prompt
 * Claude Code ships (review, security-review, pr-comments) that still means something as text.
 */
const INSTEAD: Readonly<Record<string, string>> = {
  context: 'The context meter beside the message box shows how full this conversation is; /compact shrinks it.',
  cost: '/usage shows what your agent used; the context meter beside the message box shows this conversation’s tokens.',
  init: 'Ask your agent to “write a CLAUDE.md for this project” instead.',
  rewind: 'To go back, point at one of your messages and pick Edit: rewind to there, or fork from there.',
  memory: 'Your agent reads the project’s CLAUDE.md: ask it to change it, or edit the file yourself.',
  resume: 'Your conversations stay in the sidebar: open one to carry on.',
  export: '/copy copies your agent’s last answer.',
  'add-dir': 'Add the folder as a project (/project add <path>) to work in it.',
  agents: 'Sub-agents show in the conversation as they work.',
  todos: 'Your agent’s to-do list shows in the conversation as it works.',
  mcp: 'The plug in the message box shows your MCP servers and signs you in to them.',
  login: 'To sign in to Claude Code, run claude in the Terminal tab.',
  logout: 'To sign out of Claude Code, run claude in the Terminal tab.',
  config: SETTINGS,
  status: SETTINGS,
  doctor: SETTINGS,
  permissions: SETTINGS,
  hooks: SETTINGS,
  statusline: SETTINGS,
  'output-style': SETTINGS,
  'privacy-settings': SETTINGS,
  'terminal-setup': SETTINGS,
  vim: SETTINGS,
  ide: SETTINGS,
  plugin: SETTINGS,
  upgrade: 'Beluga keeps Claude Code up to date itself.',
  'release-notes': 'Beluga keeps Claude Code up to date itself.',
  'install-github-app': SETTINGS,
  bug: SETTINGS,
};

export function builtInInstead(name: string): string | undefined {
  const instead = INSTEAD[name];
  return instead && `/${name} is one of Claude Code’s own commands, not something Beluga runs. ${instead} (Type //${name} to send it as a message.)`;
}
