import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { INLINE_MAX, PREVIEW_CHARS, stepMaterial } from '../src/core/sentinel/prompt.js';
import { render } from '../src/core/sentinel/render.js';
import type { SentinelShell } from '../src/core/sentinel/runner.js';
import { setup, until } from './sentinel-fakes.js';

/** A step's output handed to the next as a file in the run's folder, not pasted whole (BLG-331). */

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'beluga-step-files-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ended = (s: ReturnType<typeof setup>, runId: string) => () => !['queued', 'running'].includes(s.sentinels.runGet(runId).run.state);

/** A shell that answers each command with its own output. */
const shellOf = (outputs: Record<string, string>): { shell: SentinelShell; envs: Array<Record<string, string>> } => {
  const envs: Array<Record<string, string>> = [];
  return {
    envs,
    shell: async (command, _cwd, _ms, env) => {
      envs.push(env);
      return { exitCode: 0, output: outputs[command] ?? '', truncated: false, timedOut: false, ms: 1 };
    },
  };
};

/** 10 000 characters of JSON, its end marked so a test can tell it wasn't pasted. */
const bigJson = (): string => {
  const rows = Array.from({ length: 400 }, (_, i) => ({ id: i, name: `row ${i}` }));
  const text = JSON.stringify([...rows, { end: 'THE-VERY-END' }], null, 1);
  expect(text.length).toBeGreaterThan(INLINE_MAX);
  return text;
};

describe('step outputs as files', () => {
  it('a small output still goes inline; the file is written and scripts get its path', async () => {
    const dir = tmp();
    const sh = shellOf({ first: 'ok\n', second: 'two\n' });
    const s = setup({ dir, shell: sh.shell, reply: () => 'fine' });
    const made = s.sentinels.create({
      name: 'Small',
      projectId: 'api',
      steps: [
        { kind: 'script', name: 'First', command: 'first', cwd: 'home', timeoutSec: 5 },
        { kind: 'script', name: 'Second', command: 'second', cwd: 'home', timeoutSec: 5 },
        { kind: 'claude', where: 'project', prompt: 'P: {{previous}} F: {{steps.First}}' },
      ],
    });
    const run = s.sentinels.start(made.id, 'you');
    await until(ended(s, run.id));
    const folder = path.join(dir, 'sentinel', 'runs', run.id);
    expect(readFileSync(path.join(folder, 'step-1.txt'), 'utf8')).toBe('ok\n');
    expect(readFileSync(path.join(folder, 'step-2.txt'), 'utf8')).toBe('two\n');
    // The first script has no step before it; the second gets the first's file alongside its text.
    expect(sh.envs[0]).toMatchObject({ SENTINEL_PREVIOUS: '', SENTINEL_PREVIOUS_FILE: '' });
    expect(sh.envs[1]).toMatchObject({ SENTINEL_PREVIOUS: 'ok\n', SENTINEL_PREVIOUS_FILE: path.join(folder, 'step-1.txt') });
    expect(s.asked[0]!.prompt).toBe('P: <sentinel_step name="Second">\ntwo\n</sentinel_step> F: <sentinel_step name="First">\nok\n</sentinel_step>');
  });

  it('a big output goes to Claude as its file: the path, its size and a preview, never pasted whole', async () => {
    const dir = tmp();
    const big = bigJson();
    const sh = shellOf({ fetch: big });
    const briefs: string[] = [];
    const s = setup({
      dir,
      shell: sh.shell,
      reply: (a) => {
        briefs.push(s.sentinels.forRun(a.channel, 'p-me')?.brief ?? '');
        return 'read it';
      },
    });
    const made = s.sentinels.create({
      name: 'Big',
      projectId: 'api',
      steps: [
        { kind: 'script', name: 'Fetch', command: 'fetch', cwd: 'home', timeoutSec: 5 },
        { kind: 'claude', where: 'project', prompt: 'Summarise: {{previous}}\nAgain: {{steps.Fetch}}' },
        { kind: 'notify', name: 'Tell me', phone: false, body: 'Got {{steps.Fetch}}' },
      ],
    });
    const run = s.sentinels.start(made.id, 'you');
    await until(ended(s, run.id));
    const file = path.join(dir, 'sentinel', 'runs', run.id, 'step-1.txt');
    expect(readFileSync(file, 'utf8')).toBe(big);
    const prompt = s.asked[0]!.prompt;
    expect(prompt).not.toContain('THE-VERY-END');
    expect(prompt).toContain(`<sentinel_step name="Fetch" file="${file}" size="${big.length.toLocaleString('en-US')} characters (`);
    expect(prompt).toContain('format="json"');
    expect(prompt).toContain(big.slice(0, PREVIEW_CHARS).trimEnd());
    expect(prompt).not.toContain(big.slice(0, PREVIEW_CHARS + 50));
    expect(prompt).toContain(`Read the whole of it from ${file}`);
    expect(prompt.match(/<\/sentinel_step>/g)).toHaveLength(2);
    // The run's brief shows it the same way, and says how.
    expect(briefs[0]).toContain(`file="${file}"`);
    expect(briefs[0]).not.toContain('THE-VERY-END');
    expect(briefs[0]).toContain(`over ${INLINE_MAX.toLocaleString('en-US')} characters comes as its file`);
    // Notify texts keep the output itself (its first line), never a path.
    expect(s.notices[0]?.body).toBe('Got [');
  });

  it('what goes in the file is redacted, as the output is', async () => {
    const dir = tmp();
    const big = `GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n${'x'.repeat(INLINE_MAX + 100)}`;
    const s = setup({ dir, shell: shellOf({ env: big }).shell, reply: () => 'ok' });
    const made = s.sentinels.create({
      name: 'Secret',
      projectId: 'api',
      steps: [
        { kind: 'script', name: 'Env', command: 'env', cwd: 'home', timeoutSec: 5 },
        { kind: 'claude', where: 'project', prompt: '{{previous}}' },
      ],
    });
    const run = s.sentinels.start(made.id, 'you');
    await until(ended(s, run.id));
    const file = readFileSync(path.join(dir, 'sentinel', 'runs', run.id, 'step-1.txt'), 'utf8');
    expect(file).not.toContain('ghp_');
    expect(file).toContain('GITHUB_TOKEN=[redacted]');
    expect(s.asked[0]!.prompt).not.toContain('ghp_');
    expect(s.asked[0]!.prompt).toContain('file="');
  });

  it('a script after a big output gets SENTINEL_PREVIOUS_FILE with all of it', async () => {
    const dir = tmp();
    const big = bigJson();
    const sh = shellOf({ fetch: big, read: 'done' });
    const s = setup({ dir, shell: sh.shell });
    const made = s.sentinels.create({
      name: 'Pipe',
      steps: [
        { kind: 'script', name: 'Fetch', command: 'fetch', cwd: 'home', timeoutSec: 5 },
        { kind: 'script', name: 'Read', command: 'read', cwd: 'home', timeoutSec: 5 },
      ],
    });
    const run = s.sentinels.start(made.id, 'you');
    await until(ended(s, run.id));
    const at = sh.envs[1]!.SENTINEL_PREVIOUS_FILE!;
    expect(at).toBe(path.join(dir, 'sentinel', 'runs', run.id, 'step-1.txt'));
    expect(readFileSync(at, 'utf8')).toBe(big);
    expect(sh.envs[1]!.SENTINEL_PREVIOUS).toBe(big);
  });

  it('without a run folder (memory only) a big output goes inline as before', async () => {
    const big = bigJson();
    const sh = shellOf({ fetch: big });
    const s = setup({ shell: sh.shell, reply: () => 'ok' });
    const made = s.sentinels.create({
      name: 'Memory',
      projectId: 'api',
      steps: [
        { kind: 'script', name: 'Fetch', command: 'fetch', cwd: 'home', timeoutSec: 5 },
        { kind: 'claude', where: 'project', prompt: '{{previous}}' },
      ],
    });
    const run = s.sentinels.start(made.id, 'you');
    await until(ended(s, run.id));
    expect(s.asked[0]!.prompt).toContain('THE-VERY-END');
    expect(s.asked[0]!.prompt).not.toContain('file="');
  });
});

