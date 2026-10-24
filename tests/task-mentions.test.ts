import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentBackend, AgentRunInput } from '../src/agent/types.js';
import { AgentHost } from '../src/core/agent-host.js';
import type { Issue } from '../src/core/board/model.js';
import { Store, initialState } from '../src/core/store.js';
import { waitFor } from './helpers.js';
import { type TaskMention, explainTaskMentions, matchTasks, taskByKey } from '../src/shared/task-refs.js';
import { suggest } from '../src/ui/suggest.js';
import { gatewayTarget } from '../src/agent/mock.js';
import { linkMentions, parseMentionHref, resolveMention, splitMentions, tasksIn, type MentionWorld } from '../packages/mac/src/chat/mentions.js';

/** "@BLG-24" names a task on the board (BLG-56): suggested as you type, a chip once it's there. */

const t = (key: string, title: string, status = 'todo', open = true): TaskMention => ({ key, title, status, open });
const tasks: TaskMention[] = [
  t('BLG-2', 'Pair a phone'),
  t('BLG-20', 'Dark mode for the board', 'done', false),
  t('BLG-24', 'Fix the login redirect', 'in_progress'),
  t('BLG-240', 'Login with a passkey'),
  t('BLG-9', 'Buy coffee developer option'),
  t('OPS-24', 'Rotate the deploy keys'),
];
const keys = (typed: string): string[] => matchTasks(typed, tasks).map((x) => x.key);

describe('which tasks a typed "@…" may mean', () => {
  it('the very key first, then the keys it starts', () => {
    expect(keys('BLG-24')).toEqual(['BLG-24', 'BLG-240']);
    expect(keys('BLG-2')).toEqual(['BLG-2', 'BLG-240', 'BLG-24', 'BLG-20']);
  });

  it('did you mean: no dash, lower case, or the number alone', () => {
    expect(keys('BLG24')[0]).toBe('BLG-24');
    expect(keys('blg-24')[0]).toBe('BLG-24');
    expect(keys('blg24')[0]).toBe('BLG-24');
    // The number alone: every project's task with that number, then longer numbers.
    expect(keys('24')).toEqual(['BLG-24', 'OPS-24', 'BLG-240']);
    expect(keys('bl24')[0]).toBe('BLG-24');
  });

  it('a project prefix lists its tasks, open ones first and newest first', () => {
    expect(keys('BLG')).toEqual(['BLG-240', 'BLG-24', 'BLG-9', 'BLG-2', 'BLG-20']);
    expect(keys('ops')).toEqual(['OPS-24']);
  });

  it('words of the title', () => {
    expect(keys('login')).toEqual(['BLG-240', 'BLG-24']);
    expect(keys('coffee')).toEqual(['BLG-9']);
    expect(keys('dark-mode')).toEqual(['BLG-20']);
    expect(keys('ogin')).toEqual(['BLG-240', 'BLG-24']);
  });

  it('nothing for nothing, and never too many', () => {
    expect(keys('')).toEqual([]);
    expect(keys('7')).toEqual([]);
    expect(keys('zzz')).toEqual([]);
    expect(keys('b')).toEqual([]);
    const many = Array.from({ length: 30 }, (_, i) => t(`BLG-${i + 1}`, `Task ${i + 1}`));
    expect(matchTasks('BLG', many)).toHaveLength(6);
  });

  it('an exact key in any case names its task; anything else names none', () => {
    expect(taskByKey('blg-24', tasks)?.title).toBe('Fix the login redirect');
    expect(taskByKey('BLG24', tasks)).toBeUndefined();
    expect(taskByKey('BLG-99', tasks)).toBeUndefined();
  });
});

describe('the "@" list offers tasks', () => {
  const ctx = { peers: [], selfId: 'me', tasks, friends: [{ name: 'mia', online: true }] };

  it('in a Tasks section after people, each completing to its key', () => {
    const list = suggest('look at @BLG-2', ctx);
    expect(list.map((s) => s.label)).toEqual(['@BLG-2', '@BLG-240', '@BLG-24', '@BLG-20']);
    expect(list[2]).toMatchObject({ value: 'look at @BLG-24 ', hint: 'Fix the login redirect', task: { key: 'BLG-24', status: 'in_progress' } });
    expect(suggest('@24', ctx)[0]).toMatchObject({ value: '@BLG-24 ' });
    const mixed = suggest('@mi', { ...ctx, tasks: [t('BLG-3', 'Mirror the menu')] });
    expect(mixed.map((s) => [s.label, Boolean(s.task)])).toEqual([['@mia', false], ['@BLG-3', true]]);
  });

  it('the exact key typed is still offered, so Return completes it instead of picking a neighbour', () => {
    expect(suggest('@BLG-24', ctx)[0]).toMatchObject({ label: '@BLG-24', value: '@BLG-24 ' });
    expect(suggest('@BLG-24 ', ctx)).toEqual([]);
  });

  it('no tasks without a board', () => {
    expect(suggest('@BLG-2', { peers: [], selfId: 'me' })).toEqual([]);
  });
});

