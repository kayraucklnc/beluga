import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Options, SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk';
import { fillArguments, findSkill } from '../../../core/claude-code/skills.js';

/**
 * A project's skills and custom commands on your own runs (BLG-505). Your own runs load your user
 * settings, so yours (~/.claude) and your enabled plugins come in natively (ownerSettings in
 * runner.ts, BLG-521); a project's .claude/ settings never load (a friend with :rw could plant
 * permissions or hooks there), and that also hid the project's skills and commands. They come back
 * as a plugin: a folder of Beluga's that links only the project's skills and commands, under a
 * manifest without hooks or servers (a plugin's own hooks/hooks.json would run: confirmed live).
 * Custom commands Claude Code then names "project:fruit", so Beluga fills them in itself before
 * sending (expandCommand), the same as on Codex. `shadowPlugin` also serves a plugin folder of yours
 * minus its hooks and servers, should one ever need loading this way.
 */

/** What a .claude folder (the project's, yours) brings: its skills and commands, nothing else. */
const FROM_CLAUDE_DIR = new Set(['skills', 'commands']);
const MANIFEST_LEFT_OFF = ['hooks', 'mcpServers', 'lspServers'];
/** A folder not used for this long goes when another is made. */
const STALE_MS = 30 * 24 * 60 * 60_000;

function manifestOf(src: string, name: string): Record<string, unknown> {
  let manifest: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(src, '.claude-plugin', 'plugin.json'), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) manifest = { ...(parsed as Record<string, unknown>) };
  } catch {
    // None, or unreadable: its name is all it needs.
  }
  for (const key of MANIFEST_LEFT_OFF) delete manifest[key];
  return { ...manifest, name };
}

function prune(root: string, keep: string): void {
  try {
    for (const entry of readdirSync(root)) {
      const dir = path.join(root, entry);
      if (dir !== keep && Date.now() - statSync(dir).mtimeMs > STALE_MS) rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // Tidying only.
  }
}

/**
 * A plugin folder under `root` that links `src`'s entries `keep` allows, with its manifest minus
 * hooks and servers, named `name`. The same sources make the same folder (reused, never rebuilt
 * under a run that reads it). Undefined: nothing to bring, or it couldn't be made.
 */
export function shadowPlugin(src: string, name: string, keep: (entry: string) => boolean, root: string): string | undefined {
  try {
    const entries = readdirSync(src).filter(keep).sort();
    if (!entries.length) return undefined;
    const manifest = manifestOf(src, name);
    const key = createHash('sha256').update(JSON.stringify({ src: path.resolve(src), entries, manifest })).digest('hex').slice(0, 16);
    // Absolute: Claude Code reads a plugin path from its own folder (the run's), not ours.
    const dir = path.resolve(root, `${name.replace(/[^\w.-]/g, '_')}-${key}`);
    if (existsSync(dir)) {
      const now = new Date();
      utimesSync(dir, now, now);
      return dir;
    }
    const tmp = `${dir}.tmp-${randomUUID()}`;
    mkdirSync(path.join(tmp, '.claude-plugin'), { recursive: true });
    writeFileSync(path.join(tmp, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest, null, 2));
    for (const entry of entries) symlinkSync(path.join(path.resolve(src), entry), path.join(tmp, entry));
    try {
      renameSync(tmp, dir);
    } catch {
      // Another run made it meanwhile: theirs is the same.
      rmSync(tmp, { recursive: true, force: true });
    }
    prune(root, dir);
    return existsSync(dir) ? dir : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The plugins option of an own run in `cwd`: the project's skills and commands, without hooks or MCP
 * (yours and your plugins' load with your user settings). Folders go under `root`.
 */
export async function skillPlugins(cwd: string, home: string, root: string): Promise<SdkPluginConfig[]> {
  const project = path.resolve(cwd, '.claude');
  // Your own folder as the project (a run in ~): it already loads as your user settings.
  if (path.resolve(home) === project) return [];
  const dir = shadowPlugin(project, 'project', (entry) => FROM_CLAUDE_DIR.has(entry), root);
  return dir ? [{ type: 'local' as const, path: dir, skipMcpDiscovery: true }] : [];
}

/** What a run's options add for skills: on your own runs every skill found; a friend's or a guest's get none. */
export async function skillOptions(own: boolean, cwd: string, home: string, root: string): Promise<Pick<Options, 'plugins' | 'skills'>> {
  if (!own) return {};
  const found = await skillPlugins(cwd, home, root);
  return found.length ? { plugins: found, skills: 'all' } : {};
}

/** A prompt that might name a skill or command: `/name args` (or the / menu's `//name`). */
const SLASH = /^\/\/?([\w.:-]+)(?:\s+([\s\S]*))?$/;

export const mayBeCommand = (prompt: string): boolean => SLASH.test(prompt.trim());

/**
 * `/name args` where name is one of your custom commands: its text, arguments filled in, as Claude
 * Code would have sent it. A skill stays `/name args` (Claude runs it with its Skill tool); anything
 * else is the prompt as it was. Never fails: a command that can't be read goes in as typed.
 */
export async function expandCommand(prompt: string, cwd: string, home: string): Promise<string> {
  const m = SLASH.exec(prompt.trim());
  if (!m) return prompt;
  const name = m[1]!;
  const args = (m[2] ?? '').trim();
  const found = await findSkill(name, cwd, home).catch(() => undefined);
  if (found?.kind === 'command') return fillArguments(found.body, args, found.source === 'plugin' ? found.dir : undefined);
  if (found?.kind === 'skill') return `/${name}${args ? ` ${args}` : ''}`;
  return prompt;
}
