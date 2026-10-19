import type { PendingQuestion } from '../core/collab-store.js';
import type { KlaudClient } from '../ipc/client.js';
import type { SharedTab } from '../core/store.js';
import { runInviteUiAction } from './invite-actions.js';
import type { MenuContext } from './menu-actions.js';
import type { MenuKind } from './menus.js';
import type { UiAction } from './workspace-models.js';

const MULTI = '#multi';
const SEP = '\u0000';

/** The question a card is showing now (the first one not answered yet). */
export function currentQuestion(q: PendingQuestion) {
  return q.question.kind === 'question' ? (q.question.questions.find((x) => q.picked[x.question] === undefined) ?? q.question.questions[0]) : undefined;
}

/** Record one answer; when every question has one, send them all to Claude. */
function record(client: KlaudClient, q: PendingQuestion, question: string, answer: string): void {
  // Work out the answers from what's picked so far plus this one, so it doesn't depend on when the pick arrives.
  const picked = { ...q.picked, [question]: answer };
  void client.api.questions.pick(q.qid, question, answer);
  if (q.question.kind !== 'question') return;
  const done = q.question.questions.every((x) => picked[x.question] !== undefined);
  if (!done) return;
  const answers = Object.fromEntries(Object.entries(picked).filter(([k]) => !k.endsWith(MULTI)));
  void client.api.questions.answer(q.qid, { kind: 'answers', answers });
}

/** A click (or number key) on a question card. */
export function answerQuestion(client: KlaudClient, action: Extract<UiAction, { type: 'answer' }>): void {
  const q = client.store.getState().questions.find((x) => x.qid === action.qid);
  if (!q) return;
  const answer = client.api.questions.answer;
  switch (action.pick) {
    case 'skip':
      return void answer(q.qid, { kind: 'skip' });
    case 'approve':
      return void answer(q.qid, { kind: 'plan', approve: true, feedback: '' });
    case 'revise':
      return void answer(q.qid, { kind: 'plan', approve: false, feedback: '' });
    case 'done': {
      if (!action.question) return;
      const chosen = (q.picked[action.question + MULTI] ?? '').split(SEP).filter(Boolean);
      return record(client, q, action.question, chosen.join(', ') || '(none)');
    }
    case 'option': {
      const current = currentQuestion(q);
      if (!current || !action.label) return;
      if (!current.multiSelect) return record(client, q, current.question, action.label);
      // Multi-select: toggle, then "Done" sends.
      const chosen = new Set((q.picked[current.question + MULTI] ?? '').split(SEP).filter(Boolean));
      if (chosen.has(action.label)) chosen.delete(action.label);
      else chosen.add(action.label);
      void client.api.questions.pick(q.qid, current.question + MULTI, [...chosen].join(SEP));
    }
  }
}

/** Typed text while a card is waiting: your own answer, or what to change in the plan. */
export function answerTyped(client: KlaudClient, q: PendingQuestion, text: string): void {
  if (q.question.kind === 'plan') return void client.api.questions.answer(q.qid, { kind: 'plan', approve: false, feedback: text });
  const current = currentQuestion(q);
  if (current) record(client, q, current.question, text);
}

/** Number keys pick options on the card (1 = first option). */
export function answerByNumber(client: KlaudClient, q: PendingQuestion, n: number): boolean {
  const current = currentQuestion(q);
  const option = current?.options[n - 1];
  if (!option) return false;
  answerQuestion(client, { type: 'answer', qid: q.qid, pick: 'option', label: option.label, question: current?.question });
  return true;
}

/** Open a workspace someone shared with you: its chat, files, read-only shell, or what changed. */
export function openShared(client: KlaudClient, owner: string, id: string, tab: SharedTab = 'chat'): void {
  const latest = client.store.getState();
  const w = latest.shared.find((x) => x.owner === owner && x.id === id);
  if (!w) return;
  client.store.dispatch({ type: 'view', view: { kind: 'shared', owner, id, tab } });
  if (tab === 'files') void client.api.files.browseTo({ owner, share: w.share, path: '' });
  // The shell starts by listing the top folder, so there's something to click right away.
  if (tab === 'terminal' && !latest.shells[id]?.entries.length) void client.api.shell.run(id, 'ls');
  if (tab === 'diff') void client.api.diff.load(id);
}

function runWorkspaceShare(ctx: MenuContext, wsId: string, id: string): boolean {
  const sharing = ctx.client.api.sharing;
  const [verb, peerId] = id.split(':') as [string, string | undefined];
  if (!peerId) return false;
  if (verb === 'ws-contribute' || verb === 'ws-view') {
    void sharing.invite(wsId, peerId, verb === 'ws-contribute' ? 'contribute' : 'view');
    ctx.patchUi({ menu: { menu: { kind: 'ws_share', id: wsId }, selected: 0 } });
    return true;
  }
  if (verb === 'ws-remove') {
    void sharing.remove(wsId, peerId);
    ctx.patchUi({ menu: { menu: { kind: 'ws_share', id: wsId }, selected: 0 } });
    return true;
  }
  return false;
}

