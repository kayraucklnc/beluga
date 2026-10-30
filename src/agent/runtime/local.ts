import type { AgentBackend, AgentRunInput, FollowUp, Steer } from '../types.js';
import { CLAUDE_CAPABILITIES, claudeRuntime } from './claude/index.js';
import type { AgentRuntime } from './types.js';

/** The endpoint a picked model value names (core/local-endpoints.ts resolves it). */
export interface LocalTarget {
  readonly label: string;
  readonly baseUrl: string;
  readonly key?: string;
  readonly model: string;
}

/**
 * The variables that point Claude Code at an endpoint and keep it off Anthropic (BLG-449): every
 * request goes to `baseUrl`, every model alias (and sub-agents, and the small fast model) is the
 * endpoint's model, and Claude Code's own traffic (telemetry, error reports, updates) stays off.
 * The key is the endpoint's, never your Claude login: without one, a placeholder (Ollama takes any),
 * so your Anthropic sign-in never goes to someone else's server.
 */
export function endpointEnv(t: LocalTarget): Record<string, string> {
  const m = t.model;
  return {
    ANTHROPIC_BASE_URL: t.baseUrl,
    ANTHROPIC_AUTH_TOKEN: t.key || 'ollama',
    ANTHROPIC_API_KEY: '',
    CLAUDE_CODE_OAUTH_TOKEN: '',
    CLAUDE_CODE_USE_BEDROCK: '',
    CLAUDE_CODE_USE_VERTEX: '',
    ANTHROPIC_MODEL: m,
    ANTHROPIC_DEFAULT_OPUS_MODEL: m,
    ANTHROPIC_DEFAULT_SONNET_MODEL: m,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: m,
    ANTHROPIC_SMALL_FAST_MODEL: m,
    CLAUDE_CODE_SUBAGENT_MODEL: m,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_BUG_COMMAND: '1',
  };
}

/**
 * A local or bring-your-own model: Claude Code, the same harness and tools, pointed at an
 * Anthropic-compatible endpoint (Ollama first) through the run's env. Not a new agent: config on
 * the Claude runtime. A run's model is "<endpoint id>/<model>"; `resolve` finds the endpoint.
 * Side calls (naming a worktree…) stay with your default agent (router.ts).
 */
export function localRuntime(resolve: (value: string | undefined) => LocalTarget | undefined): AgentRuntime {
  return {
    id: 'local',
    label: 'Local model',
    // Claude Code does the gating, so every guarantee holds; the endpoint lists its own models.
    capabilities: { ...CLAUDE_CAPABILITIES, hasModelList: false },
    create: (opts) => {
      const claude = claudeRuntime.create({ ...opts, model: undefined });
      return Object.assign(Object.create(claude) as AgentBackend, {
        run: (input: AgentRunInput) => {
          const value = input.model ?? input.place?.agent?.model;
          const target = resolve(value);
          if (!target) return Promise.reject(new Error("That local model isn't set up on this Mac any more. Pick another in Settings › Local models."));
          return claude.run(onEndpoint(input, target, (v) => resolve(v)));
        },
      });
    },
    complete: (req) => claudeRuntime.complete(req),
  };
}

/** The run, on the endpoint: its env over yours, its model's own name, no effort (endpoints don't take it). */
export function onEndpoint(input: AgentRunInput, target: LocalTarget, resolve: (value: string | undefined) => LocalTarget | undefined): AgentRunInput {
  // A model picked mid-run on the same endpoint switches; one elsewhere waits for the next run.
  const mapFollowUp = (f: FollowUp): FollowUp => {
    if (f.model === undefined) return f;
    const next = resolve(f.model);
    const { model: _m, ...rest } = f;
    return next && next.baseUrl === target.baseUrl ? { ...rest, model: next.model } : rest;
  };
  const { effort: _e, ...rest } = input;
  return {
    ...rest,
    model: target.model,
    env: { ...input.env, ...endpointEnv(target) },
    ...(input.onFollowUps ? { onFollowUps: (send) => input.onFollowUps!(send && ((f) => send(mapFollowUp(f)))) } : {}),
    ...(input.onSteer ? { onSteer: (steer) => input.onSteer!(steer && wrapSteer(steer, mapFollowUp)) } : {}),
  };
}

function wrapSteer(steer: Steer, map: (f: FollowUp) => FollowUp): Steer {
  return Object.assign((f: FollowUp) => steer(map(f)), {
    ...(steer.status ? { status: steer.status } : {}),
    ...(steer.interrupt ? { interrupt: (f: FollowUp, note: string) => steer.interrupt!(map(f), note) } : {}),
    ...(steer.force ? { force: (f: FollowUp, note: string) => steer.force!(map(f), note) } : {}),
  });
}
