import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentBackend, AgentRunInput } from '../src/agent/types.js';
import { AgentHost } from '../src/core/agent-host.js';
import type { Issue } from '../src/core/board/model.js';
import { Store, initialState } from '../src/core/store.js';
import { waitFor } from './helpers.js';
import { TASK_LINK_SCHEME, type TaskMention, explainTaskMentions, linkTaskKeys, matchTasks, splitTaskKeys, taskByKey } from '../src/shared/task-refs.js';
import { readInline } from '../src/shared/render/inline-model.js';
import { stripCode } from '../src/companion/strip.js';
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
    // The number alone: every project's task with that number (Ready ones first), then longer numbers.
    expect(keys('24')).toEqual(['OPS-24', 'BLG-24', 'BLG-240']);
    expect(keys('bl24')[0]).toBe('BLG-24');
  });

  it('a project prefix lists its tasks, Ready ones first, each group by number', () => {
    expect(keys('BLG')).toEqual(['BLG-2', 'BLG-9', 'BLG-240', 'BLG-24', 'BLG-20']);
    expect(keys('ops')).toEqual(['OPS-24']);
  });

  it('words of the title', () => {
    expect(keys('login')).toEqual(['BLG-240', 'BLG-24']);
    expect(keys('coffee')).toEqual(['BLG-9']);
    expect(keys('dark-mode')).toEqual(['BLG-20']);
    expect(keys('ogin')).toEqual(['BLG-240', 'BLG-24']);
  });

  it('Ready tasks first, then those under way, then the Backlog, then closed ones (BLG-575)', () => {
    const board = [
      t('BLG-1', 'Old idea', 'backlog'),
      t('BLG-3', 'Shipped', 'done', false),
      t('BLG-4', 'Being built', 'in_progress'),
      t('BLG-5', 'Ready to go'),
      t('BLG-6', 'Up for review', 'in_review'),
      t('BLG-7', 'Also ready'),
      t('BLG-8', 'Dropped', 'canceled', false),
    ];
    expect(matchTasks('BLG', board, 10).map((x) => x.key)).toEqual(['BLG-5', 'BLG-7', 'BLG-4', 'BLG-6', 'BLG-1', 'BLG-3', 'BLG-8']);
    // The very key typed still comes first, whatever its status.
    expect(matchTasks('BLG-1', [...board, t('BLG-10', 'Ready ten')], 10).map((x) => x.key)).toEqual(['BLG-1', 'BLG-10']);
    // Only six fit: they are the Ready ones.
    const many = Array.from({ length: 12 }, (_, i) => t(`BLG-${i + 1}`, `Task ${i + 1}`, i < 6 ? 'backlog' : 'todo'));
    expect(matchTasks('BLG', many).map((x) => x.key)).toEqual(['BLG-7', 'BLG-8', 'BLG-9', 'BLG-10', 'BLG-11', 'BLG-12']);
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
    expect(suggest('@bl24', ctx)[0]).toMatchObject({ value: '@BLG-24 ' });
    const mixed = suggest('@mi', { ...ctx, tasks: [t('BLG-3', 'Mirror the menu')] });
    expect(mixed.map((s) => [s.label, Boolean(s.task)])).toEqual([['@mia', false], ['@claude:mia', false], ['@BLG-3', true]]);
  });

  it('the exact key typed is still offered, so Return completes it instead of picking a neighbour', () => {
    expect(suggest('@BLG-24', ctx)[0]).toMatchObject({ label: '@BLG-24', value: '@BLG-24 ' });
    expect(suggest('@BLG-24 ', ctx)).toEqual([]);
  });

  it('no tasks without a board', () => {
    expect(suggest('@BLG-2', { peers: [], selfId: 'me' })).toEqual([]);
  });
});

