import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MacAssistant } from '../src/core/assistant/assistant.js';
import { pretendSystem } from '../src/core/gateway/demo-system.js';
import { keepsChat } from '../src/core/sentinel/model.js';
import type { SentinelPlaces } from '../src/core/sentinel/runner.js';
import { ToolDraftSchema, ToolPatchSchema } from '../src/core/sentinel/tool-draft.js';
import { fromToolDraft } from '../src/core/sentinel/sentinels.js';
import { Store, initialState } from '../src/core/store.js';
import type { AgentRef } from '../src/protocol.js';
import { tabChats } from '../src/shared/assistant.js';
import { type Asked, fakePlaces, setup, until } from './sentinel-fakes.js';

/**
 * BLG-566: an hourly sentinel stopped on its 30th run, because each run opened a Your Mac chat and
 * Open chats (30) refused the next. A run's chat is its run's now: not a tab, not counted, and each
 * sentinel keeps the runs' chats it's told to (every run, failed runs only, the latest only).
 */

const CODEX: AgentRef = { runtime: 'codex', label: 'Codex', model: 'gpt-5.5' };
const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), 'beluga-keep-chats-'));

function store(chatLimit: number): Store {
  const s = new Store(initialState('room', 'auto'));
  s.dispatch({ type: 'identity', selfId: 'me', isHost: true, home: '/Users/k' });
  s.dispatch({ type: 'prefs', prefs: { chatLimit } });
  return s;
}

const mac = (s: Store, dir = tmp()): MacAssistant => new MacAssistant({ store: s, dir, selfId: () => 'me', system: pretendSystem(), claudeDir: tmp() });

describe('Your Mac: a sentinel run’s chat', () => {
  it('is never refused by Open chats, nor counted against yours', () => {
    const s = store(30);
    const m = mac(s);
    for (let i = 0; i < 45; i++) m.newChat({ run: true });
    // 29 of your own still fit beside the first.
    for (let i = 0; i < 29; i++) m.newChat();
    expect(() => m.newChat()).toThrow(/30 Your Mac chats are open/);
  });

  it('leaves the chat you have open, open, and isn’t a tab unless it is the open one', () => {
    const s = store(30);
    const m = mac(s);
    const mine = m.newChat();
    const run = m.newChat({ run: true });
    const chats = s.getState().assistant;
    expect(chats.active).toBe(mine);
    expect(chats.chats.find((c) => c.id === run)?.run).toBe(true);
    expect(tabChats(chats).map((c) => c.id)).not.toContain(run);
    m.openChat(run);
    expect(tabChats(s.getState().assistant).map((c) => c.id)).toContain(run);
  });

  it('runs on the agent its step chose, and remembers it across a restart', () => {
    const dir = tmp();
    const s = store(30);
    const id = mac(s, dir).newChat({ run: true, agent: CODEX });
    const again = mac(store(30), dir);
    expect(again.place(`mac:assistant:${id}`).agent).toEqual(CODEX);
    expect(again.chats().chats.find((c) => c.id === id)?.run).toBe(true);
    // Your own chats run your default.
    expect(again.place(`mac:assistant:${again.newChat()}`).agent?.runtime).toBe('claude');
  });
});

describe('keepsChat', () => {
  const run = (id: string, state: 'done' | 'failed' | 'stopped' | 'running' | 'needs-you') => ({ id, state });
  it('every run; failed (and stopped) only; the latest only; never one still going', () => {
    expect(keepsChat('all', run('a', 'done'), 'b')).toBe(true);
    expect(keepsChat('failed', run('a', 'done'), 'a')).toBe(false);
    expect(keepsChat('failed', run('a', 'failed'), 'b')).toBe(true);
    expect(keepsChat('failed', run('a', 'stopped'), 'b')).toBe(true);
    expect(keepsChat('latest', run('a', 'failed'), 'b')).toBe(false);
    expect(keepsChat('latest', run('b', 'done'), 'b')).toBe(true);
    expect(keepsChat('latest', run('a', 'running'), 'b')).toBe(true);
    expect(keepsChat('failed', run('a', 'needs-you'), 'b')).toBe(true);
  });
});

/** Fake places that record what was put away and what a Your Mac chat was asked to run on. */
function places(changes = false) {
  const p = fakePlaces({ changes });
  const putAway: string[] = [];
  const macAgents: Array<AgentRef | undefined> = [];
  const all: SentinelPlaces = {
    ...p.places,
    macChat: (run) => {
      macAgents.push(run?.agent);
      return p.places.macChat(run);
    },
    putAway: async (channel) => void putAway.push(channel),
  };
  return { places: all, putAway, macAgents };
}

