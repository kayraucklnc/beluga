import { describe, expect, it, vi } from 'vitest';
import { BackgroundAgents, PromptQueue, TurnRouter } from '../src/agent/live-run.js';
import type { AgentRunInput, FollowUp, RoomBridge } from '../src/agent/types.js';

/** A scripted Claude Code: for each prompt it reads, it yields the next scripted turn. */
type Turn = (prompt: string) => object[];
const script: { turns: Turn[]; extra: object[][]; prompts: string[] } = { turns: [], extra: [], prompts: [] };

vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...(await original<object>()),
  query: ({ prompt }: { prompt: AsyncIterable<{ message: { content: string } }> }) =>
    (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's1' };
      let turn = 0;
      for await (const msg of prompt) {
        script.prompts.push(msg.message.content);
        for (const m of script.turns[turn++]?.(msg.message.content) ?? []) yield m;
        // Turns Claude starts by itself once a background agent is done.
        for (const extra of script.extra.splice(0)) for (const m of extra) yield m;
      }
    })(),
}));

const { createClaudeBackend } = await import('../src/agent/runner.js');

const text = (t: string) => ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: t }] } });
const result = (r: string) => ({ type: 'result', subtype: 'success', result: r, session_id: 's1', modelUsage: {}, total_cost_usd: 0 });
const tasks = (...ids: string[]) => ({ type: 'system', subtype: 'background_tasks_changed', tasks: ids.map((task_id) => ({ task_id, task_type: 'local_agent', description: 'job' })) });

const bridge = { selfName: () => 'kay', reportUsage: () => undefined } as unknown as RoomBridge;

function runInput(over: Partial<AgentRunInput> = {}): AgentRunInput & { events: string[] } {
  const events: string[] = [];
  return {
    prompt: 'build it',
    requesterName: 'kay',
    viaAgent: false,
    context: [],
    scope: 'full',
    signal: new AbortController().signal,
    onEvent: (kind, t) => void (kind === 'text' && events.push(t)),
    onFileTouched: () => undefined,
    canUseTool: async () => true,
    events,
    ...over,
  };
}

describe('PromptQueue', () => {
  it('yields pushed prompts in order and ends once closed', async () => {
    const q = new PromptQueue();
    q.push('a');
    const seen: string[] = [];
    const reading = (async () => {
      for await (const m of q) seen.push(m.message.content as string);
    })();
    q.push('b');
    await new Promise((r) => setTimeout(r, 5));
    q.close();
    await reading;
    expect(seen).toEqual(['a', 'b']);
    expect(q.push('c')).toBe(false);
  });
});

describe('BackgroundAgents', () => {
  it('follows the level signal, ignoring shells and ambient watchers', () => {
    const bg = new BackgroundAgents();
    bg.observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'sh', task_type: 'local_bash' }, { task_id: 'w', task_type: 'local_agent', ambient: true }] });
    expect(bg.busy).toBe(false);
    bg.observe(tasks('a'));
    expect(bg.busy).toBe(true);
    bg.observe(tasks());
    expect(bg.busy).toBe(false);
    bg.observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'sh2', task_type: 'local_bash', parent_task_id: 'a' }] });
    expect(bg.busy).toBe(true); // an agent's own shell: the agent will come back for it
  });

  it('falls back to start/finish edges', () => {
    const bg = new BackgroundAgents();
    bg.observe({ type: 'system', subtype: 'task_started', task_id: 'a', task_type: 'local_agent' });
    expect(bg.busy).toBe(true);
    bg.observe({ type: 'system', subtype: 'task_notification', task_id: 'a', status: 'completed' });
    expect(bg.busy).toBe(false);
  });
});

describe('TurnRouter', () => {
  it('gives follow-ups the next turns and self-started turns to the original', () => {
    const got: string[] = [];
    const route = (name: string) => ({ onEvent: () => undefined, onDone: (t: string) => void got.push(`${name}:${t}`), onError: (r: string) => void got.push(`${name}!${r}`) });
    const original = { onEvent: () => undefined };
    const turns = new TurnRouter(original);
    expect(turns.current()).toBe(original);
    turns.end(true, 'first');
    const a = route('a');
    turns.queue(a);
    expect(turns.waiting).toBe(true);
    expect(turns.current()).toBe(a);
    turns.end(true, 'for a');
    expect(turns.current()).toBe(original); // a background agent finished; Claude reports on its own
    turns.end(true, 'agents done');
    turns.queue(route('b'));
    turns.failPending('closed');
    expect(got).toEqual(['a:for a', 'b!closed']);
    expect(turns.answers).toEqual(['first', 'agents done']);
  });
});

describe('live runs', () => {
  it('ends right after answering when nothing runs in the background', async () => {
    script.turns = [() => [text('hi'), result('hi')]];
    script.prompts = [];
    const offers: unknown[] = [];
    const out = await createClaudeBackend({ cwd: '/tmp', autoEdit: false, additionalDirectories: [], bridge }).run(runInput({ onFollowUps: (s) => void offers.push(s) }));
    expect(out).toBe('hi');
    expect(offers).toEqual([]);
  });

  it('stays open while background agents work, takes follow-ups, and ends when they finish', async () => {
    let send: ((f: FollowUp) => boolean) | undefined;
    const replies: string[] = [];
    script.prompts = [];
    script.turns = [
      () => [tasks('job'), text('started 1 job'), result('started 1 job')],
      () => {
        // The job finishes while Claude answers the follow-up; it then reports on its own.
        script.extra.push([tasks(), text('job finished'), result('job finished')]);
        return [text('sure'), result('sure')];
      },
    ];
    const input = runInput({ onFollowUps: (s) => void (send = s) });
    const done = createClaudeBackend({ cwd: '/tmp', autoEdit: false, additionalDirectories: [], bridge }).run(input);
    await vi.waitFor(() => expect(send).toBeDefined());
    const followUp = { prompt: 'also this', requesterName: 'kay', viaAgent: false, context: [], onEvent: () => undefined, onDone: (t: string) => void replies.push(t), onError: (r: string) => void replies.push(`error: ${r}`) };
    expect(send!(followUp)).toBe(true);
    expect(await done).toBe('started 1 job\n\njob finished');
    expect(replies).toEqual(['sure']);
    expect(input.events).toEqual(['started 1 job', 'job finished']);
    expect(script.prompts[1]).toContain('also this');
    expect(send).toBeUndefined(); // closed again
  });
});
