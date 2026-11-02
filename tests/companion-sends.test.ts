import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The phone's sends (packages/companion/lib/sends.ts): shown at once, counted as sent only when the
 * Mac answers, gone only when the Mac's view has them, undone when it says no. The store and the
 * phone's storage are stand-ins here: a Mac that answers when the test says so.
 */

type Call = { method: string; args: unknown[]; label: string };
type Answer = { resolve: (v: unknown) => void; reject: (e: Error & { lost?: boolean }) => void; call: Call };

const fake = vi.hoisted(() => {
  const listeners = new Map<string, Set<() => void>>();
  const views = new Map<string, { data: unknown; rev: number; at: number; stale: boolean }>();
  const kept = new Map<string, unknown>();
  const answers: Answer[] = [];
  const toasts: { text: string; tone?: string; topic?: string }[] = [];
  const store = {
    linked: true,
    subscribe(key: string, fn: () => void) {
      let set = listeners.get(key);
      if (!set) listeners.set(key, (set = new Set()));
      set.add(fn);
      return () => void set!.delete(fn);
    },
    emit(key: string) {
      for (const fn of [...(listeners.get(key) ?? [])]) fn();
    },
    view: (topic: string) => views.get(topic),
    call: (call: Call) => new Promise((resolve, reject) => answers.push({ resolve, reject, call })),
    toast: (t: { text: string; tone?: string; topic?: string }) => void toasts.push(t),
  };
  return { listeners, views, kept, answers, toasts, store };
});

vi.mock('react', () => ({ useSyncExternalStore: () => undefined }));
vi.mock('../packages/companion/lib/kv', () => ({ kv: { get: (k: string) => fake.kept.get(k), set: (k: string, v: unknown) => void fake.kept.set(k, v) } }));
vi.mock('../packages/companion/lib/store', () => ({ store: fake.store }));

const flush = () => new Promise((r) => setTimeout(r, 0));
const call = (label: string): Call => ({ method: 'companion.ask', args: [], label });
const TOPIC = 'conv:ws:w1';
/** The Mac's view of a conversation, with your messages in it. */
function conv(...yours: { id: string; text: string }[]) {
  fake.views.set(TOPIC, { data: { turns: yours.map((y) => ({ id: y.id, who: 'you', prose: { text: y.text } })), queue: [] }, rev: 1, at: Date.now(), stale: false });
  fake.store.emit(`view:${TOPIC}`);
}

/** What the tests use of lib/sends.ts (the phone's code isn't in the root typecheck: it imports React Native). */
type SendLike = { id: string; text: string; state: string; error?: string; topic?: string };
interface Sends {
  message(topic: string, text: string, call: Call): void;
  start(start: { kind: string; label: string; target: string }, text: string, call: Call): string;
  of(where: string): readonly SendLike[];
  get(id: string): SendLike | undefined;
  retry(id: string): void;
  showing(id: string): () => void;
  draft: unknown;
}
const SENDS = '../packages/companion/lib/sends.ts';

async function fresh(): Promise<Sends> {
  vi.resetModules();
  fake.listeners.clear();
  fake.views.clear();
  fake.kept.clear();
  fake.answers.length = 0;
  fake.toasts.length = 0;
  fake.store.linked = true;
  return ((await import(SENDS)) as { sends: Sends }).sends;
}

