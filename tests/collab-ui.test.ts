import { describe, expect, it } from 'vitest';
import { cleanName, cleanPlanTitle, slugify } from '../src/agent/namer.js';
import { toQuestion } from '../src/agent/runner.js';
import { cleanQuestion } from '../src/core/questions.js';
import { type AppState } from '../src/core/store.js';
import { initialAppState as initialState, reduceApp as reduce } from '../src/client/screen.js';
import { clearMenu, invitePersonMenu, sharedMenu, wsShareMenu } from '../src/ui/collab-menus.js';
import { initialUi, handleKey, type KeyContext } from '../src/ui/keymap.js';
import { personMenu } from '../src/ui/menus.js';
import { shareFolderMenu, shareWhoMenu } from '../src/ui/share-menus.js';
import { workspaceHeaderModel } from '../src/ui/workspace-models.js';
import type { Project, Workspace } from '../src/workspaces/types.js';

const text = (lines: readonly (readonly { text: string }[])[]) => lines.map((l) => l.map((s) => s.text).join(''));
const ws: Workspace = { id: 'w1', projectRoot: '/p', name: 'add-auth', path: '/wt', kind: 'worktree', branch: 'klaud/add-auth', createdAt: 1, projectId: 'p1', external: false, status: { changed: 0, ahead: 1, behind: 0 } };
const project: Project = { id: 'p1', name: 'api', root: '/p', base: 'origin/main', workspaces: [ws] };

function room(host = true): AppState {
  let s = reduce(initialState('r'), { type: 'projects', projects: [project] });
  const me = { peerId: 'me', name: 'kay', shares: [], agent: true, ...(host ? { host: true } : {}) };
  s = reduce(s, { type: 'welcome', self: me });
  return reduce(s, { type: 'peers', peers: [me, { peerId: 'b', name: 'bob', shares: [], agent: true }] });
}

describe('worktree names', () => {
  it('cleans what the model says and falls back to the task words', () => {
    expect(cleanName('fix-login-redirect')).toBe('fix-login-redirect');
    expect(cleanName('`Add Stripe Webhooks`\nbecause…')).toBe('add-stripe-webhooks');
    expect(cleanName('!!')).toBeUndefined();
    expect(slugify('Please add a dark mode toggle to the settings page')).toBe('add-dark-mode-toggle');
    expect(slugify('???')).toMatch(/^task-/);
  });
});

describe('plan names (KLD-28)', () => {
  it('keeps a short name out of what the model says', () => {
    expect(cleanPlanTitle('"Calmer plan drafting screen."')).toBe('Calmer plan drafting screen');
    expect(cleanPlanTitle('Title: card checkout for launch\nBecause…')).toBe('Card checkout for launch');
    expect(cleanPlanTitle('one two three four five six seven eight')).toBe('One two three four five six');
    expect(cleanPlanTitle('Here is a name for this plan that I think captures what you are trying to do overall')).toBeUndefined();
    expect(cleanPlanTitle('  ')).toBeUndefined();
  });
});

