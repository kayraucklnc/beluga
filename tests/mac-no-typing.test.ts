import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * In the Mac app the message box is only for messages. The shared action runners (src/ui) answer
 * some menu options by typing into the terminal UI's box: a /command to finish, or a "type a name,
 * then Return" mode. Every such place is listed here with what the Mac app does instead, so a new
 * one fails this test until it has a native sheet, alert or inline editor.
 */

const ui = (f: string): string => readFileSync(path.join('src/ui', f), 'utf8');
const mac = (f: string): string => readFileSync(path.join('packages/mac/src', f), 'utf8');

interface Site {
  readonly file: string;
  /** The call, as written. */
  readonly code: string;
  /** What triggers it: a menu option id (or id prefix ending in ':'), or a UI action. */
  readonly from: string;
  /** For a /command: the command the Mac routes (lib/native-routes.ts › routeTyped). */
  readonly command?: string;
  /** Mentions are chat text: they stay in the box. */
  readonly chat?: true;
}

const SITES: readonly Site[] = [
  { file: 'ui-actions.ts', code: "typeInto('/project add ~/')", from: 'add_project', command: 'project' },
  { file: 'ui-actions.ts', code: 'typeInto(`/fork ${ws.name}-2`)', from: 'fork', command: 'fork' },
  { file: 'menu-actions.ts', code: "askForName('group', project.id)", from: 'p-newgroup' },
  { file: 'menu-actions.ts', code: "typeInto('/name ')", from: 'set-name', command: 'name' },
  { file: 'menu-actions.ts', code: "typeInto(`@claude:${peer?.name ?? ''} `)", from: 'ask', chat: true },
  { file: 'menu-actions.ts', code: "pending: { kind: 'peer_run'", from: 'person-run' },
  { file: 'menu-actions.ts', code: "typeInto('@claude ')", from: 'ask-self', chat: true },
  { file: 'collab-actions.ts', code: "typeInto('/share ~/')", from: 'sf-type', command: 'share' },
  { file: 'work-actions.ts', code: 'typeInto(`/env ${id.slice(4)}=`)', from: 'env:', command: 'env' },
  { file: 'work-actions.ts', code: "pending: { kind: 'remote'", from: 'rws:' },
  { file: 'work-actions.ts', code: "typeInto('/shell ')", from: 'sh-other', command: 'shell' },
  { file: 'work-actions.ts', code: 'typeInto(`/shell args ${joinArgs(prefs.shellArgs)}`)', from: 'sh-args', command: 'shell' },
  { file: 'work-actions.ts', code: "typeInto('/env ')", from: 'env-add', command: 'env' },
  { file: 'work-actions.ts', code: "typeInto('/template save ')", from: 'tpl-save', command: 'template' },
  { file: 'work-actions.ts', code: "typeInto('/pr ')", from: 'pr-create-note', command: 'pr' },
  { file: 'work-actions.ts', code: 'pending: { kind, projectId }', from: 's-setup' },
];

const routes = mac('lib/native-routes.ts');
const routeTyped = routes.slice(routes.indexOf('export function routeTyped'), routes.indexOf('export function routeOption'));
const routeOption = routes.slice(routes.indexOf('export function routeOption'));
const actions = mac('lib/actions.ts');

describe('the Mac message box is only for messages', () => {
  it('lists every place the shared runners type into the box or ask for a name', () => {
    const files = readdirSync('src/ui').filter((f) => f.endsWith('.ts'));
    const found = files.flatMap((f) => {
      const text = ui(f);
      return [...text.matchAll(/typeInto\(|askForName\(|pending: \{/g)].map((m) => ({ f, line: text.slice(0, m.index).split('\n').length, text: text.slice(m.index, text.indexOf('\n', m.index)) }));
    });
    // Definitions and the terminal's own wiring aren't call sites.
    const calls = found.filter((x) => !/^(typeInto|askForName)\((buffer|kind|b|k|text)[:,)]/.test(x.text));
    expect(calls.map((c) => `${c.f}:${c.text.trim()}`).filter((c) => !SITES.some((s) => c.startsWith(`${s.file}:`) && c.includes(s.code)))).toEqual([]);
    for (const s of SITES) expect(ui(s.file), `${s.file} no longer has ${s.code}`).toContain(s.code);
  });

  it('routes every /command they type to a sheet or settings pane', () => {
    for (const s of SITES.filter((x) => x.command)) expect(routeTyped, `/${s.command}`).toContain(`case '${s.command}':`);
  });

  it('opens native UI for the options that would type or ask, before the shared runner', () => {
    const options = SITES.filter((s) => !s.chat && s.from.includes('-') && s.from !== 'p-newgroup');
    for (const s of options) {
      const handled = s.from.endsWith(':') ? routeOption.includes(`id.startsWith('${s.from}')`) : routeOption.includes(`case '${s.from}':`);
      expect(handled, s.from).toBe(true);
    }
    // Actions the Mac does its own way before the shared runner.
    expect(actions).toContain("action.type === 'add_project'");
    expect(actions).toContain("action.type === 'ws' && action.action === 'fork'");
  });

  it('refuses any /command nobody routed, and names a group in the sidebar, not the box', () => {
    expect(actions).toMatch(/if \(buffer\.startsWith\('\/'\)\) \{[\s\S]*?return;\n\s*\}/);
    const ask = actions.slice(actions.indexOf('askForName: (kind, projectId) =>'), actions.indexOf('openFolder:'));
    expect(ask).toContain('newGroupFor(projectId)');
    expect(ask).not.toMatch(/pending|buffer|focus-composer/);
  });

  it('never puts the box in a "type something, then Return" mode itself', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []));
    const offenders = walk('packages/mac/src').filter((f) => /pending: \{ kind|buffer: ['`]\//.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
