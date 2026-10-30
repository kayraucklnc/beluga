import type { ComponentType } from 'react';
import Svg, { Path } from 'react-native-svg';
import { AGENT_MARK_PATHS, type AgentMark, runtimeMark } from '../../../src/shared/agent-marks';
import { color as palette } from '../lib/theme';

export type { AgentMark };
export { agentMark, modelMark, runtimeMark } from '../../../src/shared/agent-marks';

/**
 * An agent's or a model maker's mark (BLG-497): Claude Code, Codex, a local model, Anthropic,
 * OpenAI. The same path data as the Mac (src/shared/agent-marks.ts), on its 16×16 grid with 1.5
 * strokes, round caps and joins, no fill, in the ink it's given (the text's, by default). Always
 * beside the agent's name, never instead of it.
 */
export function AgentMarkIcon({ mark, size = 16, color }: { readonly mark: AgentMark; readonly size?: number; readonly color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16" fill="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Path d={AGENT_MARK_PATHS[mark]} stroke={color ?? palette.text} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </Svg>
  );
}

/** What an icon slot takes (a lucide icon, or a mark below): its ink and size. */
export type IconLike = ComponentType<{ color?: string; size?: number; strokeWidth?: number | string }>;

const ICONS = new Map<AgentMark, IconLike>();

/** A mark as an icon slot's component (Options rows, IconBadge), made once per mark. */
export function markIcon(mark: AgentMark): IconLike {
  let Icon = ICONS.get(mark);
  if (!Icon) {
    const Made = ({ color, size }: { color?: string; size?: number }) => <AgentMarkIcon mark={mark} {...(size !== undefined ? { size } : {})} {...(color !== undefined ? { color } : {})} />;
    Made.displayName = `AgentMark(${mark})`;
    Icon = Made;
    ICONS.set(mark, Icon);
  }
  return Icon;
}

/**
 * An agent's mark when all the phone has is its name ("Your Codex", "mia's Claude", "Codex"):
 * the name says Codex or Claude, else `fallback` (a runtime, when known), else a local model's.
 * Only where the Mac sends no agent ref.
 */
export function markOfName(name: string, fallback?: string): AgentMark {
  if (/\bcodex\b/i.test(name)) return 'codex';
  if (/\bclaude\b/i.test(name)) return 'claudeCode';
  if (/\blocal model\b/i.test(name)) return 'localModel';
  return fallback !== undefined ? runtimeMark(fallback) : 'localModel';
}

/**
 * Whether a task's activity line is an agent's (the board names it "Your Claude", "mia's Codex"):
 * a person is "You" or their name, Beluga is "Beluga".
 */
export function isAgentActor(who: string): boolean {
  return /^your\s/i.test(who) || /['’]s\s\S/.test(who);
}