describe('stepMaterial and render', () => {
  const big = 'a'.repeat(INLINE_MAX + 1);
  it('inline up to INLINE_MAX, a file above it', () => {
    const small = 'a'.repeat(INLINE_MAX);
    expect(stepMaterial('step', 'S', small, '/runs/r1/step-1.txt')).toBe(`<sentinel_step name="S">\n${small}\n</sentinel_step>`);
    const filed = stepMaterial('step', 'S', big, '/runs/r1/step-1.txt');
    expect(filed).toContain('<sentinel_step name="S" file="/runs/r1/step-1.txt" size="4,001 characters (4 KB)">');
    expect(filed).toContain(`${'a'.repeat(PREVIEW_CHARS)}\n…\n</sentinel_step>`);
    expect(filed).not.toContain('a'.repeat(PREVIEW_CHARS + 1));
    expect(filed).not.toContain('format="json"');
    // No file: as before.
    expect(stepMaterial('step', 'S', big)).toBe(`<sentinel_step name="S">\n${big}\n</sentinel_step>`);
  });

  it('templates without material (notify, message, service calls) keep the text itself', () => {
    const ctx = { trigger: { kind: 'manual', summary: 'x' }, date: 'Mon 26 Oct 2026', sentinel: 'S', previous: big, previousName: 'Fetch', previousFile: '/runs/r1/step-1.txt', steps: { Fetch: big }, stepFiles: { Fetch: '/runs/r1/step-1.txt' } };
    expect(render('{{previous}}|{{steps.Fetch}}', ctx)).toBe(`${big}|${big}`);
    expect(render('{{previous}}', { ...ctx, material: stepMaterial })).toContain('file="/runs/r1/step-1.txt"');
    expect(render('{{steps.fetch}}', { ...ctx, material: stepMaterial })).toContain('file="/runs/r1/step-1.txt"');
  });
});
