import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { type ClaudeSkill, notOnCodex } from '../../shared/skills.js';

/**
 * The skills and custom commands Claude Code can use in a folder, for the message box's / list
 * (BLG-217): the project's own (.claude/skills, .claude/commands), yours (~/.claude/…), and those
 * of your enabled plugins ("plugin:name"). Each with its description, read from the file's
 * frontmatter (or a command's first line). Read on demand; nothing is kept.
 */

/** Skills listed at most (a big plugin set stays a list you can move through). */
const MAX_SKILLS = 400;

/** A file's frontmatter fields we read (`name`, `description`), and the first line of its body. */
export function frontmatter(text: string): { readonly fields: Readonly<Record<string, string>>; readonly firstLine: string } {
  const fields: Record<string, string> = {};
  let body = text;
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (m) {
    body = text.slice(m[0].length);
    for (const line of m[1]!.split(/\r?\n/)) {
      const kv = /^([\w-]+):\s*(.*)$/.exec(line);
      if (kv) fields[kv[1]!.toLowerCase()] = kv[2]!.trim().replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  const firstLine = body.split(/\r?\n/).map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) ?? '';
  return { fields, firstLine };
}

/** What of a skill doesn't reach Codex, for the / list (see ClaudeSkill.onCodex). */
const codexNote = (fields: Readonly<Record<string, string>>): { onCodex?: string } => {
  const lost = notOnCodex(fields);
  return lost.length ? { onCodex: `Not on Codex: ${lost.join(', ')}` } : {};
};

const short = (text: string): string => (text.length > 160 ? `${text.slice(0, 157).trimEnd()}…` : text);

async function list(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((e) => !e.name.startsWith('.')).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
  } catch {
    return [];
  }
}

async function read(file: string): Promise<string | undefined> {
  try {
    return (await readFile(file, 'utf8')).slice(0, 8192);
  } catch {
    return undefined;
  }
}

/** `<dir>/skills/<name>/SKILL.md` and `<dir>/commands/**\/<name>.md` (commands one folder deep). */
async function scan(dir: string, source: ClaudeSkill['source'], prefix = ''): Promise<ClaudeSkill[]> {
  const out: ClaudeSkill[] = [];
  for (const entry of await list(path.join(dir, 'skills'))) {
    if (!entry.endsWith('/')) continue;
    const text = await read(path.join(dir, 'skills', entry, 'SKILL.md'));
    if (text === undefined) continue;
    const { fields, firstLine } = frontmatter(text);
    out.push({ name: `${prefix}${fields.name || entry.slice(0, -1)}`, description: short(fields.description || firstLine), kind: 'skill', source, ...codexNote(fields) });
  }
  const commands = async (sub: string): Promise<void> => {
    for (const entry of await list(path.join(dir, 'commands', sub))) {
      if (entry.endsWith('/')) {
        if (!sub) await commands(entry);
        continue;
      }
      if (!entry.endsWith('.md')) continue;
      const text = await read(path.join(dir, 'commands', sub, entry));
      if (text === undefined) continue;
      const { fields, firstLine } = frontmatter(text);
      out.push({ name: `${prefix}${entry.slice(0, -3)}`, description: short(fields.description || firstLine), kind: 'command', source, ...(fields['argument-hint'] ? { args: fields['argument-hint'] } : {}), ...codexNote(fields) });
    }
  };
  await commands('');
  return out;
}

/** Your enabled plugins' folders, with their names (installed_plugins.json, minus those settings.json turns off). */
async function plugins(home: string): Promise<Array<{ name: string; dir: string }>> {
  try {
    const installed = JSON.parse((await read(path.join(home, 'plugins', 'installed_plugins.json'))) ?? '{}') as { plugins?: Record<string, Array<{ installPath?: string }>> };
    const settings = JSON.parse((await read(path.join(home, 'settings.json'))) ?? '{}') as { enabledPlugins?: Record<string, boolean> };
    const enabled = settings.enabledPlugins;
    return Object.entries(installed.plugins ?? {})
      .filter(([id]) => !enabled || enabled[id] === true)
      .flatMap(([id, installs]) => {
        const dir = installs.at(-1)?.installPath;
        return dir ? [{ name: id.split('@')[0]!, dir }] : [];
      });
  } catch {
    return [];
  }
}

/** Everything Claude Code can use in `cwd`, the project's first (they win a name clash), then yours, then plugins'. */
export async function listSkills(cwd: string | undefined, home: string): Promise<ClaudeSkill[]> {
  const found = [
    ...(cwd ? await scan(path.join(cwd, '.claude'), 'project') : []),
    ...(await scan(home, 'user')),
    ...(await Promise.all((await plugins(home)).map((p) => scan(p.dir, 'plugin', `${p.name}:`)))).flat(),
  ];
  const seen = new Set<string>();
  return found
    .filter((s) => /^[\w.:-]+$/.test(s.name) && !seen.has(s.name) && Boolean(seen.add(s.name)))
    .slice(0, MAX_SKILLS);
}

/** One skill or command found by name, with its file, frontmatter and body (for a runtime that expands them itself). */
export interface FoundSkill {
  readonly kind: 'skill' | 'command';
  readonly source: ClaudeSkill['source'];
  readonly file: string;
  readonly fields: Readonly<Record<string, string>>;
  /** The text after the frontmatter. */
  readonly body: string;
}

/**
 * `name` as `/name` means it in `cwd` (the project's first, then yours, then a plugin's
 * `plugin:name`), the same order as listSkills. Undefined: no such skill or command.
 */
export async function findSkill(name: string, cwd: string | undefined, home: string): Promise<FoundSkill | undefined> {
  if (!/^[\w.:-]+$/.test(name)) return undefined;
  const [plugin, inPlugin] = name.includes(':') ? (name.split(':', 2) as [string, string]) : [undefined, name];
  const dirs: Array<{ dir: string; source: ClaudeSkill['source'] }> = plugin
    ? (await plugins(home)).filter((p) => p.name === plugin).map((p) => ({ dir: p.dir, source: 'plugin' as const }))
    : [...(cwd ? [{ dir: path.join(cwd, '.claude'), source: 'project' as const }] : []), { dir: home, source: 'user' as const }];
  for (const { dir, source } of dirs) {
    for (const [kind, file] of [
      ['skill', path.join(dir, 'skills', inPlugin, 'SKILL.md')],
      ['command', path.join(dir, 'commands', `${inPlugin}.md`)],
    ] as const) {
      const text = await read(file);
      if (text === undefined) continue;
      const { fields } = frontmatter(text);
      return { kind, source, file, fields, body: text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '') };
    }
  }
  return undefined;
}