describe('a task mention in the words', () => {
  const world: MentionWorld = { friends: [{ name: 'mia', peerId: 'mia-1' }], peers: [], projects: [], workspaces: [], tasks };

  it('is a task chip when the key is on the board, picked or typed', () => {
    expect(resolveMention('BLG-24', world)).toEqual({ kind: 'task', label: 'BLG-24', id: 'BLG-24' });
    expect(resolveMention('blg-24', world)).toEqual({ kind: 'task', label: 'BLG-24', id: 'BLG-24' });
    expect(resolveMention('BLG-99', world)).toBeUndefined();
    expect(resolveMention('BLG-24', { ...world, tasks: undefined })).toBeUndefined();
    expect(splitMentions('@mia see @BLG-24, then @BLG-99.', world)).toEqual([
      { raw: '@mia', ref: { kind: 'friend', label: 'mia', id: 'mia-1' } },
      { text: ' see ' },
      { raw: '@BLG-24', ref: { kind: 'task', label: 'BLG-24', id: 'BLG-24' } },
      { text: ', then @BLG-99.' },
    ]);
  });

  it('becomes a link the message draws as the live task chip', () => {
    const md = linkMentions('fix @BLG-24 please', world);
    const href = /\]\(([^)]+)\)/.exec(md)?.[1] ?? '';
    expect(parseMentionHref(href)).toEqual({ kind: 'task', label: 'BLG-24', id: 'BLG-24' });
  });

  it('the box lists each task it names once, for the chips above it', () => {
    expect(tasksIn('@BLG-24 and @blg-24 and @OPS-24 and @BLG-99', world)).toEqual(['BLG-24', 'OPS-24']);
    expect(tasksIn('no tasks here', world)).toEqual([]);
  });
});

describe('what Claude reads', () => {
  const find = (key: string) => tasks.find((x) => x.key === key);

  it('keeps "@BLG-24" and says which task it is', () => {
    expect(explainTaskMentions('Look at @BLG-24, and @blg-9.', find)).toBe('Look at @BLG-24 (task: Fix the login redirect), and @blg-9 (task: Buy coffee developer option).');
    expect(explainTaskMentions('(@OPS-24)', find)).toBe('(@OPS-24 (task: Rotate the deploy keys))');
  });

  it('a task is nobody to ask (the demo Claude asks the friend after it instead)', () => {
    expect(gatewayTarget(explainTaskMentions('pick up @BLG-24 next', find))).toBeUndefined();
    expect(gatewayTarget(explainTaskMentions('@BLG-24 is done, @mia have a look', find))?.person).toBe('mia');
  });

  it('leaves unknown keys, e-mail addresses, code and what is already explained alone', () => {
    expect(explainTaskMentions('@BLG-99 and me@BLG-24', find)).toBe('@BLG-99 and me@BLG-24');
    expect(explainTaskMentions('```\n@BLG-24\n```', find)).toBe('```\n@BLG-24\n```');
    const once = explainTaskMentions('@BLG-24', find);
    expect(explainTaskMentions(once, find)).toBe(once);
    expect(explainTaskMentions('no mentions', find)).toBe('no mentions');
  });
});

describe('your Claude, asked about a task', () => {
  it('reads "@BLG-24 (task: …)" while the chat keeps what you wrote', async () => {
    const store = new Store(initialState('room', 'auto'));
    const issue = { id: 'i1', key: 'BLG-24', number: 24, projectId: 'p', title: 'Fix the login redirect', status: 'todo' } as unknown as Issue;
    store.dispatch({ type: 'board_init', state: { enabled: true, issues: [issue], projects: {}, autoTasks: false } });
    const runs: AgentRunInput[] = [];
    const agent: AgentBackend = { run: async (input: AgentRunInput) => (runs.push(input), 'ok') };
    const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-task-mention-'));
    const host = new AgentHost({
      store,
      selfId: () => 'me',
      send: () => true,
      agent: () => agent,
      shares: {} as never,
      sharing: { recipients: () => [], sharedFor: () => undefined, canPost: () => true } as never,
      people: {} as never,
      questions: { track: () => undefined, ask: async () => ({ kind: 'skip' }), cancelAll: () => undefined, cancelChannel: () => undefined } as never,
      toast: () => undefined,
      system: () => undefined,
      approvalTimeoutMs: () => 60_000,
      refreshUsage: async () => undefined,
      workspaces: { place: () => ({ cwd: dir, additionalDirectories: [], autoEdit: true, onSession: () => undefined }), refreshWorkspace: async () => undefined, manager: { list: [] } } as never,
    });
    await host.onAgentRequest('me', { kind: 'agent_request', requestId: 'r1', prompt: 'finish @BLG-24 today', viaAgent: false, channel: 'ws:w1', urgent: false, plan: false });
    await waitFor(() => runs.length === 1);
    expect(runs[0]!.prompt).toBe('finish @BLG-24 (task: Fix the login redirect) today');
  });
});
