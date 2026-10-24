import type { PhoneArgs, PhoneMethod } from '../../../../src/companion/calls';
import type { NeedsYou, Topic } from './protocol';

/**
 * Every call the phone makes, typed through the Mac's own list (src/companion/calls.ts:
 * `PhoneCalls`, the `phone` methods of coverage.ts with the very argument tuples the daemon
 * checks). A method renamed or an argument changed on the Mac fails `npm run typecheck` here.
 * Type-only import: nothing of the daemon's API is bundled into the app.
 *
 * Needs-you items carry their own calls (`actions`, and `answer` for picks and words), made as the
 * Mac wrote them.
 */
export interface Call<M extends PhoneMethod = PhoneMethod> {
  readonly method: M;
  readonly args: PhoneArgs<M>;
  /** How the outbox names it while your Mac is asleep ("Send 'Run the tests'"). */
  readonly label: string;
}

const make = <M extends PhoneMethod>(method: M, args: PhoneArgs<M>, label: string): Call => ({ method, args, label }) as unknown as Call;

/** `conv:<channel>` → the channel the daemon's session methods take. */
export const channelOf = (topic: Topic): string => topic.replace(/^conv:/, '');
/** `chat:dm:<peerId>` → `dm:<peerId>` (what the network methods call a conversation). */
export const conversationOf = (topic: Topic): string => topic.replace(/^chat:/, '');

const short = (text: string): string => (text.length > 32 ? `${text.slice(0, 31)}…` : text);
/** `up:` refs of files the phone `put` (store.put), to send along. */
type Files = readonly string[] | undefined;
const withFiles = (files: Files) => (files?.length ? { files: [...files] } : {});

export const calls = {
  /** A message in a conversation (yours, or shared with you to work in), with photos. */
  send: (topic: Topic, text: string, files?: Files): Call => make('companion.ask', [{ target: { topic }, text, ...withFiles(files) }], `Send "${short(text)}"`),
  /** Ask your Mac in a project: a new conversation there (its topic comes back). */
  ask: (project: string, text: string, files?: Files): Call => make('companion.ask', [{ target: { project }, text, ...withFiles(files) }], `Ask "${short(text)}"`),
  stop: (topic: Topic): Call => make('host.stopRun', [channelOf(topic)], 'Stop'),
  /** Your steered message Claude hasn't read yet, now: its step stops and it reads it next. */
  steerNow: (request: string): Call => make('host.steerNow', [request], 'Send now'),
  older: (topic: Topic, before: string): Call => make('companion.older', [topic, { before }], 'Load older'),
  /** Write in a friends' chat (with photos, or asking Claude). */
  /** `ask`: whose Claude answers too: everyone's ('all') or the chosen people's (peer ids, you included). */
  chat: (topic: Topic, text: string, opts: { files?: Files; ask?: 'all' | readonly string[] } = {}): Call =>
    make('companion.post', [{ conversation: conversationOf(topic), text, ...withFiles(opts.files), ...(opts.ask ? { ask: opts.ask === 'all' ? ('all' as const) : [...opts.ask] } : {}) }], opts.files?.length ? 'Send a photo' : `Message "${short(text)}"`),
  read: (topic: Topic): Call => make('network.read', [conversationOf(topic)], 'Mark read'),
  /** Ask a friend's Claude yourself; the answer (and files) come back in the topic it returns. */
  askPerson: (peerId: string, name: string, text: string): Call => make('companion.askPerson', [{ peerId, text }], `Ask ${name}'s Claude`),
  screenshot: (peerId: string, name: string): Call => make('companion.askPerson', [{ peerId, text: 'Take a screenshot of your desktop and send it to me.', needs: ['screen'] }], `Screenshot of ${name}'s desktop`),
  /** This phone signs out on the Mac (its certificate goes). */
  signOut: (): Call => make('companion.signOut', [], 'Sign out'),

  /** One of a needs-you item's buttons, as the Mac wrote it. */
  action: (item: NeedsYou, action: NeedsYou['actions'][number]): Call => ({ method: action.method as PhoneMethod, args: action.args as never, label: `${action.label}: ${short(item.title)}` }),
  /**
   * Your own answer (picked options, or words) through the item's `answer` template: the value goes
   * at `slot` inside a copy of `args` (several picks joined with `join`, or as a list with `list`).
   */
  answer(item: NeedsYou, value: string | readonly string[]): Call | undefined {
    const t = item.answer;
    if (!t) return undefined;
    const filled = Array.isArray(value) ? (t.list ? [...value] : value.join(t.join ?? ', ')) : value;
    const args = structuredCloneish(t.args);
    let at: unknown = args;
    t.slot.forEach((key, i) => {
      const box = at as Record<string | number, unknown>;
      if (i === t.slot.length - 1) box[key] = filled;
      else {
        if (box[key] === undefined || box[key] === null) box[key] = typeof t.slot[i + 1] === 'number' ? [] : {};
        at = box[key];
      }
    });
    const shown = Array.isArray(filled) ? filled.join(', ') : String(filled);
    return { method: t.method as PhoneMethod, args: args as never, label: `${t.label ?? 'Answer'}: ${short(shown)}` };
  },
};

/** A deep copy of JSON-shaped args (the template is the view's; it must stay untouched). */
const structuredCloneish = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
