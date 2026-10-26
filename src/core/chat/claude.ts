import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson, writeJson } from '../../net/mesh/files.js';
import type { Mesh } from '../../net/mesh/mesh.js';
import { asks } from '../../net/mesh/extras.js';
import type { ChatFile, MessageView } from '../../net/mesh/views.js';
import type { TrustLevel } from '../trust.js';
import { type ChatAnswerRequest, type ChatImage, IMAGE_BYTES, MAX_IMAGES, type PromptFile, TEXT_FILE_BYTES, fitTexts, historyLines, isImageFile, isTextFile, parseRequest, sizeLabel, speaker, splitAnswer, systemPrompt, userPrompt } from './claude-prompt.js';
import type { ChatFiles } from './files.js';

/**
 * Claudes called into chats. Nobody's Claude reads along: it answers only a message that asks
 * for it (the Ask Claude button: your Claude, everyone's, or one person's). Each Mac whose
 * owner's Claude was asked runs it there, on that owner's login, from the conversation as every
 * member's Mac holds it, and posts the answer back into the chat as "<owner>'s Claude". So all
 * Claudes share one history, and each answer becomes part of what the next one reads.
 *
 * Who may call your Claude: you always; others as your setting says (friends in the chat, people
 * you trust, or only you), never someone you blocked, at most PER_HOUR times an hour each and
 * ALL_PER_HOUR from everyone together. Someone in a channel who isn't your friend needs your trust.
 */

export type ChatClaudePolicy = 'everyone' | 'trusted' | 'off';

/** An ask older than this when it reaches you (you were offline) isn't answered any more. */
export const FRESH_MS = 10 * 60_000;
/** Asks one person may make of your Claude in an hour, and everyone else together. */
export const PER_HOUR = 20;
export const ALL_PER_HOUR = 60;
const PARALLEL = 2;
const MAX_QUEUE = 20;
/** How long to wait for an ask's files to arrive before answering without them. */
const FILES_WAIT_MS = 45_000;
/** Asks remembered as answered (so a resync or a restart doesn't answer twice). */
const KEEP_HANDLED = 1_000;
/** "Still thinking" is said again this often (screens forget a Claude that went quiet). */
const HEARTBEAT_MS = 60_000;

export interface ChatClaudeOptions {
  readonly mesh: Mesh;
  readonly files?: ChatFiles;
  /** Your Claude's answer (undefined: this Beluga has no Claude to answer with). */
  readonly answer: ((req: ChatAnswerRequest) => Promise<string>) | undefined;
  /**
   * Your own asks of your own Claude (BLG-207): a real turn with its tools in this conversation
   * (agent-host runChat), its final answer back for the chat. Missing: they're answered like
   * anyone's, without tools.
   */
  readonly act?: (conversation: string, prompt: string) => Promise<string>;
  /** Whether `act` can run now (default: yes). */
  readonly canAct?: () => boolean;
  readonly policy: () => ChatClaudePolicy;
  readonly trustOf: (peerId: string) => TrustLevel;
  /** Is this person your friend? (default: the mesh says) */
  readonly isFriend?: (peerId: string) => boolean;
  readonly model?: () => string | undefined;
  /** Your Claude started or stopped answering (the others hear it over the network). */
  readonly onLive?: (conversation: string, id: string, state: 'thinking' | 'idle') => void;
  /** Something you should know (your Claude couldn't answer). */
  readonly onProblem?: (conversation: string, text: string) => void;
  /** Where answered asks are remembered. */
  readonly handledFile?: string;
  readonly now?: () => number;
}

interface Job {
  readonly ask: MessageView;
  readonly abort: AbortController;
}

/** Why an attached file isn't in what Claude reads. */
function whyNot(file: ChatFile, wanted: boolean, here: boolean): string {
  if (wanted && here) return `more pictures than Claude looks at in one answer (${MAX_IMAGES})`;
  if (wanted) return 'didn’t arrive in time';
  return isTextFile(file) || isImageFile(file) ? `too big (${sizeLabel(file.size)})` : 'a kind Claude can’t read in a chat';
}

export class ChatClaude {
  private readonly handled: string[];
  private readonly handledSet: Set<string>;
  private readonly queue: Job[] = [];
  private readonly running = new Set<Job>();
  private readonly perPerson = new Map<string, number[]>();
  private readonly off: () => void;
  private stopped = false;

  constructor(private readonly opts: ChatClaudeOptions) {
    const saved = opts.handledFile ? readJson(opts.handledFile) : undefined;
    this.handled = Array.isArray(saved) ? saved.filter((x): x is string => typeof x === 'string').slice(-KEEP_HANDLED) : [];
    this.handledSet = new Set(this.handled);
    const onMessage = (m: MessageView): void => this.consider(m);
    opts.mesh.on('message', onMessage);
    this.off = () => opts.mesh.off('message', onMessage);
  }