describe("Claude's question card", () => {
  it('strips terminal control sequences from questions friends send', () => {
    const q = cleanQuestion({ kind: 'question', questions: [{ question: 'Q\u001b]0;x\u0007?', header: '\u009bH', multiSelect: false, options: [{ label: 'A\u001b[2J', description: '' }] }] });
    expect(JSON.stringify(q)).not.toMatch(/[\u001b\u0007\u009b]/);
    expect(cleanQuestion({ kind: 'plan', plan: 'ok\u001bc' })).toEqual({ kind: 'plan', plan: 'okc' });
  });

  it('turns AskUserQuestion input into a question and drops junk', () => {
    expect(toQuestion({ questions: [{ question: 'Q?', header: 'H', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B' }] }] })?.kind).toBe('question');
    expect(toQuestion({ questions: 'nope' })).toBeUndefined();
  });

  it('number keys pick an option while the composer is empty', () => {
    const ctx: KeyContext = { hasApproval: false, hasViewer: false, overlay: false, page: 20, maxChatScroll: 0, suggestions: [], peopleCount: 1, menuSize: 0, questionOptions: 2 };
    expect(handleKey(initialUi, '2', {}, ctx).effect).toEqual({ type: 'question_number', n: 2 });
    expect(handleKey(initialUi, '3', {}, ctx).effect).toBeUndefined();
    expect(handleKey({ ...initialUi, buffer: 'x', cursor: 1 }, '2', {}, ctx).ui.buffer).toBe('x2');
  });
});

describe('sharing and people', () => {
  it('the workspace header has Share (plan mode lives on the input box: Shift+Tab)', () => {
    const m = workspaceHeaderModel(room(), ws, 140);
    expect(text(m.lines)[1]).not.toContain('Plan');
    expect(text(m.lines)[1]).toContain('Share');
    const shared = reduce(room(), { type: 'member_set', id: 'w1', peerId: 'b', role: 'contribute' });
    expect(text(workspaceHeaderModel(shared, ws, 140).lines)[1]).toContain('Shared · 1');
  });

  it('the Share menu invites, changes and removes people', () => {
    expect(wsShareMenu(room(), 'w1')!.options.map((o) => o.id)).toEqual(['ws-contribute:b', 'ws-view:b', 'ws-link', 'invite', 'close']);
    const inside = reduce(room(), { type: 'member_set', id: 'w1', peerId: 'b', role: 'contribute' });
    expect(wsShareMenu(inside, 'w1')!.options.map((o) => o.id)).toEqual(['ws-view:b', 'ws-remove:b', 'ws-link', 'invite', 'close']);
    expect(wsShareMenu(inside, 'w1')!.intro[0]).toContain('bob (working here)');
  });

  it('a workspace shared with you can be left', () => {
    const s = reduce(room(), { type: 'shared_add', ws: { owner: 'b', id: 'x9', name: 'payments', project: 'shop', role: 'view', share: 'ws-x9' } });
    expect(sharedMenu(s, 'b', 'x9')!.options.map((o) => o.id)).toContain('sh-leave');
  });

  it('only the host can clear the group chat for everyone; workspaces can start fresh', () => {
    expect(clearMenu(room(), 'room', true).options.map((o) => o.id)).toEqual(['clear-everyone', 'clear-mine', 'close']);
    expect(clearMenu(room(), 'room', false).options.map((o) => o.id)).toEqual(['clear-mine', 'close']);
    expect(clearMenu(room(), 'ws:w1', false).options.map((o) => o.id)).toEqual(['clear-mine', 'clear-fresh', 'close']);
  });

  it('the host can remove people and manage the invite; others can leave', () => {
    const host = room(true);
    expect(personMenu(host, 1)!.options.map((o) => o.id)).toContain('person-remove');
    expect(personMenu(reduce(host, { type: 'invite', invite: 'https://x#abcdefghijklmnopqr' }), 0)!.options.map((o) => o.id)).toEqual(expect.arrayContaining(['room-new-link', 'room-close']));
    const guest = room(false);
    expect(personMenu(guest, 1)!.options.map((o) => o.id)).not.toContain('person-remove');
    expect(personMenu(guest, 0)!.options.map((o) => o.id)).toContain('leave-room');
    expect(invitePersonMenu(host, 'b')!.options[0]).toMatchObject({ id: 'inv:w1', label: 'api › add-auth' });
  });

  it('sharing a folder: pick a folder, then everyone or one person', () => {
    const menu = shareFolderMenu(room(), '/home/kay/site', [{ name: 'notes', root: '/n', private: true, allowed: ['b'] }]);
    expect(menu.options.map((o) => o.id)).toEqual(['sf-dir:/home/kay/site', 'sf-dir:/p', 'sf-type', 'sf-stop:notes', 'close']);
    expect(menu.options.find((o) => o.id === 'sf-stop:notes')?.hint).toBe('with bob');
    expect(shareWhoMenu(room(), '/p').options.map((o) => o.id)).toEqual(['sw-all', 'sw-peer:b', 'sw-all-rw', 'close']);
  });
});

describe('plan full screen', () => {
  it('Ctrl+F opens it, arrows scroll, Esc closes', () => {
    const ctx: KeyContext = { hasApproval: false, hasViewer: false, overlay: false, page: 20, maxChatScroll: 0, suggestions: [], peopleCount: 1, menuSize: 0, planId: 'p1', planMaxScroll: 40 };
    const open = handleKey(initialUi, 'f', { ctrl: true }, ctx).ui;
    expect(open.planFull).toBe('p1');
    const scrolled = handleKey(open, '', { pageDown: true }, ctx).ui;
    expect(scrolled.planScroll).toBe(18);
    expect(handleKey(scrolled, '', { escape: true }, ctx).ui.planFull).toBeUndefined();
  });
});
