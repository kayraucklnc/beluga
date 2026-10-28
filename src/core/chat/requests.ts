import { readJson, writeJson } from '../../net/mesh/files.js';
import { asks } from '../../net/mesh/extras.js';
import type { Mesh } from '../../net/mesh/mesh.js';
import type { MessageView } from '../../net/mesh/views.js';
import type { AskInput } from '../gateway/gateway.js';
import type { TaskView } from '../gateway/model.js';
import { FRESH_MS } from './claude.js';

/**
 * A friend's Claude answering your own ask in a chat with something that needs their Mac (BLG-353):
 * you already asked, so your Mac sends it there as your request at once (the gateway), where their
 * trust settings or their Allow decide. Only for an ask of yours that called their Claude in, only
 * while the answer is fresh, and each answer once. One that can't be sent keeps its button.
 */

const KEEP = 500;

export interface AnswerRequestsOptions {
  readonly mesh: Pick<Mesh, 'peerId' | 'on' | 'off' | 'conversation'>;
  /** The gateway's ask (throws when tasks between Claudes are off). */
  readonly ask: (input: AskInput) => TaskView;
  /** It couldn't be sent (their Mac doesn't take requests, the gateway is off). */
  readonly onProblem?: (conversation: string, name: string, text: string) => void;
  /** Where sent answers are remembered (a resync or a restart doesn't send twice). */
  readonly handledFile?: string;
  readonly now?: () => number;
}

export class AnswerRequests {
  private readonly handled: string[];
  private readonly off: () => void;

  constructor(private readonly opts: AnswerRequestsOptions) {
    const saved = opts.handledFile ? readJson(opts.handledFile) : undefined;
    this.handled = Array.isArray(saved) ? saved.filter((x): x is string => typeof x === 'string').slice(-KEEP) : [];
    const onMessage = (m: MessageView): void => this.consider(m);
    opts.mesh.on('message', onMessage);
    this.off = () => opts.mesh.off('message', onMessage);
  }

  stop(): void {
    this.off();
  }

  /** Is this a friend's Claude's answer to your own ask of it, with a request to send now? */
  due(m: MessageView): boolean {
    const me = this.opts.mesh.peerId;
    const request = m.claude?.request;
    if (!request || m.mine || m.from === me || m.status === 'locked') return false;
    if ((this.opts.now ?? Date.now)() - m.ts > FRESH_MS || this.handled.includes(m.id)) return false;
    const asked = this.opts.mesh.conversation(m.conversation).find((x) => x.id === m.claude!.for);
    return Boolean(asked && asked.mine && !asked.claude && asks(asked, m.from));
  }

  private consider(m: MessageView): void {
    if (!this.due(m)) return;
    this.handled.push(m.id);
    while (this.handled.length > KEEP) this.handled.shift();
    if (this.opts.handledFile) writeJson(this.opts.handledFile, this.handled);
    const request = m.claude!.request!;
    try {
      this.opts.ask({ person: m.from, ask: request.ask, by: 'person', conversation: m.conversation, answer: m.id, ...(request.needs?.length ? { needs: [...request.needs] } : {}) });
    } catch (err) {
      this.opts.onProblem?.(m.conversation, m.name, err instanceof Error ? err.message : String(err));
    }
  }
}
