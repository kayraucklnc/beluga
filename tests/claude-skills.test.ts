import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { expandCommand, skillOptions, skillPlugins } from '../src/agent/runtime/claude/skill-plugins.js';
import { createClaudeBackend } from '../src/agent/runtime/claude/runner.js';
import { localRuntime } from '../src/agent/runtime/local.js';
import { resumable, resumeFor } from '../src/agent/session-carry.js';
import type { AgentRunInput } from '../src/agent/types.js';
import { needsHandoff } from '../src/core/agent-switch.js';
import { runCommand } from '../src/core/commands.js';
import type { Session } from '../src/core/session.js';
import { builtInInstead } from '../src/shared/skills.js';
import { room } from './runtime-conformance.js';

/** BLG-505: Claude Code's skills and commands on your own Claude runs, without settings or hooks from disk. */

// The Agent SDK's query, recording each call's options and first prompt, answering at once.
const sdk = vi.hoisted(() => ({ calls: [] as Array<{ options: Options; prompt: unknown }> }));
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...(await original<object>()),
  query: ({ prompt, options }: { prompt: AsyncIterable<{ message: { content: unknown } }> | string; options: Options }) => {
    const call = { options, prompt: undefined as unknown };
    sdk.calls.push(call);
    async function* run() {
      yield { type: 'system', subtype: 'init', session_id: 's1' };
      if (typeof prompt === 'string') call.prompt = prompt;
      else for await (const m of prompt) {
        call.prompt = m.message.content;
        break;
      }
      yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', modelUsage: {}, total_cost_usd: 0, session_id: 's1' };
    }
    return Object.assign(run(), { interrupt: async () => undefined, setModel: async () => undefined, setPermissionMode: async () => undefined, close: () => undefined });
  },
}));

let project: string;
let home: string;
let plugin: string;
let state: string;
const saved: Record<string, string | undefined> = {};

const write = (file: string, text: string): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

beforeAll(() => {
  const tmp = (name: string) => realpathSync(mkdtempSync(path.join(os.tmpdir(), `claude-skills-${name}-`)));
  [project, home, plugin, state] = [tmp('project'), tmp('home'), tmp('plugin'), tmp('state')];
  write(path.join(project, '.claude', 'skills', 'pineapple', 'SKILL.md'), '---\nname: pineapple\ndescription: Secret fruit\n---\nSay MANGOSTEEN.\n');
  write(path.join(project, '.claude', 'commands', 'fruit.md'), '---\ndescription: Name a fruit\n---\nSay RAMBUTAN and then: $ARGUMENTS\n');
  write(path.join(project, '.claude', 'commands', 'git', 'sync.md'), 'Say DURIAN.\n');
  write(path.join(project, '.claude', 'hooks', 'hooks.json'), '{"hooks":{}}');
  write(path.join(project, '.claude', 'settings.json'), '{"hooks":{}}');
  write(path.join(home, 'commands', 'standup.md'), 'Write my standup.\n');
  // Real ones are big (20 KB and more): read whole, never cut to nothing.
  write(path.join(home, 'settings.json'), JSON.stringify({ enabledPlugins: { 'tools@market': true }, permissions: { allow: Array(1000).fill('Bash(ls:*)') } }));
  write(path.join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'tools@market': [{ installPath: plugin }] }, notes: 'x'.repeat(20_000) }));
  write(path.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'tools', version: '1.0.0', hooks: './hooks/hooks.json', mcpServers: { x: { command: 'x' } } }));
  write(path.join(plugin, 'commands', 'hello.md'), 'Run ${CLAUDE_PLUGIN_ROOT}/scripts/hello.sh for $1\n');
  write(path.join(plugin, 'skills', 'lint', 'SKILL.md'), '---\nname: lint\n---\nLint.\n');
  write(path.join(plugin, 'scripts', 'hello.sh'), 'echo hi\n');
  write(path.join(plugin, 'hooks', 'hooks.json'), '{"hooks":{}}');
  write(path.join(plugin, '.mcp.json'), '{"mcpServers":{}}');
  for (const k of ['BELUGA_CLAUDE_HOME', 'BELUGA_HOME']) saved[k] = process.env[k];
  process.env.BELUGA_CLAUDE_HOME = home;
  process.env.BELUGA_HOME = state;
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const dir of [project, home, plugin, state]) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => void sdk.calls.splice(0));

