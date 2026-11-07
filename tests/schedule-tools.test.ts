import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { SCHEDULE_RUN_TOOLS, SCHEDULE_TOOL_NAMES, createScheduleToolDefs } from '../src/agent/schedule-tools.js';
import { ALWAYS_ASK_YOU, decideTool } from '../src/agent/policy.js';
import { createCodexBackend } from '../src/agent/runtime/codex/runner.js';
import { runToolSuites } from '../src/agent/run-tools.js';
import type { AgentRunInput, ScheduleTools } from '../src/agent/types.js';
import { FakeCodex } from './fake-codex.js';
import { waitFor } from './helpers.js';
import { room } from './runtime-conformance.js';
import { harness, type Harness } from './schedule-fakes.js';

const NIGHTLY = { title: 'Nightly triage', prompt: 'Read the new issues', when: { kind: 'schedule', every: 'day', at: '21:00' } };
const CREATE = 'mcp__beluga_schedule__schedule_create';
const UPDATE = 'mcp__beluga_schedule__schedule_update';
const REMOVE = 'mcp__beluga_schedule__schedule_remove';
const POLICY = { cwd: '/tmp', roots: [], autoEdit: false };

/** A tool of a run, as the agent calls it: first the approval, as the gate asks it, then the tool. */
async function call(input: AgentRunInput, short: string, args: Record<string, unknown>): Promise<string> {
  const full = `mcp__beluga_schedule__${short}`;
  if (decideTool(full, args, POLICY) !== 'allow' && !(await input.canUseTool(full, args))) return 'declined';
  const def = createScheduleToolDefs(input.scheduleTools!).find((d) => d.name === short);
  if (!def) return 'no such tool';
  const result = await def.handler(args as never, undefined);
  return (result.content[0] as { text: string }).text;
}

describe('the policy', () => {
  it('list and pause run; create, update and remove always ask you', () => {
    for (const name of SCHEDULE_TOOL_NAMES) {
      const asks = [CREATE, UPDATE, REMOVE].includes(name);
      expect(decideTool(name, {}, POLICY)).toBe(asks ? 'ask' : 'allow');
      expect(ALWAYS_ASK_YOU.has(name)).toBe(asks);
    }
  });

  it('no tool takes a channel, so another chat cannot be named', () => {
    const fake = {} as ScheduleTools;
    for (const def of createScheduleToolDefs(fake)) {
      const schema = JSON.stringify(z.toJSONSchema(z.object(def.inputSchema)));
      expect(schema).not.toMatch(/channel/i);
    }
    expect(createScheduleToolDefs(fake).map((d) => `mcp__beluga_schedule__${d.name}`)).toEqual(SCHEDULE_TOOL_NAMES);
  });
});

describe('the runtimes', () => {
  it('Codex gets the suite when the run has it, and only then', async () => {
    const tools: ScheduleTools = { list: () => '', create: () => '', update: () => '', pause: () => '', remove: () => '' };
    const run = (extra: Partial<AgentRunInput>): AgentRunInput => ({ prompt: 'hello', requesterName: 'kay', viaAgent: false, context: [], scope: 'full', signal: new AbortController().signal, onEvent: () => undefined, onFileTouched: () => undefined, canUseTool: async () => true, ...extra });
    const servers = async (extra: Partial<AgentRunInput>): Promise<Record<string, unknown>> => {
      const codex = new FakeCodex();
      await createCodexBackend({ cwd: process.cwd(), autoEdit: true, additionalDirectories: [], bridge: room, connect: codex.connect }).run(run(extra));
      return codex.sent('thread/start')[0]!.config as Record<string, unknown>;
    };
    expect((await servers({ scheduleTools: tools }))['mcp_servers.beluga_schedule']).toBeDefined();
    expect((await servers({}))['mcp_servers.beluga_schedule']).toBeUndefined();
    expect(runToolSuites(run({ scheduleTools: { ...tools, only: SCHEDULE_RUN_TOOLS } }), room, { expand: (t: string) => t } as never, process.cwd()).beluga_schedule!.tools.map((t) => t.name)).toEqual(SCHEDULE_RUN_TOOLS);
  });
});

