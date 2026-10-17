import type { PendingQuestion } from '../core/collab-store.js';
import type { Session } from '../core/session.js';
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
function record(session: Session, q: PendingQuestion, question: string, answer: string): void {
  session.store.dispatch({ type: 'question_pick', qid: q.qid, question, answer });
  const latest = session.store.getState().questions.find((x) => x.qid === q.qid);
  if (!latest || latest.question.kind !== 'question') return;
  const done = latest.question.questions.every((x) => latest.picked[x.question] !== undefined);
  if (!done) return;
  const answers = Object.fromEntries(Object.entries(latest.picked).filter(([k]) => !k.endsWith(MULTI)));
  session.questions.answer(q.qid, { kind: 'answers', answers });
}

/** A click (or number key) on a question card. */
export function answerQuestion(session: Session, action: Extract<UiAction, { type: 'answer' }>): void {
  const q = session.store.getState().questions.find((x) => x.qid === action.qid);
  if (!q) return;
  switch (action.pick) {
    case 'skip':
      return session.questions.answer(q.qid, { kind: 'skip' });
    case 'approve':
      return session.questions.answer(q.qid, { kind: 'plan', approve: true, feedback: '' });
    case 'revise':
      return session.questions.answer(q.qid, { kind: 'plan', approve: false, feedback: '' });
    case 'done': {
      if (!action.question) return;
      const chosen = (q.picked[action.question + MULTI] ?? '').split(SEP).filter(Boolean);
      return record(session, q, action.question, chosen.join(', ') || '(none)');
    }
    case 'option': {
      const current = currentQuestion(q);
      if (!current || !action.label) return;
      if (!current.multiSelect) return record(session, q, current.question, action.label);
      // Multi-select: toggle, then "Done" sends.
      const chosen = new Set((q.picked[current.question + MULTI] ?? '').split(SEP).filter(Boolean));
      if (chosen.has(action.label)) chosen.delete(action.label);
      else chosen.add(action.label);
      session.store.dispatch({ type: 'question_pick', qid: q.qid, question: current.question + MULTI, answer: [...chosen].join(SEP) });
    }
  }
}

/** Typed text while a card is waiting: your own answer, or what to change in the plan. */
export function answerTyped(session: Session, q: PendingQuestion, text: string): void {
  if (q.question.kind === 'plan') return session.questions.answer(q.qid, { kind: 'plan', approve: false, feedback: text });
  const current = currentQuestion(q);
  if (current) record(session, q, current.question, text);
}

/** Number keys pick options on the card (1 = first option). */
export function answerByNumber(session: Session, q: PendingQuestion, n: number): boolean {
  const current = currentQuestion(q);
  const option = current?.options[n - 1];
  if (!option) return false;
  answerQuestion(session, { type: 'answer', qid: q.qid, pick: 'option', label: option.label, question: current?.question });
  return true;
}

/** Open a workspace someone shared with you. */
export function openShared(session: Session, owner: string, id: string, tab: 'chat' | 'files' = 'chat'): void {
  const w = session.store.getState().shared.find((x) => x.owner === owner && x.id === id);
  if (!w) return;
  session.store.dispatch({ type: 'view', view: { kind: 'shared', owner, id, tab } });
  if (tab === 'files') void session.browseTo({ owner, share: w.share, path: '' });
}

function runWorkspaceShare(ctx: MenuContext, wsId: string, id: string): boolean {
  const sharing = ctx.session.sharing;
  const [verb, peerId] = id.split(':') as [string, string | undefined];
  if (!peerId) return false;
  if (verb === 'ws-contribute' || verb === 'ws-view') {
    sharing.invite(wsId, peerId, verb === 'ws-contribute' ? 'contribute' : 'view');
    void ctx.session.workspaces?.refresh();
    ctx.patchUi({ menu: { menu: { kind: 'ws_share', id: wsId }, selected: 0 } });
    return true;
  }
  if (verb === 'ws-remove') {
    sharing.remove(wsId, peerId);
    ctx.patchUi({ menu: { menu: { kind: 'ws_share', id: wsId }, selected: 0 } });
    return true;
  }
  return false;
}

/** Menu options for sharing, people and the room. Returns false when it isn't one of these. */
export function runCollabOption(ctx: MenuContext, menu: MenuKind, id: string): boolean {
  const { session, patchUi, typeInto } = ctx;
  const latest = session.store.getState();
  if (menu.kind === 'ws_share' && runWorkspaceShare(ctx, menu.id, id)) return true;
  if (menu.kind === 'invite_person' && id.startsWith('inv:')) {
    session.sharing.invite(id.slice(4), menu.peerId, 'contribute');
    void session.workspaces?.refresh();
    return true;
  }
  if (menu.kind === 'share_folder' && id.startsWith('sf-dir:')) {
    patchUi({ menu: { menu: { kind: 'share_who', dir: id.slice('sf-dir:'.length) }, selected: 0 } });
    return true;
  }
  if (menu.kind === 'share_folder' && id.startsWith('sf-stop:')) {
    session.unshareFolder(id.slice('sf-stop:'.length));
    return true;
  }
  if (menu.kind === 'share_who') {
    if (id === 'sw-all' || id === 'sw-all-rw') session.shareFolder(menu.dir, id === 'sw-all-rw');
    else if (id.startsWith('sw-peer:')) session.shareFolder(menu.dir, false, [id.slice('sw-peer:'.length)]);
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
      if (menu.kind === 'shared') openShared(session, menu.owner, menu.id, id === 'sh-files' ? 'files' : 'chat');
      return true;
    case 'sh-leave':
      if (menu.kind === 'shared') session.sharing.leave(menu.owner, menu.id);
      return true;
    case 'clear-everyone':
    case 'clear-mine':
    case 'clear-fresh':
      if (menu.kind === 'clear') session.clearChat(menu.channel, { everyone: id === 'clear-everyone', fresh: id === 'clear-fresh' });
      return true;
    case 'person-invite-ws':
      if (peer) patchUi({ menu: { menu: { kind: 'invite_person', peerId: peer.peerId }, selected: 0 } });
      return true;
    case 'person-share':
    case 'share-folder':
      patchUi({ menu: { menu: { kind: 'share_folder', launchDir: session.launchDir, mine: session.myShares }, selected: 0 } });
      return true;
    case 'person-remove':
      if (peer) session.removePerson(peer.peerId);
      return true;
    case 'room-new-link':
      session.newInviteLink();
      return true;
    case 'room-close':
    case 'room-open':
      session.setRoomOpen(id === 'room-open');
      return true;
    case 'leave-room':
      session.quit();
      return true;
    default:
      return false;
  }
}

/** UI actions for collaboration (question cards, shared workspaces, plan mode, sharing). */
export function runCollabUiAction(ctx: MenuContext, action: UiAction): boolean {
  const { session, patchUi } = ctx;
  switch (action.type) {
    case 'answer':
      answerQuestion(session, action);
      if (action.pick === 'approve' || action.pick === 'revise') patchUi({ planFull: undefined, planScroll: 0 });
      return true;
    case 'plan_full':
      patchUi({ planFull: action.qid, planScroll: 0, focus: 'chat' });
      return true;
    case 'plan_toggle':
      session.setPlanMode(action.channel, !session.store.getState().planMode[action.channel]);
      return true;
    case 'open_shared':
      openShared(session, action.owner, action.id, action.tab);
      patchUi({ focus: action.tab === 'files' ? 'files' : 'chat' });
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