  /** Your own asks can be real turns with tools here and now. */
  acts(): boolean {
    return Boolean(this.opts.act && (this.opts.canAct?.() ?? true));
  }

  private get now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** Is this message one your Claude should answer now? (and why not, for tests and logs) */
  verdict(m: MessageView): 'answer' | 'not asked' | 'answered' | 'stale' | 'not allowed' | 'too many' | 'busy' | 'no claude' {
    const me = this.opts.mesh.peerId;
    if (m.claude || !asks(m, me) || m.status === 'locked') return 'not asked';
    if (this.handledSet.has(m.id)) return 'answered';
    if (this.now - m.ts > FRESH_MS) return 'stale';
    if (!this.opts.answer && !(m.from === me && this.acts())) return 'no claude';
    if (m.from !== me) {
      const level = this.opts.trustOf(m.from);
      const policy = this.opts.policy();
      const trusted = level === 'trusted' || level === 'full';
      const friend = (this.opts.isFriend ?? ((p: string) => this.opts.mesh.isFriend(p)))(m.from);
      if (level === 'blocked' || policy === 'off' || (!trusted && (policy === 'trusted' || !friend))) return 'not allowed';
      const hour = (list: readonly number[]): number => list.filter((t) => this.now - t < 3_600_000).length;
      if (hour(this.perPerson.get(m.from) ?? []) >= PER_HOUR) return 'too many';
      if ([...this.perPerson.values()].reduce((n, list) => n + hour(list), 0) >= ALL_PER_HOUR) return 'too many';
    }
    if (this.queue.length >= MAX_QUEUE) return 'busy';
    return 'answer';
  }

  stop(): void {
    this.stopped = true;
    this.off();
    // Nobody is left waiting on a "thinking" that won't end.
    for (const job of this.running) this.opts.mesh.sendLive(job.ask.conversation, job.ask.id, 'idle');
    for (const job of [...this.running, ...this.queue]) job.abort.abort();
    this.queue.length = 0;
  }

  private consider(m: MessageView): void {
    if (this.stopped || this.verdict(m) !== 'answer') return;
    this.remember(m.id);
    if (!m.mine) this.perPerson.set(m.from, [...(this.perPerson.get(m.from) ?? []).filter((t) => this.now - t < 3_600_000), this.now]);
    this.queue.push({ ask: m, abort: new AbortController() });
    this.next();
  }

  private remember(id: string): void {
    this.handled.push(id);
    this.handledSet.add(id);
    while (this.handled.length > KEEP_HANDLED) this.handledSet.delete(this.handled.shift()!);
    if (this.opts.handledFile) writeJson(this.opts.handledFile, this.handled);
  }

  private next(): void {
    while (!this.stopped && this.running.size < PARALLEL && this.queue.length) {
      const job = this.queue.shift()!;
      this.running.add(job);
      void this.run(job).finally(() => {
        this.running.delete(job);
        this.next();
      });
    }
  }

  private live(conversation: string, id: string, state: 'thinking' | 'idle'): void {
    this.opts.mesh.sendLive(conversation, id, state);
    this.opts.onLive?.(conversation, id, state);
  }

  private async run(job: Job): Promise<void> {
    const { mesh } = this.opts;
    const m = job.ask;
    const conversation = m.conversation;
    this.live(conversation, m.id, 'thinking');
    const beat = setInterval(() => this.live(conversation, m.id, 'thinking'), HEARTBEAT_MS);
    beat.unref?.();
    try {
      // You asked your own Claude: a real turn, with its tools (BLG-207). Anyone else: one answer, no tools.
      const acting = m.from === mesh.peerId && this.acts();
      const request = await this.request(m, job.abort.signal, acting);
      const answer = acting ? await this.opts.act!(conversation, `${request.system}\n\n${request.prompt}`) : await this.opts.answer!(request);
      if (this.stopped || job.abort.signal.aborted) return;
      // Still in the conversation? (you may have left the group, or they unfriended you, meanwhile)
      if (!mesh.conversations().includes(conversation)) return;
      // What needs this Mac comes back as a request the asker's Mac offers to send (gateway), on the last part.
      const { text, request: offer } = acting ? { text: answer } : parseRequest(answer);
      const parts = splitAnswer(text);
      parts.forEach((part, i) => mesh.post(conversation, part, { claude: { for: m.id, ...(offer && i === parts.length - 1 ? { request: offer } : {}) } }));
    } catch (err) {
      if (!this.stopped) this.opts.onProblem?.(conversation, `Your Claude couldn’t answer ${m.mine ? 'you' : m.name}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearInterval(beat);
      if (!this.stopped) this.live(conversation, m.id, 'idle');
    }
  }

  /**
   * A turn of your Claude that Beluga starts in a chat itself (BLG-207): a friend's result or their
   * Claude's question came back for a request it made from here. It takes it with its tools, and its
   * answer goes into the chat, as one to your latest message there.
   */
  continueWith(conversation: string, prompt: string): void {
    const { mesh } = this.opts;
    if (this.stopped || !this.opts.act || !this.acts() || !mesh.conversations().includes(conversation)) return;
    const all = mesh.conversation(conversation);
    const about = [...all].reverse().find((m) => m.mine && !m.claude)?.id ?? all.at(-1)?.id ?? 'beluga';
    this.live(conversation, about, 'thinking');
    void this.opts
      .act(conversation, prompt)
      .then((answer) => {
        if (this.stopped || !mesh.conversations().includes(conversation)) return;
        for (const part of splitAnswer(answer)) mesh.post(conversation, part, { claude: { for: about } });
      })
      .catch((err: unknown) => {
        if (!this.stopped) this.opts.onProblem?.(conversation, `Your Claude couldn’t carry on: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        if (!this.stopped) this.live(conversation, about, 'idle');
      });
  }