async function runOnce(s: ReturnType<typeof setup>, id: string): Promise<string> {
  const run = s.sentinels.start(id, 'you');
  await until(() => !['queued', 'running'].includes(s.sentinels.runGet(run.id).run.state));
  return run.id;
}

describe('a sentinel keeps the runs’ chats it’s told to', () => {
  const step = { kind: 'claude' as const, name: 'Look', where: 'project' as const, prompt: 'Look' };

  it('every run by default: nothing is put away', async () => {
    const p = places();
    const s = setup({ reply: () => 'ok', places: p.places });
    const made = s.sentinels.create({ name: 'Hourly', projectId: 'api', steps: [step] });
    for (let i = 0; i < 3; i++) await runOnce(s, made.id);
    expect(p.putAway).toEqual([]);
  });

  it('failed runs only: a run that went fine puts its chat away, a failed one keeps it', async () => {
    const p = places();
    let n = 0;
    const s = setup({
      places: p.places,
      reply: (a: Asked) => {
        if (++n !== 2) return 'ok';
        queueMicrotask(() => a.fail('It broke'));
        return undefined;
      },
    });
    const made = s.sentinels.create({ name: 'Hourly', projectId: 'api', steps: [step], keepChats: 'failed' });
    expect(made.keepChats).toBe('failed');
    const first = await runOnce(s, made.id);
    const second = await runOnce(s, made.id);
    await until(() => p.putAway.length === 1);
    expect(p.putAway).toEqual([s.sentinels.runGet(first).run.channel]);
    expect(s.sentinels.runGet(first).run.putAway).toBe(true);
    expect(s.sentinels.runGet(second).run.state).toBe('failed');
    expect(s.sentinels.runGet(second).run.putAway).toBeUndefined();
  });

  it('the latest only: each run puts the one before’s away', async () => {
    const p = places();
    const s = setup({ reply: () => 'ok', places: p.places });
    const made = s.sentinels.create({ name: 'Hourly', projectId: 'api', steps: [step], keepChats: 'latest' });
    const ids = [await runOnce(s, made.id), await runOnce(s, made.id), await runOnce(s, made.id)];
    await until(() => p.putAway.length === 2);
    expect(ids.map((id) => Boolean(s.sentinels.runGet(id).run.putAway))).toEqual([true, true, false]);
  });

  it('keeping fewer puts the older ones away at once, not at the next run', async () => {
    const p = places();
    const s = setup({ reply: () => 'ok', places: p.places });
    const made = s.sentinels.create({ name: 'Hourly', projectId: 'api', steps: [step] });
    await runOnce(s, made.id);
    await runOnce(s, made.id);
    expect(p.putAway).toEqual([]);
    s.sentinels.update(made.id, { keepChats: 'failed' });
    await until(() => p.putAway.length === 2);
  });

  it('never puts a worktree away: its work is yours', async () => {
    const p = places(true);
    const s = setup({ reply: () => 'ok', places: p.places, changes: true });
    const made = s.sentinels.create({ name: 'Fixer', projectId: 'api', access: 'work', steps: [{ ...step, where: 'worktree' }], keepChats: 'failed' });
    const id = await runOnce(s, made.id);
    expect(s.sentinels.runGet(id).run.worktreeId).toBeDefined();
    expect(p.putAway).toEqual([]);
  });

  it('a Your Mac step asks for a run’s own chat, on the agent the step chose (Codex too)', async () => {
    const p = places();
    const s = setup({ reply: () => 'ok', places: p.places });
    const made = s.sentinels.create({ name: 'Disk check', steps: [{ kind: 'claude', name: 'Look', where: 'mac', prompt: 'How full is the disk?', runtime: 'codex', model: 'gpt-5.5' }] });
    await runOnce(s, made.id);
    expect(p.macAgents).toEqual([CODEX]);
  });
});

describe('your agent sets it up too', () => {
  it('sentinel_create and sentinel_update take keepChats and a step’s agent', () => {
    const draft = ToolDraftSchema.parse({ name: 'Hourly', trigger: { kind: 'manual' }, steps: [{ kind: 'claude', name: 'Look', prompt: 'Look', where: 'mac', runtime: 'codex', model: 'gpt-5.5' }], keepChats: 'failed' });
    const made = fromToolDraft(draft);
    expect(made.keepChats).toBe('failed');
    expect(made.steps?.[0]).toMatchObject({ runtime: 'codex', model: 'gpt-5.5' });
    expect(ToolPatchSchema.parse({ keepChats: 'latest' }).keepChats).toBe('latest');
    expect(() => ToolPatchSchema.parse({ keepChats: 'some' })).toThrow();
  });
});
