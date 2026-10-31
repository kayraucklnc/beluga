import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * No screen says "Claude" when it means "your agent" (BLG-436, BLG-437): a person may run Codex
 * or a local model, so words come from shared/agent-label.ts or say "agent". "Claude" stays
 * only where the Claude runtime itself is meant: signing in to it, Claude Code sessions, its
 * plan usage, its models. Such a line says so with RUNTIME (a product name) or the marker
 * `agent-wording: claude` on it or the line above; a whole runtime-specific screen is in FILES.
 */

const repo = path.resolve(__dirname, '..');

/** Names of the Claude runtime itself, not of "your agent". */
const RUNTIME = /Claude Code|Claude Desktop|claude\.ai|Anthropic|Claude (Pro|Max|Team|plan|subscription|account|login|models?|Opus|Sonnet|Haiku|Fable)\b|(sign|log)(ged|s)? in(to| to)? Claude|Claude’s (plan|limits?)|Claude's (plan|limits?)|claude (login|setup-token|auth)/;
const MARKER = 'agent-wording: claude';

/** Screens about the Claude runtime only (its sign-in, its settings, Claude Code's own sessions). */
/** The runtimes' own names live here (shared/agent-label.ts): it's what turns them into words. */
const FILES: readonly string[] = ['src/shared/agent-label.ts'];

/** A line of code (not a comment) with "Claude" in a string or JSX text. */
function offenders(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (name === 'node_modules' || name.startsWith('.')) continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && !name.endsWith('.generated.ts')) check(p);
    }
  };
  const check = (file: string): void => {
    const rel = path.relative(repo, file);
    if (FILES.includes(rel)) return;
    const lines = readFileSync(file, 'utf8').split('\n');
    let comment = false;
    lines.forEach((raw, i) => {
      const s = raw.trim();
      if (comment) {
        if (s.includes('*/')) comment = false;
        return;
      }
      if (s.startsWith('/*')) {
        if (!s.includes('*/')) comment = true;
        return;
      }
      if (s.startsWith('//') || s.startsWith('*')) return;
      if (raw.includes(MARKER) || lines[i - 1]?.includes(MARKER)) return;
      const code = raw.replace(/\s\/\/\s.*$/, '').replace(/\{\/\*.*?\*\/\}/g, '');
      // "Claude" as a word (identifiers like ClaudeMark aren't words a user reads), in a string or JSX text.
      if (!/\bClaude(?![A-Za-z])/.test(code) || !/(['"`>][^'"`]*\bClaude(?![A-Za-z]))|(\bClaude(?![A-Za-z])[^'"`<]*['"`<])/.test(code)) return;
      if (RUNTIME.test(code)) return;
      out.push(`${rel}:${i + 1}: ${s.slice(0, 160)}`);
    });
  };
  walk(root);
  return out;
}

describe('screens say the agent, not "Claude"', () => {
  it('the Mac app', () => {
    expect(offenders(path.join(repo, 'packages/mac/src'))).toEqual([]);
  });

  it('the shared models the screens import', () => {
    expect([...offenders(path.join(repo, 'src/ui')), ...offenders(path.join(repo, 'src/shared'))]).toEqual([]);
  });

  it('the phone app', () => {
    expect(['app', 'components', 'lib'].flatMap((d) => offenders(path.join(repo, 'packages/companion', d)))).toEqual([]);
  });
});