  /** The history, the files and the question, as your Claude will read them. */
  private async request(m: MessageView, signal: AbortSignal, tools = false): Promise<ChatAnswerRequest> {
    const { mesh } = this.opts;
    const all = mesh.conversation(m.conversation);
    const at = all.findIndex((x) => x.id === m.id);
    const owner = mesh.summary().self?.name ?? 'me';
    const group = m.conversation.startsWith('group:') ? mesh.summary().groups.find((g) => `group:${g.id}` === m.conversation) : undefined;
    const friend = m.conversation.startsWith('dm:') ? mesh.nameFor(m.conversation.slice(3)) : undefined;
    const people = group ? group.members.map((p) => (p.self ? owner : p.name)) : [owner, friend ?? 'a friend'];
    const asker = m.mine ? owner : m.name;
    const read = await this.readFiles(m.files ?? []);
    // With tools, pictures are files it opens itself (Read) rather than images in the prompt: a copy
    // outside Beluga's home (which stays private to every Claude), as anything else you show it.
    const pictures: PromptFile[] = [];
    if (tools) {
      for (const i of read.images) {
        const file = (m.files ?? []).find((f) => f.name === i.name);
        if (!file) continue;
        const copy = path.join(os.tmpdir(), 'beluga-chat-pictures', `${file.sha.slice(0, 16)}-${file.name}`);
        await fs.mkdir(path.dirname(copy), { recursive: true });
        await fs.writeFile(copy, Buffer.from(i.b64, 'base64'));
        pictures.push({ file, missing: `a picture: open it with Read at ${copy}` });
      }
    }
    const files = [...read.files, ...pictures];
    const images = tools ? [] : read.images;
    return {
      system: systemPrompt({ owner, where: group ? `the group “${group.name}”` : `a direct message with ${friend ?? 'a friend'}`, people, asker, askedAll: m.ask?.to === 'all', ...(tools ? { tools: true } : {}) }),
      prompt: userPrompt({
        history: historyLines(at >= 0 ? all.slice(0, at) : all, owner),
        ask: m,
        asker,
        files,
        since: at >= 0 ? all.slice(at + 1).map((x) => `${speaker(x, owner)}: ${x.text.trim()}`) : [],
      }),
      images,
      ...(this.opts.model?.() ? { model: this.opts.model() } : {}),
      signal,
    };
  }

  /** The ask's files that Claude can read: text inline, pictures as images (waiting a little for them to arrive). */
  private async readFiles(list: readonly ChatFile[]): Promise<{ files: PromptFile[]; images: ChatImage[] }> {
    const store = this.opts.files;
    if (!list.length) return { files: [], images: [] };
    if (!store) return { files: list.map((file) => ({ file, missing: 'files are off' })), images: [] };
    const wanted = list.filter((f) => (isTextFile(f) && f.size <= TEXT_FILE_BYTES) || (isImageFile(f) && f.size <= IMAGE_BYTES));
    for (const f of wanted) {
      try {
        store.download(f.sha);
      } catch {
        // Shared somewhere this Mac doesn't know yet: it may still come with the message.
      }
    }
    const here = new Set(await store.whenHere(wanted.map((f) => f.sha), FILES_WAIT_MS));
    const texts: Array<{ file: ChatFile; text: string }> = [];
    const images: ChatImage[] = [];
    const missing: PromptFile[] = [];
    for (const file of list) {
      if (isTextFile(file) && file.size <= TEXT_FILE_BYTES && here.has(file.sha)) texts.push({ file, text: await fs.readFile(store.pathOf(file.sha), 'utf8') });
      else if (isImageFile(file) && file.size <= IMAGE_BYTES && here.has(file.sha) && images.length < MAX_IMAGES) images.push({ name: file.name, mime: file.mime!, b64: (await fs.readFile(store.pathOf(file.sha))).toString('base64') });
      else missing.push({ file, missing: whyNot(file, wanted.includes(file), here.has(file.sha)) });
    }
    return { files: [...fitTexts(texts), ...missing], images };
  }
}