/** Menu options for sharing, people and the room. Returns false when it isn't one of these. */
export function runCollabOption(ctx: MenuContext, menu: MenuKind, id: string): boolean {
  const { client, patchUi, typeInto } = ctx;
  const { api } = client;
  const latest = client.store.getState();
  if (menu.kind === 'ws_share' && runWorkspaceShare(ctx, menu.id, id)) return true;
  if (menu.kind === 'invite_person' && id.startsWith('inv:')) {
    void api.sharing.invite(id.slice(4), menu.peerId, 'contribute');
    return true;
  }
  if (menu.kind === 'share_folder' && id.startsWith('sf-dir:')) {
    patchUi({ menu: { menu: { kind: 'share_who', dir: id.slice('sf-dir:'.length) }, selected: 0 } });
    return true;
  }
  if (menu.kind === 'share_folder' && id.startsWith('sf-stop:')) {
    void api.session.unshareFolder(id.slice('sf-stop:'.length));
    return true;
  }
  if (menu.kind === 'share_who') {
    if (id === 'sw-all' || id === 'sw-all-rw') void api.session.shareFolder(menu.dir, id === 'sw-all-rw');
    else if (id.startsWith('sw-peer:')) void api.session.shareFolder(menu.dir, false, [id.slice('sw-peer:'.length)]);
    else return false;
    return true;
  }
  const peer = menu.kind === 'person' ? latest.peers[menu.index] : undefined;
  switch (id) {
    case 'sf-type':
      typeInto('/share ~/');
      return true;
    case 'sh-chat':
    case 'sh-files':
      if (menu.kind === 'shared') openShared(client, menu.owner, menu.id, id === 'sh-files' ? 'files' : 'chat');
      return true;
    case 'sh-leave':
      if (menu.kind === 'shared') void api.sharing.leave(menu.owner, menu.id);
      return true;
    case 'clear-everyone':
    case 'clear-mine':
    case 'clear-fresh':
      if (menu.kind === 'clear') void api.session.clearChat(menu.channel, { everyone: id === 'clear-everyone', fresh: id === 'clear-fresh' });
      return true;
    case 'person-invite-ws':
      if (peer) patchUi({ menu: { menu: { kind: 'invite_person', peerId: peer.peerId }, selected: 0 } });
      return true;
    case 'person-share':
    case 'share-folder':
      patchUi({ menu: { menu: { kind: 'share_folder', launchDir: client.launchDir, mine: latest.myShares }, selected: 0 } });
      return true;
    case 'person-remove':
      if (peer) void api.session.removePerson(peer.peerId);
      return true;
    case 'room-new-link':
      void api.session.newInviteLink();
      return true;
    case 'room-close':
    case 'room-open':
      void api.session.setRoomOpen(id === 'room-open');
      return true;
    case 'leave-room':
      void api.session.quit();
      return true;
    default:
      return false;
  }
}

/** UI actions for collaboration (question cards, shared workspaces, plan mode, sharing). */
export function runCollabUiAction(ctx: MenuContext, action: UiAction): boolean {
  const { client, patchUi } = ctx;
  if (runInviteUiAction(client, action)) return true;
  switch (action.type) {
    case 'answer':
      answerQuestion(client, action);
      if (action.pick === 'approve' || action.pick === 'revise') patchUi({ planFull: undefined, planScroll: 0 });
      return true;
    case 'plan_full':
      patchUi({ planFull: action.qid, planScroll: 0, focus: 'chat' });
      return true;
    case 'plan_toggle':
      void client.api.session.setPlanMode(action.channel, !client.store.getState().planMode[action.channel]);
      return true;
    case 'open_shared':
      openShared(client, action.owner, action.id, action.tab);
      patchUi({ focus: action.tab === 'files' ? 'files' : action.tab === 'diff' ? 'main' : 'chat', chatScroll: 0, ...(action.tab === 'diff' || action.tab === 'files' ? { entered: true } : {}) });
      return true;
    case 'shared_menu':
      patchUi({ menu: { menu: { kind: 'shared', owner: action.owner, id: action.id }, selected: 0 } });
      return true;
    case 'ws':
      if (action.action !== 'share') return false;
      patchUi({ menu: { menu: { kind: 'ws_share', id: action.id }, selected: 0 } });
      return true;
    default:
      return false;
  }
}
