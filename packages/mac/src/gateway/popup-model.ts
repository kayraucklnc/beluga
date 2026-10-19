import type { Approval } from '../../../../src/core/store.js';
import { CAP_INFO } from '../../../../src/core/gateway/access.js';
import { type TaskView, oneLine, requestGist } from '../../../../src/core/gateway/model.js';
import type { RequestAction } from './request-actions.js';

/**
 * The floating card a friend's request gets on top of whatever you're doing (the app shell's
 * "request-popup" window): a few words of what they want, the full ask behind See more, and
 * Allow / Allow Always / Decline. This is what it shows, worked out from the shared state.
 * Plain data, so the app shell can hand it to the card's own window.
 */

export interface PopupRequest {
  /** The approval card it answers. */
  readonly approval: string;
  readonly task: string;
  readonly peerId: string;
  readonly peerName: string;
  /** Their Claude asks (not the person themself). */
  readonly claude: boolean;
  readonly kind: TaskView['kind'];
  /** "take a screenshot of your desktop": the sender's summary, else the start of the ask. A command or a file is always named as it is. */
  readonly gist: string;
  /** Under the gist: what the request really is when the gist is the sender's own words (the start of the ask, or their reason). */
  readonly said?: string;
  /** Everything their Claude sent: the ask (or the command, or the file). */
  readonly full: string;
  /** What it needs here, in words ("See the screen"). */
  readonly needs: readonly string[];
  readonly where: string;
  readonly back: string;
  readonly askedAt: number;
}

/** Requests one card shows at once (the rest: "2 more waiting"). */
export const POPUP_MAX = 3;

/** Where a request would run or read, in words (the request sheet says the same). */
export const whereLine = (t: TaskView): string =>
  t.kind === 'file' ? (t.path ?? 'a file') : t.project ? `In your project ${t.project}` : t.kind === 'run' ? (t.folder ?? t.cwd ?? 'Your shared folder (or home, with full trust)') : 'A new scratch folder, just for this request';

/** What goes back to them, in words. */
export const backLine = (t: TaskView): string => (t.kind === 'run' ? 'The output and exit code' : t.kind === 'file' ? 'The file' : t.expects === 'files' ? 'Files' : t.expects ? 'Structured data (JSON)' : 'A summary of what your Claude did');

/** The sender chooses the summary, so a command or a file is named as it is, never by their words alone. */
const gistOf = (t: TaskView): string => {
  if (t.kind === 'run') return `run ${oneLine(t.command ?? '', 80)}`;
  if (t.kind === 'file') return `get ${t.path ?? 'a file'}`;
  return requestGist(t, 90);
};

/** The sender's words beside a command or a file ("why"), or the real start of an ask they summarised. */
const saidOf = (t: TaskView): string | undefined => {
  if (t.kind !== 'ask') return t.summary ? `“${t.summary}”` : undefined;
  return t.summary ? oneLine(t.ask, 140) : undefined;
};

const fullOf = (t: TaskView): string => {
  if (t.kind === 'run') return `$ ${t.command ?? ''}${t.ask && t.ask !== t.command ? `\n\nWhy: ${t.ask}` : ''}`;
  if (t.kind === 'file') return `${t.path ?? ''}${t.ask && !t.ask.startsWith('Send me ') ? `\n\nWhy: ${t.ask}` : ''}`;
  return t.ask;
};

/**
 * Friends' requests waiting for you, newest first, as the card shows them. Nothing while you're
 * on Do Not Disturb or appear offline: they still wait in Klaud and the menu bar, quietly.
 */
export function popupRequests(approvals: readonly Approval[], tasks: readonly TaskView[], quiet: boolean): PopupRequest[] {
  if (quiet) return [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return approvals
    .flatMap((a) => {
      const t = a.kind === 'request' && a.peer && a.task ? byId.get(a.task) : undefined;
      if (!t || t.direction !== 'received' || t.state !== 'awaiting_approval') return [];
      const item: PopupRequest = {
        approval: a.id,
        task: t.id,
        peerId: t.peerId,
        peerName: t.peerName,
        claude: t.by === 'agent',
        kind: t.kind,
        gist: gistOf(t),
        ...(saidOf(t) ? { said: saidOf(t)! } : {}),
        full: fullOf(t),
        needs: t.needs.map((n) => CAP_INFO[n].label),
        where: whereLine(t),
        back: backLine(t),
        askedAt: a.askedAt ?? t.createdAt,
      };
      return [item];
    })
    .sort((a, b) => b.askedAt - a.askedAt);
}

/** "Mia's Claude wants to" / "Mia wants to" (the card's first line). */
export const popupWho = (r: Pick<PopupRequest, 'peerName' | 'claude'>): string => `${r.peerName}${r.claude ? '’s Claude' : ''}`;

/** What a button on the card does (answered by the main window, like a notification's). */
export const POPUP_BUTTONS: ReadonlyArray<{ readonly action: RequestAction; readonly label: string }> = [
  { action: 'decline', label: 'Decline' },
  { action: 'allow_always', label: 'Allow Always' },
  { action: 'approve', label: 'Allow' },
];

/** The buttons one request gets: a file is allowed one at a time here (Always for files, with its folder spelled out, is on the request sheet). */
export const popupButtons = (r: Pick<PopupRequest, 'kind'>): typeof POPUP_BUTTONS => (r.kind === 'file' ? POPUP_BUTTONS.filter((b) => b.action !== 'allow_always') : POPUP_BUTTONS);