describe('another project’s tasks in the "@" list (BLG-397)', () => {
  const away = (task: TaskMention): TaskMention => ({ ...task, elsewhere: 'Ratel' });
  const board = [t('BLG-24', 'Fix the login redirect'), t('BLG-25', 'Login page polish'), away(t('RAT-4', 'Login with Google')), away(t('RAT-12', 'Billing page')), away(t('RAT-240', 'Rate limits'))];
  const ctx = { peers: [], selfId: 'me', tasks: board, projects: [{ name: 'Ratel' }] };
  const labels = (typed: string): string[] => suggest(typed, ctx).map((s) => s.label);

  it('not for the first couple of letters, nor for a number alone', () => {
    expect(labels('@ra')).toEqual(['@Ratel']);
    expect(labels('@lo')).toEqual(['@BLG-24', '@BLG-25']);
    expect(labels('@log')).toEqual(['@BLG-24', '@BLG-25']);
    expect(labels('@4')).toEqual([]);
    expect(labels('@24')).toEqual(['@BLG-24']);
  });

  it('its whole prefix, or four letters of a word of the title, offers it, always last', () => {
    expect(labels('@RAT-4')).toEqual(['@RAT-4']);
    expect(labels('@rat12')).toEqual(['@RAT-12']);
    expect(labels('@RAT')).toEqual(['@Ratel', '@RAT-4', '@RAT-12', '@RAT-240']);
    expect(labels('@login')).toEqual(['@BLG-24', '@BLG-25', '@RAT-4']);
    expect(suggest('@login', ctx).at(-1)).toMatchObject({ task: { key: 'RAT-4', elsewhere: 'Ratel' } });
  });

  it('only a few of them, below this project’s', () => {
    const many = Array.from({ length: 10 }, (_, i) => away(t(`RAT-${i + 1}`, `Task ${i + 1}`)));
    expect(suggest('@RAT', { ...ctx, tasks: many }).filter((s) => s.task)).toHaveLength(3);
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

describe('bare task keys in an answer', () => {
  const board = new Set(['BLG-72', 'BLG-73']);
  const has = (k: string): boolean => board.has(k);
  const link = (k: string): string => `[${k}](beluga-task:${k})`;

  it('turns a key the board has into a chip, in bold and in a list', () => {
    expect(linkTaskKeys('**BLG-72: image chips**', has)).toBe(`**${link('BLG-72')}: image chips**`);
    expect(linkTaskKeys('- fixed (BLG-73), and BLG-72.', has)).toBe(`- fixed (${link('BLG-73')}), and ${link('BLG-72')}.`);
  });

  it('leaves unknown keys, look-alikes and lower case alone', () => {
    expect(linkTaskKeys('BLG-99, UTF-8, blg-72, XBLG-72, BLG-720', has)).toBe('BLG-99, UTF-8, blg-72, XBLG-72, BLG-720');
  });

  it('leaves code, links, paths, URLs and task: alone', () => {
    const md = ['`BLG-72` and `task:BLG-72`', '[see BLG-72](https://x.dev/BLG-72)', 'docs/BLG-72.md and BLG-72.ts', 'https://x.dev/issues/BLG-72', '```', 'BLG-72', '```', '@BLG-72 and #BLG-72'].join('\n');
    expect(linkTaskKeys(md, has)).toBe(md);
  });

  it('links outside the code on a line that has some', () => {
    expect(linkTaskKeys('BLG-72 fixed in `chat.ts`', has)).toBe(`${link('BLG-72')} fixed in \`chat.ts\``);
  });

  it('with mentions: "@BLG-72" (any case) is a chip too, but not in an address, code or a link (BLG-109)', () => {
    const o = { mentions: true };
    expect(linkTaskKeys('see @BLG-72 and @blg-73.', has, o)).toBe(`see ${link('BLG-72')} and ${link('BLG-73')}.`);
    expect(linkTaskKeys('@BLG-72, BLG-73', has, o)).toBe(`${link('BLG-72')}, ${link('BLG-73')}`);
    expect(linkTaskKeys('me@BLG-72.dev `@BLG-72` [@BLG-72](https://x.dev) @BLG-99', has, o)).toBe('me@BLG-72.dev `@BLG-72` [@BLG-72](https://x.dev) @BLG-99');
    // Without the option "@BLG-72" stays as the Mac's mentions read it.
    expect(linkTaskKeys('@BLG-72', has)).toBe('@BLG-72');
  });

  it('leaves fenced code alone', () => {
    const md = 'BLG-72\n```\nBLG-72\n```\n~~~\n@BLG-73\n~~~';
    expect(linkTaskKeys(md, has, { mentions: true })).toBe(`${link('BLG-72')}\n\`\`\`\nBLG-72\n\`\`\`\n~~~\n@BLG-73\n~~~`);
  });
});

/** The phone's words with chips in them (BLG-109): the same reading, cut into pieces. */
describe('splitTaskKeys', () => {
  const has = (k: string): boolean => k === 'BLG-98' || k === 'BLG-12';

  it('cuts words around the keys the board has', () => {
    expect(splitTaskKeys('BLG-98 is done, @blg-12 next', has, { mentions: true })).toEqual([{ key: 'BLG-98' }, { text: ' is done, ' }, { key: 'BLG-12' }, { text: ' next' }]);
  });

  it('leaves unknown keys and look-alikes as words', () => {
    expect(splitTaskKeys('BLG-7, UTF-8 and ISO-8601', has)).toEqual([{ text: 'BLG-7, UTF-8 and ISO-8601' }]);
    expect(splitTaskKeys('', has)).toEqual([]);
  });

  it('task: in inline code is the inline element’s, not a bare key (shared readInline)', () => {
    expect(splitTaskKeys('`task:BLG-98` and src/BLG-98.ts', has)).toEqual([{ text: '`task:BLG-98` and src/BLG-98.ts' }]);
    expect(readInline('task:BLG-98')).toEqual({ kind: 'task', key: 'BLG-98' });
  });

  it('stripCode keeps `task:KEY` in a sentence for the phone to draw, and folds keys inside code blocks away', () => {
    const prose = stripCode('Fixed `task:BLG-98` and BLG-12.\n\n```ts\nconst k = "BLG-12";\n```\n\n```beluga-tasks\nBLG-98\n```');
    expect(prose.text.split('\n')[0]).toBe('Fixed `task:BLG-98` and BLG-12.');
    expect(prose.code[0]).toEqual({ lang: 'ts', lines: 1 });
    expect(prose.code[1]).toEqual({ lang: 'beluga-tasks', lines: 1, block: { kind: 'tasks', text: 'BLG-98' } });
    // What the phone then links: the bare key, not the code's, not the inline element's.
    expect(linkTaskKeys(prose.text, has)).toContain(`and [BLG-12](${TASK_LINK_SCHEME}BLG-12).`);
    expect(linkTaskKeys(prose.text, has)).toContain('`task:BLG-98`');
  });
});