describe('skills as plugins, without hooks or MCP from disk', () => {
  it("loads the project's, yours and your enabled plugins' as plugins that link only what they may bring", async () => {
    const root = path.join(state, 'plugins-a');
    const found = await skillPlugins(project, home, root);
    expect(found).toHaveLength(3);
    for (const p of found) expect(p).toMatchObject({ type: 'local', skipMcpDiscovery: true });
    const [own, yours, tools] = found.map((p) => p.path);
    // The project's: skills and commands, linked; never its hooks or settings.
    expect(readdirSync(own!).sort()).toEqual(['.claude-plugin', 'commands', 'skills']);
    expect(lstatSync(path.join(own!, 'skills')).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(path.join(own!, '.claude-plugin', 'plugin.json'), 'utf8'))).toEqual({ name: 'project' });
    expect(readdirSync(yours!).sort()).toEqual(['.claude-plugin', 'commands']);
    // A plugin keeps what its skills use (scripts) but not its hooks, MCP, or their manifest entries.
    expect(readdirSync(tools!).sort()).toEqual(['.claude-plugin', 'commands', 'scripts', 'skills']);
    expect(JSON.parse(readFileSync(path.join(tools!, '.claude-plugin', 'plugin.json'), 'utf8'))).toEqual({ name: 'tools', version: '1.0.0' });
    // The same sources: the same folders, reused.
    expect((await skillPlugins(project, home, root)).map((p) => p.path)).toEqual([own, yours, tools]);
  });

  it('gives a friend’s or guest’s run none, and skips a folder with nothing to bring', async () => {
    expect(await skillOptions(false, project, home, path.join(state, 'plugins-b'))).toEqual({});
    const bare = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'claude-skills-bare-')));
    const opts = await skillOptions(true, bare, path.join(bare, 'no-home'), path.join(state, 'plugins-b'));
    expect(opts).toEqual({});
    rmSync(bare, { recursive: true, force: true });
  });
});

describe('custom commands filled in by Beluga', () => {
  it('fills a command (arguments, a subfolder one, a plugin one with its root) and leaves a skill to Claude', async () => {
    expect(await expandCommand('/fruit apples and pears', project, home)).toBe('Say RAMBUTAN and then: apples and pears');
    expect(await expandCommand('/git:sync', project, home)).toBe('Say DURIAN.');
    expect(await expandCommand('/sync', project, home)).toBe('Say DURIAN.');
    expect(await expandCommand('/standup', project, home)).toBe('Write my standup.');
    expect(await expandCommand('/tools:hello bob', project, home)).toBe(`Run ${plugin}/scripts/hello.sh for bob`);
    expect(await expandCommand('/pineapple now', project, home)).toBe('/pineapple now');
    expect(await expandCommand('//pineapple', project, home)).toBe('/pineapple');
    expect(await expandCommand('/nothing here', project, home)).toBe('/nothing here');
    expect(await expandCommand('fix /fruit', project, home)).toBe('fix /fruit');
  });
});

function input(prompt: string, extra: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    prompt,
    requesterName: 'kay',
    viaAgent: false,
    context: [],
    scope: 'full',
    signal: new AbortController().signal,
    onEvent: () => undefined,
    onFileTouched: () => undefined,
    canUseTool: async () => true,
    place: { cwd: project, additionalDirectories: [], autoEdit: true, onSession: () => undefined },
    ...extra,
  };
}

const text = (content: unknown): string => (typeof content === 'string' ? content : JSON.stringify(content));

