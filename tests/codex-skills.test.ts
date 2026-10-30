import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCodexBackend } from '../src/agent/runtime/codex/runner.js';
import { fillArguments, mapSlash } from '../src/agent/runtime/codex/skills.js';
import type { AgentRunInput } from '../src/agent/types.js';
import { findSkill, listSkills } from '../src/core/claude-code/skills.js';
import { suggest } from '../src/ui/suggest.js';
import { FakeCodex } from './fake-codex.js';
import { room } from './runtime-conformance.js';

let project: string;
let home: string;
let savedHome: string | undefined;

beforeAll(() => {
  project = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'codex-skills-project-')));
  home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'codex-skills-home-')));
  mkdirSync(path.join(project, '.claude', 'skills', 'deploy'), { recursive: true });
  writeFileSync(path.join(project, '.claude', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: Ship it\nallowed-tools: Bash(git push:*)\nmodel: opus\n---\nDeploy the app.\n');
  mkdirSync(path.join(project, '.claude', 'commands'), { recursive: true });
  writeFileSync(path.join(project, '.claude', 'commands', 'fix.md'), '---\ndescription: Fix an issue\nargument-hint: [issue]\n---\nFix issue $ARGUMENTS and add a test.\n');
  mkdirSync(path.join(home, 'commands'), { recursive: true });
  writeFileSync(path.join(home, 'commands', 'standup.md'), 'Write my standup from git log.\n');
  savedHome = process.env.BELUGA_CLAUDE_HOME;
  process.env.BELUGA_CLAUDE_HOME = home;
});

