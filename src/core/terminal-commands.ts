import { envKeyProblem, parseEnvText } from '../shared/env-vars.js';
import { joinArgs, splitArgs } from '../shared/shells.js';
import type { Session } from './session.js';

const USAGE = 'Usage: /env KEY=value (KEY= removes it). Start with "project" to set it for this project only';

/**
 * `/env`: list your variables' names; `/env KEY=value` sets one of yours, `/env KEY=` removes
 * it; `/env project KEY=value` does the same for the project of the workspace you're in.
 */
export function runEnvCommand(session: Session, args: readonly string[], channel: string): void {
  const state = session.store.getState();
  const forProject = args[0] === 'project';
  const text = (forProject ? args.slice(1) : args).join(' ').trim();
  const wsId = channel.startsWith('ws:') ? channel.slice(3) : undefined;
  const project = wsId ? state.projects.find((p) => p.root && p.workspaces.some((w) => w.id === wsId)) : undefined;
  if (forProject && !project) return session.toast('Open a workspace of the project first, then /env project KEY=value', 'warn');
  if (!text) {
    const mine = state.envKeys.global;
    const theirs = project ? (state.envKeys.projects[project.root]?.keys ?? []) : [];
    const list = [`Yours: ${mine.length ? mine.join(', ') : 'none'}`, ...(project ? [`${project.name}: ${theirs.length ? theirs.join(', ') : 'none'}`] : [])].join(' · ');
    return session.toast(`${list}. ${USAGE}`);
  }
  const eq = text.indexOf('=');
  const key = eq > 0 ? text.slice(0, eq).trim().replace(/^export\s+/, '') : '';
  const problem = key ? envKeyProblem(key) : USAGE;
  if (problem) return session.toast(problem, 'warn');
  const value = parseEnvText(`${key}=${text.slice(eq + 1)}`).vars[0]?.value ?? '';
  try {
    session.env.setOne(forProject ? project?.id : undefined, key, value === '' ? undefined : value);
    const where = forProject ? ` for ${project?.name}` : '';
    session.toast(value === '' ? `${key} removed${where}` : `${key} set${where}. New shells and agent runs get it`, 'success');
  } catch (err) {
    session.toast(err instanceof Error ? err.message : String(err), 'error');
  }
}

/**
 * `/shell`: what the terminal runs. `/shell fish` or `/shell /opt/homebrew/bin/fish` picks one,
 * `/shell default` goes back to your login shell, `/shell login on|off` and `/shell args …`
 * change how it starts. New shells use it.
 */
export function runShellCommand(session: Session, args: readonly string[]): void {
  const state = session.store.getState();
  const p = state.prefs;
  const [first, ...rest] = args;
  if (!first) {
    const how = [p.shellLogin ? 'login shell' : 'not a login shell', ...(p.shellArgs.length ? [joinArgs(p.shellArgs)] : [])].join(', ');
    const shell = p.shell ?? state.shellChoices.find((c) => c.isDefault)?.path ?? 'your login shell';
    return session.toast(`Terminal shell: ${shell} (${how}). /shell <path or name>, /shell login on|off, /shell args …`);
  }
  if (first === 'default') {
    session.setPrefs({ shell: undefined });
    return session.toast('New shells use your login shell', 'success');
  }
  if (first === 'login') {
    const on = rest[0] !== 'off';
    session.setPrefs({ shellLogin: on });
    return session.toast(on ? 'New shells start as login shells' : "New shells don't read your login profile", 'success');
  }
  if (first === 'args') {
    const extra = splitArgs(rest.join(' '));
    session.setPrefs({ shellArgs: extra.slice(0, 20) });
    return session.toast(extra.length ? `New shells start with ${joinArgs(extra)}` : 'No extra arguments', 'success');
  }
  // A name ("fish") picks the installed one; anything else is taken as a path.
  const wanted = args.join(' ');
  const match = state.shellChoices.find((c) => c.name.toLowerCase() === wanted.toLowerCase() || c.path.endsWith(`/${wanted}`));
  const shell = match?.path ?? wanted;
  if (!shell.startsWith('/')) return session.toast(`No shell called ${wanted} here. Give its full path, e.g. /opt/homebrew/bin/${wanted}`, 'warn');
  session.setPrefs({ shell });
  session.toast(`New shells use ${shell}`, 'success');
}
