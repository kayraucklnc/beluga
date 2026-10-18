import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { AgentBackend, AgentRunInput } from '../../agent/types.js';
import { demoShell } from '../../demo.js';
import type { Mesh } from '../../net/mesh/mesh.js';
import { Store, initialState } from '../store.js';
import type { TrustLevel } from '../trust.js';
import { Gateway } from './gateway.js';
import { meshNode } from './launch.js';
import { sample } from './schema.js';

/**
 * The demo's friends answer tasks: bob and mia (simulated mesh nodes, see network-demo.ts)
 * each get a real gateway with a simulated Claude. bob trusts you, so your requests run at
 * once; mia has you on "Ask me each time" and approves after a moment. Writing "Claude" to
 * either of them in a direct message makes their Claude ask yours something back.
 */

interface Persona {
  readonly name: 'bob' | 'mia';
  /** Their trust in you. */
  readonly trust: TrustLevel;
  readonly note: string;
  readonly projects: readonly string[];
  /** What they answer, by what was asked. */
  readonly answers: ReadonlyArray<{ readonly match: RegExp; readonly steps: readonly string[]; readonly summary: string }>;
  readonly fallback: string;
  /** What their Claude asks yours when you mention Claude to them. */
  readonly asksBack: string;
}

const PERSONAS: Readonly<Record<'bob' | 'mia', Persona>> = {
  bob: {
    name: 'bob',
    trust: 'trusted',
    note: 'the API, staging deploys and test runs',
    projects: ['bob-api'],
    answers: [
      { match: /test/i, steps: ['Read package.json', 'Bash npm test', 'vitest: 27 passed, 2 skipped'], summary: 'All **27 tests** pass on `main` in bob-api (2 skipped: the Stripe sandbox ones). Coverage is 87%.' },
      { match: /deploy|staging|version|live/i, steps: ['Bash git log -1 --oneline', 'Bash curl -s staging/health', 'Read deploy.yml'], summary: 'Staging runs **v2.3.1** (deployed 40 minutes ago from `main`); the health check is green.' },
      { match: /endpoint|route|api/i, steps: ['Glob src/routes/**', 'Read src/routes/payments.ts'], summary: 'bob-api exposes 6 routes; `/api/payments/*` needs a session since yesterday.' },
    ],
    fallback: 'Done. I looked into it in bob-api; nothing needed changing.',
    asksBack: 'Could you check the landing page links still work after the domain change? A short list of anything broken is enough.',
  },
  mia: {
    name: 'mia',
    trust: 'ask',
    note: 'landing page copy and design reviews',
    projects: ['landing'],
    answers: [
      { match: /copy|text|hero|landing|review/i, steps: ['Read content/hero.md', 'Read content/pricing.md', 'Grep "TODO"'], summary: 'The landing copy is final except the pricing footnote (one TODO). The hero reads well; I tightened the subtitle.' },
    ],
    fallback: 'Looked at it on my side: all good from the landing page.',
    asksBack: 'What does your auth middleware return for an expired session? I need the exact status code for the error page.',
  },
};

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    });
  });

/** Realistic values for fields the demo knows, the schema's shape for the rest. */
function fill(schema: unknown): unknown {
  const known: Record<string, unknown> = { passed: 27, failed: 0, skipped: 2, total: 29, coverage: 87, version: '2.3.1', status: 'green', url: 'https://staging.bob-api.dev', ok: true };
  const walk = (s: unknown, key?: string): unknown => {
    if (key && key in known) return known[key];
    if (s && typeof s === 'object' && !Array.isArray(s) && (s as { type?: unknown }).type === 'object') {
      const props = ((s as { properties?: Record<string, unknown> }).properties ?? {}) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(props).map(([k, v]) => [k, walk(v, k)]));
    }
    return sample(s);
  };
  return walk(schema);
}

/** A simulated Claude for a demo friend: a few steps, then an answer (with data when asked for). */
function demoClaude(persona: Persona): AgentBackend {
  return {
    async run(input: AgentRunInput): Promise<string> {
      const ask = /<request>\n([\s\S]*?)\n<\/request>/.exec(input.prompt)?.[1] ?? input.prompt;
      const script = persona.answers.find((a) => a.match.test(ask));
      for (const step of script?.steps ?? ['Read README.md', 'Glob src/**']) {
        await sleep(900, input.signal);
        input.onEvent('tool', step);
      }
      await sleep(700, input.signal);
      const summary = script?.summary ?? persona.fallback;
      const schema = /Schema:\n```json\n([\s\S]*?)\n```/.exec(input.prompt)?.[1];
      if (!schema) return summary;
      let data: unknown;
      try {
        data = fill(JSON.parse(schema));
      } catch {
        data = null;
      }
      return `${summary}\n\n\`\`\`klaud-result\n${JSON.stringify({ data })}\n\`\`\``;
    },
  };
}

/** Give a demo friend a gateway that answers your tasks. Returns how to stop it. */
export function demoResponder(mesh: Mesh, persona: 'bob' | 'mia', meId: string, base: string): { gateway: Gateway; stop: () => void; askBack: () => void } {
  const p = PERSONAS[persona];
  const store = new Store(initialState('room'));
  store.dispatch({ type: 'identity', selfId: mesh.peerId, isHost: false });
  const sync = (): void => store.dispatch({ type: 'net_summary', summary: mesh.summary() });
  mesh.on('change', sync);
  sync();
  store.dispatch({ type: 'trust_level', peerId: meId, level: p.trust });
  const folder = path.join(base, persona, 'work');
  mkdirSync(folder, { recursive: true });
  const gateway = new Gateway({
    store,
    dir: null,
    scratch: folder,
    selfId: () => mesh.peerId,
    selfName: () => p.name,
    agent: () => demoClaude(p),
    // "Ask me each time": mia looks at the request and approves it after a moment.
    approve: () => {
      let timer: NodeJS.Timeout | undefined;
      const answer = new Promise<'yes' | 'no'>((resolve) => {
        timer = setTimeout(() => resolve('yes'), 3500);
        timer.unref();
      });
      return { answer, withdraw: () => clearTimeout(timer) };
    },
    setTrust: () => undefined,
    serveShell: async (_from, ask, hooks) => {
      if (p.trust !== 'full') {
        hooks.onAsking();
        await new Promise((r) => setTimeout(r, 2500));
      }
      hooks.onStarted(`~/${p.projects[0]}`);
      const res = await demoShell(ask.command, folder, ask.timeoutSec * 1000);
      return { ok: true, output: res.output, truncated: res.truncated, timedOut: res.timedOut, cwd: `~/${p.projects[0]}`, ms: res.ms, ...(res.exitCode !== undefined ? { exitCode: res.exitCode } : {}) };
    },
    resume: () => undefined,
    projectRoot: (name) => (p.projects.includes(name) ? folder : undefined),
    projects: () => p.projects,
    loadNote: () => p.note,
    saveNote: () => undefined,
  });
  gateway.attachMesh(meshNode(mesh));
  return {
    gateway,
    stop: () => {
      mesh.off('change', sync);
      gateway.stop();
    },
    askBack: () => {
      try {
        const t = gateway.ask({ person: meId, ask: p.asksBack, by: 'agent' });
        // Their user said yes to asking you (it's a demo).
        if (t.state === 'confirm') gateway.confirm(t.id, true);
      } catch {
        // Not linked yet: the demo just doesn't ask.
      }
    },
  };
}