afterAll(() => {
  if (savedHome === undefined) delete process.env.BELUGA_CLAUDE_HOME;
  else process.env.BELUGA_CLAUDE_HOME = savedHome;
  rmSync(project, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function input(prompt: string, extra: Partial<AgentRunInput> = {}): AgentRunInput & { events: Array<[string, string]> } {
  const events: Array<[string, string]> = [];
  return {
    prompt,
    requesterName: 'kay',
    viaAgent: false,
    context: [],
    scope: 'full',
    signal: new AbortController().signal,
    onEvent: (k, t) => void events.push([k, t]),
    onFileTouched: () => undefined,
    canUseTool: async () => true,
    place: { cwd: project, additionalDirectories: [], autoEdit: true, onSession: () => undefined },
    events,
    ...extra,
  };
}

const backend = (codex: FakeCodex) => createCodexBackend({ cwd: project, autoEdit: true, additionalDirectories: [], bridge: room, connect: codex.connect });

describe("a project's instructions on Codex", () => {
  it("its setup instructions reach the run (a marker instruction), with Beluga's graph, view and scratch appends", async () => {
    const codex = new FakeCodex();
    await backend(codex).run(input('hello', { setup: { brief: '\nMARKER-SETUP-7731: run `make bootstrap` first.\n', set: () => 'ok' }, scratchDir: '.beluga/scratch', taskBrief: '\nTASK-BRIEF-MARKER\n' }));
    const start = codex.sent('thread/start')[0]!;
    const instructions = String(start.developerInstructions);
    expect(instructions).toContain('MARKER-SETUP-7731');
    expect(instructions).toContain('TASK-BRIEF-MARKER');
    expect(instructions).toContain('beluga-graph');
    expect(instructions).toContain('Showing data (the Beluga app draws it)');
    expect(instructions).toContain('Scratch folder: .beluga/scratch/');
    // CLAUDE.md reaches Codex where a project has no AGENTS.md.
    expect((start.config as Record<string, unknown>).project_doc_fallback_filenames).toEqual(['CLAUDE.md']);
  });

  it('a main folder gets no setup brief (as on Claude)', async () => {
    const codex = new FakeCodex();
    await backend(codex).run(input('hello', { setup: { brief: 'MARKER-SETUP-7731', set: () => 'ok' }, place: { cwd: project, additionalDirectories: [], autoEdit: false, askOnly: { project: 'p' }, onSession: () => undefined } }));
    expect(String(codex.sent('thread/start')[0]!.developerInstructions)).not.toContain('MARKER-SETUP-7731');
  });
});

describe("Claude Code's skills and commands on Codex", () => {
  it("a skill goes in as Codex's own skill input; what it can't take is said", async () => {
    const mapped = await mapSlash('/deploy staging', project, home);
    expect(mapped.skill).toEqual({ name: 'deploy', path: path.join(project, '.claude', 'skills', 'deploy', 'SKILL.md') });
    expect(mapped.prompt).toBe('Use the deploy skill: staging');
    expect(mapped.notes).toEqual(['/deploy runs on Codex without its allowed tools, its model (not on Codex).']);
  });

  it('a command becomes the prompt, its arguments filled in (yours too, and "//name")', async () => {
    expect(await mapSlash('/fix 42', project, home)).toEqual({ prompt: 'Fix issue 42 and add a test.', notes: [] });
    expect((await mapSlash('//standup', project, home)).prompt).toBe('Write my standup from git log.');
    expect(fillArguments('Review $1 against $2', 'a.ts main')).toBe('Review a.ts against main');
    expect(fillArguments('Summarize the diff', 'briefly')).toBe('Summarize the diff\n\nbriefly');
  });

  it("Claude Code's own commands are said to be not on Codex, never dropped; other text is left alone", async () => {
    expect(await mapSlash('/compact', project, home)).toEqual({ prompt: '/compact', notes: ["/compact is one of Claude Code's own commands: not on Codex, so it went in as plain text."] });
    expect(await mapSlash('/etc/hosts looks odd', project, home)).toEqual({ prompt: '/etc/hosts looks odd', notes: [] });
    expect(await mapSlash('fix the build', project, home)).toEqual({ prompt: 'fix the build', notes: [] });
  });

  it('a run says the note in the chat and keeps it at the top of its answer', async () => {
    const codex = new FakeCodex();
    const run = input('/deploy staging');
    const answer = await backend(codex).run(run);
    const turn = codex.sent('turn/start')[0]!;
    expect(turn.input).toContainEqual({ type: 'skill', name: 'deploy', path: path.join(project, '.claude', 'skills', 'deploy', 'SKILL.md') });
    expect((turn.input as Array<{ type: string; text?: string }>)[0]!.text).toContain('Use the deploy skill: staging');
    expect(run.events).toContainEqual(['text', '/deploy runs on Codex without its allowed tools, its model (not on Codex).']);
    expect(answer.startsWith('/deploy runs on Codex without')).toBe(true);
  });

  it('the / list says what of a skill is not on Codex, when the conversation runs on Codex', async () => {
    const skills = await listSkills(project, home);
    expect(skills.find((s) => s.name === 'deploy')).toMatchObject({ onCodex: 'Not on Codex: its allowed tools, its model' });
    expect(skills.find((s) => s.name === 'fix')?.onCodex).toBeUndefined();
    const hint = (on: 'native' | 'mapped') => suggest('/dep', { peers: [], selfId: 'me', dirCache: {}, listLocalDirs: () => [], skills, skillsOn: on }).find((x) => x.label === '/deploy')?.hint;
    expect(hint('mapped')).toBe('Ship it · Not on Codex: its allowed tools, its model');
    expect(hint('native')).toBe('Ship it');
  });
});

describe('finding a skill by the name the / list shows', () => {
  it('finds a skill by its frontmatter name and a command in a subfolder', async () => {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'codex-skills-named-')));
    try {
      mkdirSync(path.join(dir, '.claude', 'skills', 'review-helper'), { recursive: true });
      writeFileSync(path.join(dir, '.claude', 'skills', 'review-helper', 'SKILL.md'), '---\nname: review\ndescription: Review it\n---\nReview the diff.\n');
      mkdirSync(path.join(dir, '.claude', 'commands', 'git'), { recursive: true });
      writeFileSync(path.join(dir, '.claude', 'commands', 'git', 'sync.md'), 'Sync with main.\n');
      const listed = (await listSkills(dir, home)).map((s) => s.name);
      expect(listed).toEqual(expect.arrayContaining(['review', 'sync']));
      expect((await findSkill('review', dir, home))?.body).toContain('Review the diff.');
      expect((await findSkill('sync', dir, home))?.kind).toBe('command');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