describe('a Claude run', () => {
  const backend = () => createClaudeBackend({ cwd: project, autoEdit: true, additionalDirectories: [], bridge: room });

  it('your own: skills as plugins, still no settings files, and a command filled in before it goes', async () => {
    await backend().run(input('/fruit kiwi', { ownerMcp: true }));
    const [{ options, prompt }] = sdk.calls as [{ options: Options; prompt: unknown }];
    expect(options.settingSources).toEqual([]);
    expect(options.skills).toBe('all');
    expect(options.plugins?.map((p) => path.basename(p.path).split('-')[0])).toEqual(['project', 'user', 'tools']);
    expect(text(prompt)).toContain('Say RAMBUTAN and then: kiwi');
  });

  it("a friend's: no skills, and the message goes as typed", async () => {
    await backend().run(input('/fruit kiwi'));
    const [{ options, prompt }] = sdk.calls as [{ options: Options; prompt: unknown }];
    expect(options.plugins).toBeUndefined();
    expect(options.skills).toBeUndefined();
    expect(text(prompt)).toContain('/fruit kiwi');
  });
});

describe('a local model', () => {
  const target = { label: 'Ollama', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3' };
  const local = () => localRuntime((v) => (v === 'ollama/qwen3' ? target : undefined)).create({ cwd: project, autoEdit: true, additionalDirectories: [], bridge: room });

  it('is told its own name, not Claude', async () => {
    await local().run(input('hello', { model: 'ollama/qwen3' }));
    const append = (sdk.calls[0]!.options.systemPrompt as { append: string }).append;
    expect(append).toContain("You are kay's qwen3");
  });

  it('asks a side question on its own endpoint, never Anthropic, and refuses when the endpoint is gone', async () => {
    await local().btw!({ question: 'why?', cwd: project, resume: 's1', model: 'ollama/qwen3', signal: new AbortController().signal, onText: () => undefined });
    const { options } = sdk.calls[0]!;
    expect(options.model).toBe('qwen3');
    expect(options.env?.ANTHROPIC_BASE_URL).toBe(target.baseUrl);
    expect(options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('');
    await expect(local().btw!({ question: 'why?', cwd: project, model: 'gone/x', signal: new AbortController().signal, onText: () => undefined })).rejects.toThrow(/isn't set up/);
  });

  it("resumes Claude's conversations (no handoff); Claude doesn't resume a local one", () => {
    expect(resumable(undefined, 'local')).toBe(true);
    expect(resumable('claude', 'local')).toBe(true);
    expect(resumable('local', 'claude')).toBe(false);
    expect(resumable('codex', 'local')).toBe(false);
    expect(resumeFor({ sessionId: 's' }, 'local')).toEqual({ resume: 's', forkSession: false });
    expect(resumeFor({}, 'local', 'outside')).toEqual({ resume: 'outside', forkSession: false });
    expect(resumeFor({ sessionId: 's', sessionRuntime: 'local' }, 'claude')).toEqual({ resume: undefined, forkSession: false });
    expect(needsHandoff({ sessionId: 's' }, 'local')).toBe(false);
    expect(needsHandoff({ sessionId: 's', sessionRuntime: 'local' }, 'claude')).toBe(true);
  });
});

describe("Claude Code's built-ins typed in a conversation", () => {
  it('say what Beluga has instead, and never go to the agent as text (unless a skill of yours has that name)', async () => {
    expect(builtInInstead('context')).toMatch(/context meter/);
    expect(builtInInstead('rewind')).toMatch(/Edit/);
    expect(builtInInstead('review')).toBeUndefined();
    expect(builtInInstead('fruit')).toBeUndefined();
    const toast = vi.fn();
    const askOwnClaude = vi.fn();
    let own = false;
    const session = { store: { getState: () => ({}) }, toast, askOwnClaude, ownSkill: async () => own, workspaces: { inChannel: () => ({}) } } as unknown as Session;
    runCommand(session, 'context', [], 'ws:w1', '/context');
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringMatching(/context meter/), 'info'));
    runCommand(session, 'fruit', ['kiwi'], 'ws:w1', '/fruit kiwi');
    expect(askOwnClaude).toHaveBeenCalledWith('/fruit kiwi', 'ws:w1');
    expect(askOwnClaude).toHaveBeenCalledTimes(1);
    own = true;
    runCommand(session, 'status', [], 'ws:w1', '/status');
    await vi.waitFor(() => expect(askOwnClaude).toHaveBeenCalledWith('/status', 'ws:w1'));
  });
});

it('leaves no half-made plugin folders behind', () => {
  const root = path.join(state, 'plugins-a');
  expect(existsSync(root) && readdirSync(root).some((d) => d.includes('.tmp-'))).toBe(false);
});
