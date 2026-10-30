import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLAUDE_CAPABILITIES } from '../src/agent/runtime/claude/index.js';
import { CODEX_CAPABILITIES } from '../src/agent/runtime/codex/index.js';
import { COMMANDS } from '../src/core/commands.js';
import { METHODS } from '../src/ipc/api.js';
import { RUNTIME_FALLBACKS } from '../src/shared/runtime-fallbacks.js';

/**
 * Every way into klaud is listed in docs/parity.md with where each client shows it, so a feature
 * can't land in one client and be forgotten in the other.
 */
const doc = readFileSync('docs/parity.md', 'utf8');
const listed = (id: string): boolean => doc.includes(`\`${id}\``);

const uiActions = (): string[] => {
  const src = readFileSync('src/ui/workspace-models.ts', 'utf8');
  const block = src.slice(src.indexOf('export type UiAction ='), src.indexOf('export interface Model'));
  return [...new Set([...block.matchAll(/type: '([a-z_]+)'/g)].map((m) => m[1]!))];
};

const menuKinds = (): string[] =>
  [...new Set(['menus.ts', 'work-menus.ts', 'invite-menus.ts'].flatMap((f) => [...readFileSync(`src/ui/${f}`, 'utf8').matchAll(/kind: '([a-z_]+)'/g)].map((m) => m[1]!)))];

describe('docs/parity.md', () => {
  it('lists every slash command', () => {
    expect(COMMANDS.map((c) => `/${c.name}`).filter((c) => !listed(c))).toEqual([]);
  });

  it('lists every UI action', () => {
    expect(uiActions().filter((a) => !listed(a))).toEqual([]);
  });

  it('lists every menu', () => {
    expect(menuKinds().filter((k) => !listed(k))).toEqual([]);
  });

  it('lists every API method', () => {
    expect(METHODS.filter((m) => !listed(m))).toEqual([]);
  });
});

/** The "Agent runs, per runtime" table: its header and rows as cells. */
const runtimeTable = (): { header: string[]; rows: string[][]; text: string } => {
  const start = doc.indexOf('## Agent runs, per runtime');
  const text = doc.slice(start, doc.indexOf('\n## ', start + 1));
  const lines = text.split('\n').filter((l) => l.startsWith('|'));
  const cells = (l: string): string[] => l.slice(1, l.endsWith('|') ? -1 : undefined).split(' | ').map((c) => c.trim());
  return { header: cells(lines[0]!), rows: lines.slice(2).map(cells), text };
};

/** Where screens and the core say a fallback: every `fallbackFor(…, 'id')` outside the table itself. */
const shownFallbacks = (): Set<string> => {
  const files = execSync("git ls-files 'src/*.ts' 'packages/mac/src/*.ts' 'packages/mac/src/*.tsx' 'packages/companion/app/*.tsx'", { encoding: 'utf8' }).split('\n').filter((f) => f && f !== 'src/shared/runtime-fallbacks.ts');
  return new Set(files.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/fallbackFor\([^;]*?'([a-z_]+)'\)/g)].map((m) => m[1]!)));
};

describe('docs/parity.md, per runtime', () => {
  const { header, rows, text } = runtimeTable();
  const codexFallbacks = Object.keys(RUNTIME_FALLBACKS.codex ?? {});

  it('has a column for Claude and one for Codex', () => {
    expect(header).toEqual(['What', 'Ways in', 'Claude', 'Codex']);
    expect(rows.length).toBeGreaterThan(10);
  });

  it('leaves no cell blank: each is pass, a fallback or n/a', () => {
    const bad = rows.flatMap((r) => [2, 3].filter((i) => r.length !== 4 || !/^(pass|fallback|n\/a)\b/.test(r[i] ?? '')).map((i) => `${r[0]} › ${header[i]}: "${r[i] ?? ''}"`));
    expect(bad).toEqual([]);
  });

  it('names a fallback for every Codex row that is one, and only the ones the code has', () => {
    const named = rows.filter((r) => r[3]!.startsWith('fallback')).map((r) => /`fallback:([a-z_]+)`/.exec(r[3]!)?.[1] ?? `(none in "${r[0]}")`);
    expect(named.filter((id) => !codexFallbacks.includes(id))).toEqual([]);
    expect(codexFallbacks.filter((id) => !named.includes(id))).toEqual([]);
  });

  it('shows every fallback somewhere (greyed with its reason, or the reason beside the control)', () => {
    const shown = shownFallbacks();
    expect(codexFallbacks.filter((id) => !shown.has(id))).toEqual([]);
  });

  it('accounts for every capability Codex lacks, and every fallback stands for one it does lack', () => {
    const caps = CODEX_CAPABILITIES as unknown as Record<string, unknown>;
    const lacking = Object.keys(caps).filter((k) => caps[k] === false && k !== 'hasSandbox');
    expect(lacking.filter((k) => !text.includes(`\`${k}\``))).toEqual([]);
    const claimed = Object.values(RUNTIME_FALLBACKS.codex ?? {}).flatMap((f) => (f?.capability ? [f.capability] : []));
    expect(claimed.filter((k) => caps[k] === (CLAUDE_CAPABILITIES as unknown as Record<string, unknown>)[k])).toEqual([]);
  });

  it('covers the ways in that reach an agent run', () => {
    const agentRuns = ['/model', '/handoff', '/stop', '/plan', '/compact', '/fork', '/usage', 'host.stopRun', 'host.steerNow', 'host.answerApproval', 'questions.answer', 'session.compact', 'workspaces.fork', 'workspaces.editPrompt', 'workbench.setAgent', 'claudeCode.skills', 'claudeCode.mcpServers', 'agent.steps', 'gateway.decide'];
    expect(agentRuns.filter((id) => !text.includes(`\`${id}\``))).toEqual([]);
  });
});
