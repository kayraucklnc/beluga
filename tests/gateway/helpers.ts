import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentBackend, AgentRunInput } from '../../src/agent/types.js';
import { Gateway, type GatewayDeps } from '../../src/core/gateway/gateway.js';
import { meshNode } from '../../src/core/gateway/launch.js';
import type { Answer, ServeShell } from '../../src/core/gateway/serve.js';
import { Store, initialState } from '../../src/core/store.js';
import type { TrustLevel } from '../../src/core/trust.js';
import { type Crowd, type Person } from '../mesh/helpers.js';

/** A Claude for tests: answers from a script, and can be held until the test lets it finish. */
export class FakeClaude implements AgentBackend {
  readonly runs: AgentRunInput[] = [];
  /** What it answers (given the run). */
  answer: (input: AgentRunInput) => string | Promise<string> = (input) => `Done: ${input.prompt.split('<request>\n')[1]?.split('\n</request>')[0] ?? input.prompt}`;
  private gate: Promise<void> | undefined;
  private release: (() => void) | undefined;

  /** Runs wait until open() is called. */
  hold(): void {
    this.gate = new Promise((r) => (this.release = r));
  }

  open(): void {
    this.release?.();
    this.gate = undefined;
  }

  async run(input: AgentRunInput): Promise<string> {
    this.runs.push(input);
    input.onEvent('tool', 'Read README.md');
    if (this.gate) {
      const aborted = new Promise<never>((_, reject) => input.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      await Promise.race([this.gate, aborted]);
    }
    input.onEvent('tool', 'Bash npm test');
    return this.answer(input);
  }
}

export interface Pending {
  readonly kind: 'request' | 'tool';
  readonly title: string;
  readonly detail: string;
  readonly peer: string;
  /** The request it's about (request approvals only). */
  readonly task?: string;
  /** Only Allow once / Decline (a secret). */
  readonly once?: boolean;
  answer(a: Answer): void;
  withdrawn: boolean;
}

/** One person with their klaud: a mesh node, a store, a gateway, a fake Claude. */
export interface Node {
  readonly name: string;
  readonly person: Person;
  readonly store: Store;
  readonly gw: Gateway;
  readonly claude: FakeClaude;
  readonly approvals: Pending[];
  readonly resumes: Array<{ channel: string; prompt: string }>;
  readonly id: string;
  trust(peerId: string, level: TrustLevel): void;
  /** Quit klaud (the Mac goes offline), and start it again. */
  stop(): Promise<void>;
  start(): Promise<void>;
}

export async function node(net: Crowd, name: string, extra: Partial<GatewayDeps> & { serveShell?: ServeShell } = {}): Promise<Node> {
  const person = await net.add(name);
  const id = person.identity.peerId;
  const store = new Store(initialState('room'));
  store.dispatch({ type: 'identity', selfId: id, isHost: false });
  const claude = new FakeClaude();
  const approvals: Pending[] = [];
  const resumes: Array<{ channel: string; prompt: string }> = [];
  let offSync = (): void => undefined;
  const sync = (): void => {
    const update = (): void => store.dispatch({ type: 'net_summary', summary: person.mesh.summary() });
    person.mesh.on('change', update);
    offSync = () => person.mesh.off('change', update);
    update();
  };
  sync();
  const dir = mkdtempSync(path.join(os.tmpdir(), `klaud-gw-${name}-`));
  let note = '';
  const gw = new Gateway({
    store,
    dir,
    scratch: dir,
    selfId: () => id,
    selfName: () => name,
    agent: () => claude,
    approve: (kind, title, detail, peer, taskId, opts) => {
      let resolve!: (a: Answer) => void;
      const answer = new Promise<Answer>((r) => (resolve = r));
      const p: Pending = { kind, title, detail, peer, ...(taskId ? { task: taskId } : {}), ...(opts?.once ? { once: true } : {}), answer: (a) => resolve(a), withdrawn: false };
      approvals.push(p);
      return {
        answer,
        withdraw: () => {
          p.withdrawn = true;
          resolve('no');
        },
      };
    },
    resume: (channel, prompt) => void resumes.push({ channel, prompt }),
    projectRoot: () => undefined,
    projects: () => [],
    loadNote: () => note,
    saveNote: (n) => void (note = n),
    confirmTimeoutMs: 60_000,
    ...extra,
  });
  gw.attachMesh(meshNode(person.mesh));
  return {
    name,
    person,
    store,
    gw,
    claude,
    approvals,
    resumes,
    id,
    trust: (peerId, level) => store.dispatch({ type: 'trust_level', peerId, level }),
    stop: async () => {
      gw.detachMesh();
      offSync();
      await person.stop();
    },
    start: async () => {
      await person.start();
      sync();
      gw.attachMesh(meshNode(person.mesh));
    },
  };
}

/** The task as one side sees it now. */
export const task = (n: Node, id: string) => n.gw.get(id);