describe('a run in a chat', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(async () => {
    await h.close();
  });

  /** One run of your own in the chat, doing `body`; it ends when `body` does. */
  async function inRun(channel: string, body: (input: AgentRunInput) => Promise<string>): Promise<void> {
    const before = h.runs.length;
    h.script.run = body;
    h.session.askOwnClaude('do it', channel, false, false);
    await waitFor(() => h.runs.length > before);
  }
  const approval = () => h.store.getState().approvals[0];

  it('create asks with the sentence and the prompt; a denial creates nothing; approval turns it on', { timeout: 20_000 }, async () => {
    const schedules = h.launch();
    const channel = await h.chat();

    let answer: string | undefined;
    await inRun(channel, async (input) => (answer = await call(input, 'schedule_create', NIGHTLY)));
    await waitFor(() => approval()?.kind === 'tool');
    expect(approval()).toMatchObject({ once: true, title: 'Run "Nightly triage" every day at 21:00 in this chat', detail: 'Read the new issues' });
    expect(schedules.list(channel)).toEqual([]);
    h.session.answerApproval('no');
    await waitFor(() => answer !== undefined);
    expect(answer).toBe('declined');
    expect(schedules.list(channel)).toEqual([]);

    answer = undefined;
    await inRun(channel, async (input) => (answer = await call(input, 'schedule_create', { ...NIGHTLY, enabled: false, channel: 'ws:other' })));
    await waitFor(() => approval()?.kind === 'tool');
    h.session.answerApproval('yes');
    await waitFor(() => answer !== undefined);
    expect(answer).toMatch(/^"Nightly triage" is on\. It runs every day at 21:00\./);
    expect(schedules.list(channel)).toHaveLength(1);
    expect(schedules.list(channel)[0]).toMatchObject({ enabled: true, channel, title: 'Nightly triage' });
    expect(schedules.list('ws:other')).toEqual([]);
  });

  it('update and remove ask too, and a schedule of another chat cannot be reached', { timeout: 20_000 }, async () => {
    const schedules = h.launch();
    const channel = await h.chat('One');
    const other = await h.chat('Two');
    const mine = schedules.create(channel, NIGHTLY);
    const theirs = schedules.create(other, { ...NIGHTLY, title: 'Theirs' });

    const said: string[] = [];
    let done = false;
    await inRun(channel, async (input) => {
      said.push(await call(input, 'schedule_pause', { id: mine.id }));
      said.push(await call(input, 'schedule_list', {}));
      said.push(await call(input, 'schedule_update', { id: mine.id, prompt: 'Read all issues', resume: true }));
      said.push(await call(input, 'schedule_remove', { id: mine.id }));
      said.push(await call(input, 'schedule_pause', { id: theirs.id }));
      done = true;
      return 'done';
    });
    await waitFor(() => approval()?.kind === 'tool');
    expect(approval()).toMatchObject({ once: true, title: 'Turn on "Nightly triage": Run "Nightly triage" every day at 21:00 in this chat', detail: 'Read all issues' });
    h.session.answerApproval('yes');
    await waitFor(() => approval()?.title.startsWith('Remove'));
    expect(approval()).toMatchObject({ once: true, title: 'Remove "Nightly triage", which runs every day at 21:00 in this chat', detail: 'Read all issues' });
    expect(schedules.get(mine.id)).toMatchObject({ enabled: true, prompt: 'Read all issues' });
    h.session.answerApproval('yes');
    await waitFor(() => done);
    expect(said[0]).toBe('"Nightly triage" is paused.');
    expect(said[1]).toContain(mine.id);
    expect(said[1]).not.toContain(theirs.id);
    expect(said[1]).toContain('Paused by your agent');
    expect(said[4]).toBe('This chat has no schedule with that id. Call schedule_list.');
    expect(schedules.get(mine.id)).toBeUndefined();
    expect(schedules.get(theirs.id)).toMatchObject({ enabled: true });
  });

  it('a scheduled run has list and pause, and no create, update or remove', { timeout: 20_000 }, async () => {
    const schedules = h.launch();
    const channel = await h.chat();
    const made = schedules.create(channel, { title: 'Check', prompt: 'Look', when: { kind: 'interval', minutes: 1 } });
    const before = h.runs.length;
    let names: string[] = [];
    h.script.run = async (input) => {
      names = createScheduleToolDefs(input.scheduleTools!).map((d) => d.name);
      return 'done';
    };
    schedules.runNow(made.id);
    await waitFor(() => h.runs.length > before && names.length > 0);
    expect(names).toEqual(['schedule_list', 'schedule_pause']);
    expect(h.runs.at(-1)!.scheduleBrief).toBeDefined();
    expect(h.runs.at(-1)!.scheduleToolsBrief).toMatch(/cannot make, change or remove/);
  });

  it('a friend\'s request in the same chat gets no tools; your own does', { timeout: 20_000 }, async () => {
    h.launch();
    const channel = await h.chat();
    const seen: Array<AgentRunInput['scheduleTools']> = [];
    h.script.run = async (input) => (seen.push(input.scheduleTools), 'done');
    // Past the check that the friend may post here, so only the owner check can keep the tools from them.
    vi.spyOn(h.session.sharing, 'canPost').mockReturnValue(true);
    void h.session.host.onAgentRequest('friend', { kind: 'agent_request', requestId: 'from-friend', prompt: 'make a schedule', viaAgent: false, channel, urgent: false, plan: false });
    await waitFor(() => seen.length === 1);
    expect(seen[0]).toBeUndefined();
    h.session.askOwnClaude('make a schedule', channel, false, false);
    await waitFor(() => seen.length === 2);
    expect(seen[1]).toBeDefined();
  });

  it('the chats that cannot have a schedule, and the setting off, get no tools', { timeout: 20_000 }, async () => {
    const channel = await h.chat();
    h.launch(false);
    let tools: unknown = 'not run';
    await inRun(channel, async (input) => ((tools = input.scheduleTools), 'done'));
    await waitFor(() => tools !== 'not run');
    expect(tools).toBeUndefined();
    h.launch(true);
    tools = 'not run';
    await inRun('room', async (input) => ((tools = input.scheduleTools), 'done'));
    await waitFor(() => tools !== 'not run');
    expect(tools).toBeUndefined();
    tools = 'not run';
    await inRun(channel, async (input) => ((tools = input.scheduleTools), 'done'));
    await waitFor(() => tools !== 'not run');
    expect(tools).toBeDefined();
  });
});