describe('a message', () => {
  let sends: Sends;
  beforeEach(async () => {
    sends = await fresh();
    conv({ id: 't0', text: 'earlier' });
  });

  it('shows at once, is sent when the Mac says ok, and goes when its view has it', async () => {
    sends.message(TOPIC, 'Run the tests', call('Send'));
    expect(sends.of(TOPIC).map((s) => [s.text, s.state])).toEqual([['Run the tests', 'sending']]);
    await flush();
    fake.answers[0]!.resolve({ topic: TOPIC });
    await flush();
    expect(sends.of(TOPIC)[0]!.state).toBe('sent');
    conv({ id: 't0', text: 'earlier' }, { id: 't1', text: 'Run the tests' });
    expect(sends.of(TOPIC)).toEqual([]);
  });

  it('is not counted as sent when the Mac says no: it stays, with its words, to retry', async () => {
    sends.message(TOPIC, 'Run the tests', call('Send'));
    await flush();
    fake.answers[0]!.reject(new Error('Claude is busy'));
    await flush();
    const s = sends.of(TOPIC)[0]!;
    expect([s.state, s.error, s.text]).toEqual(['failed', 'Claude is busy', 'Run the tests']);
    sends.retry(s.id);
    await flush();
    expect(fake.answers).toHaveLength(2);
    fake.answers[1]!.resolve({ topic: TOPIC });
    await flush();
    expect(sends.of(TOPIC)[0]!.state).toBe('sent');
  });

  it('a lost link: unsure until the Mac’s next view shows whether it arrived', async () => {
    sends.message(TOPIC, 'one', call('Send'));
    sends.message(TOPIC, 'two', call('Send'));
    await flush();
    fake.answers[0]!.reject(Object.assign(new Error('The link closed.'), { lost: true }));
    fake.answers[1]!.reject(Object.assign(new Error('The link closed.'), { lost: true }));
    await flush();
    expect(sends.of(TOPIC).map((s) => s.state)).toEqual(['unsure', 'unsure']);
    // Back: the Mac had the first, not the second.
    conv({ id: 't0', text: 'earlier' }, { id: 't1', text: 'one' });
    expect(sends.of(TOPIC).map((s) => [s.text, s.state])).toEqual([['two', 'failed']]);
  });

  it('an old message with the same words is not taken for the new one', async () => {
    conv({ id: 't0', text: 'yes' });
    sends.message(TOPIC, 'yes', call('Send'));
    conv({ id: 't0', text: 'yes' });
    expect(sends.of(TOPIC)).toHaveLength(1);
  });

  it('waits while the Mac is away (kept for the next launch) and goes when it answers', async () => {
    fake.store.linked = false;
    sends.message(TOPIC, 'later', call('Send'));
    await flush();
    expect(sends.of(TOPIC)[0]!.state).toBe('waiting');
    expect(fake.answers).toHaveLength(0);
    expect((fake.kept.get('sends') as unknown[]).length).toBe(1);
    fake.store.linked = true;
    fake.store.emit('linked');
    await flush();
    expect(fake.answers).toHaveLength(1);
    expect(sends.of(TOPIC)[0]!.state).toBe('sending');
  });
});

describe('a start from Ask', () => {
  it('takes the worktree the Mac made', async () => {
    const sends = await fresh();
    const id = sends.start({ kind: 'worktree', label: 'beluga', target: 'project:beluga' }, 'Fix the login', call('Start'));
    await flush();
    fake.answers[0]!.resolve('w9');
    await flush();
    expect([sends.get(id)!.state, sends.get(id)!.topic]).toEqual(['sent', 'conv:ws:w9']);
  });

  it('refused with its screen open: failed, for the screen to go back to Ask', async () => {
    const sends = await fresh();
    const id = sends.start({ kind: 'plan', label: 'beluga', target: 'project:beluga' }, 'Passkeys', call('Plan'));
    await flush();
    fake.answers[0]!.reject(new Error('Not a git repository'));
    await flush();
    expect([sends.get(id)!.state, sends.get(id)!.error]).toEqual(['failed', 'Not a git repository']);
  });

  it('refused after you left its screen: says so, and Ask gets the words back', async () => {
    const sends = await fresh();
    const id = sends.start({ kind: 'worktree', label: 'beluga', target: 'project:beluga' }, 'Fix the login', call('Start'));
    sends.showing(id)(); // the screen opened and closed
    await flush();
    fake.answers[0]!.reject(new Error('No such project'));
    await flush();
    expect(sends.get(id)).toBeUndefined();
    expect(sends.draft).toEqual({ text: 'Fix the login', target: 'project:beluga', how: 'worktree' });
    expect(fake.toasts.at(-1)).toMatchObject({ tone: 'error' });
  });

  it('a Mac that answers without a worktree is a refusal, not a start', async () => {
    const sends = await fresh();
    const id = sends.start({ kind: 'worktree', label: 'beluga', target: 'project:beluga' }, 'Fix', call('Start'));
    await flush();
    fake.answers[0]!.resolve(undefined);
    await flush();
    expect(sends.get(id)!.state).toBe('failed');
  });
});
