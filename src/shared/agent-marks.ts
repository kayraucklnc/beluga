import type { AgentRef } from '../protocol.js';

/**
 * The marks agents and models are known by (BLG-497): one per runtime (Claude Code, Codex, a
 * local model) and one per model maker (Anthropic, OpenAI). Pickers, chips and avatars show the
 * mark with the name beside it, never instead of it. Drawn on the app's 16×16 grid with 1.5
 * strokes, as path data both the Mac (components/Icon.tsx) and the phone draw, so the two match.
 * Browser-safe, types only.
 */

export type AgentMark = 'claudeCode' | 'codex' | 'localModel' | 'anthropic' | 'openai';

export const AGENT_MARK_PATHS: Readonly<Record<AgentMark, string>> = {
  /** Claude Code: Claude's spark, eight rays. */
  claudeCode: 'M8 2v4 M8 10v4 M2 8h4 M10 8h4 M3.75 3.75l2.8 2.8 M9.45 9.45l2.8 2.8 M3.75 12.25l2.8-2.8 M9.45 6.55l2.8-2.8',
  /** Codex: a cloud with a prompt in it. */
  codex: 'M4.6 12.5a3 3 0 0 1-.5-5.95 4 4 0 0 1 7.8-.5A3.2 3.2 0 0 1 11.6 12.5z M6.1 8.4l1.4 1.2-1.4 1.2 M8.9 10.8h1.7',
  /** A local model: a chip. */
  localModel: 'M4.5 4.5h7v7h-7z M6.5 2.5v2 M9.5 2.5v2 M6.5 11.5v2 M9.5 11.5v2 M2.5 6.5h2 M2.5 9.5h2 M11.5 6.5h2 M11.5 9.5h2 M6.5 6.5h3v3h-3z',
  /** Anthropic: its A. */
  anthropic: 'M2.75 13.25L6.9 2.75h2.2l4.15 10.5 M5 9.75h6',
  /** OpenAI: a knot of six petals. */
  openai: 'M8 2.5l4.75 2.75v5.5L8 13.5l-4.75-2.75v-5.5z M8 5.25l2.4 1.4v2.7L8 10.75l-2.4-1.4v-2.7z M8 2.5v2.75 M12.75 5.25L10.4 6.65 M12.75 10.75L10.4 9.35 M8 13.5v-2.75 M3.25 10.75l2.35-1.4 M3.25 5.25l2.35 1.4',
};

/** A runtime's mark: Claude Code, Codex, or a local model (anything else Beluga runs). */
export function runtimeMark(runtime: string | undefined): AgentMark {
  return runtime === undefined || runtime === 'claude' ? 'claudeCode' : runtime === 'codex' ? 'codex' : 'localModel';
}

/** An agent's mark (its runtime's); no ref: Claude's (an older Mac's agent). */
export function agentMark(ref: Pick<AgentRef, 'runtime'> | undefined): AgentMark {
  return runtimeMark(ref?.runtime);
}

/** Who made a model, by its id: Anthropic's, OpenAI's, or one of your own (a local model). */
export function modelMark(model: string | undefined, runtime: string): AgentMark {
  const m = (model ?? '').toLowerCase();
  if (runtime === 'claude' || /^(claude|opus|sonnet|haiku)/.test(m)) return 'anthropic';
  if (runtime === 'codex' || /^(gpt|o\d|codex|chatgpt)/.test(m)) return 'openai';
  return 'localModel';
}
