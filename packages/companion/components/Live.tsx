import { BookOpen, Bot, Check, ChevronDown, CircleAlert, FilePlus2, FlaskConical, Globe, Hourglass, ListChecks, type LucideIcon, PenLine, Search, ShieldQuestion, Sparkles, SquareTerminal, Wrench } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import Animated, { Easing, FadeIn, FadeInDown, FadeOut, LinearTransition, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withSequence, withSpring, withTiming } from 'react-native-reanimated';
import { elapsed, useSince } from '../lib/hooks';
import type { LiveView, StepView, SubAgentView, TurnView } from '../lib/link/protocol';
import { color, spring } from '../lib/theme';
import { Press, T, type Tone, toneBg, toneInk } from './ui';

/**
 * Claude at work, live (BLG-43), as the Mac's chat draws it: what it's doing now (thinking,
 * writing, or the step it's on with its tool, how long, how far), the steps it took in words
 * (newest at the bottom, each sliding in), and its sub-agents with their own live steps.
 *
 * Calm motion: steps slide in, the step it's on breathes slowly, thinking and writing show a
 * soft typing shimmer. Pastel, no glow. The seconds are counted here; the Mac sends a view only
 * when something changes. Never code: steps come in words ("Edited store.ts").
 */

const TOOLS: Record<string, { Icon: LucideIcon; tone: Tone }> = {
  read: { Icon: BookOpen, tone: 'sky' },
  edit: { Icon: PenLine, tone: 'peach' },
  write: { Icon: FilePlus2, tone: 'peach' },
  search: { Icon: Search, tone: 'sky' },
  run: { Icon: SquareTerminal, tone: 'plain' },
  test: { Icon: FlaskConical, tone: 'mint' },
  web: { Icon: Globe, tone: 'sky' },
  agent: { Icon: Bot, tone: 'lavender' },
  plan: { Icon: ListChecks, tone: 'butter' },
  tool: { Icon: Wrench, tone: 'plain' },
};
export const toolOf = (kind: string | undefined): { Icon: LucideIcon; tone: Tone } => TOOLS[kind ?? 'tool'] ?? TOOLS.tool!;

/** A tool's icon in its pastel circle. */
export function ToolBadge({ kind, size = 24 }: { readonly kind?: string; readonly size?: number }) {
  const { Icon, tone } = toolOf(kind);
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: toneBg(tone) }}>
      <Icon color={toneInk(tone)} size={size * 0.54} strokeWidth={2.2} />
    </View>
  );
}

/** Three soft dots, one after another: Claude is thinking or writing. */
export function TypingDots({ tone = 'peach' }: { readonly tone?: Tone }) {
  return (
    <View style={{ flexDirection: 'row', gap: 3, alignItems: 'center', height: 10 }}>
      {[0, 1, 2].map((i) => (
        <Dot key={i} delay={i * 180} c={toneInk(tone)} />
      ))}
    </View>
  );
}
function Dot({ delay, c }: { readonly delay: number; readonly c: string }) {
  const o = useSharedValue(0.25);
  useEffect(() => {
    o.value = withDelay(delay, withRepeat(withSequence(withTiming(1, { duration: 420, easing: Easing.out(Easing.quad) }), withTiming(0.25, { duration: 520, easing: Easing.in(Easing.quad) })), -1));
  }, []);
  const st = useAnimatedStyle(() => ({ opacity: o.value, transform: [{ translateY: (1 - o.value) * 1.5 }] }));
  return <Animated.View style={[{ width: 5, height: 5, borderRadius: 3, backgroundColor: c }, st]} />;
}

/** Something breathing slowly while it runs (the step it's on, a sub-agent at work). */
export function Breathe({ children, on = true }: { readonly children: React.ReactNode; readonly on?: boolean }) {
  const o = useSharedValue(1);
  useEffect(() => {
    o.value = on ? withRepeat(withSequence(withTiming(0.5, { duration: 1100, easing: Easing.inOut(Easing.sin) }), withTiming(1, { duration: 1100, easing: Easing.inOut(Easing.sin) })), -1) : withTiming(1);
  }, [on]);
  const st = useAnimatedStyle(() => ({ opacity: o.value }));
  return <Animated.View style={st}>{children}</Animated.View>;
}

/** "137/215" as a fraction, when a count says how far a step has got. */
const fraction = (p: string | undefined): number | undefined => {
  const m = p ? /(\d+)\s*\/\s*(\d+)/.exec(p) : null;
  if (!m) return undefined;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return b > 0 ? Math.min(1, a / b) : undefined;
};

function Bar({ value, tone = 'mint' }: { readonly value: number; readonly tone?: Tone }) {
  const [w, setW] = useState(0);
  const x = useSharedValue(0);
  useEffect(() => {
    x.value = withSpring(value, spring.soft);
  }, [value]);
  const st = useAnimatedStyle(() => ({ width: Math.max(4, x.value * w) }));
  return (
    <View onLayout={(e) => setW(e.nativeEvent.layout.width)} style={{ height: 5, borderRadius: 3, backgroundColor: color.sunken, overflow: 'hidden' }}>
      <Animated.View style={[{ height: 5, borderRadius: 3, backgroundColor: toneInk(tone), opacity: 0.55 }, st]} />
    </View>
  );
}

const PHASE: Record<string, { label: string; Icon: LucideIcon; tone: Tone }> = {
  thinking: { label: 'Thinking', Icon: Sparkles, tone: 'peach' },
  writing: { label: 'Writing', Icon: PenLine, tone: 'peach' },
  starting: { label: 'Starting', Icon: Sparkles, tone: 'peach' },
  approval: { label: 'Waiting for your approval', Icon: ShieldQuestion, tone: 'butter' },
  queued: { label: 'Waiting its turn', Icon: Hourglass, tone: 'plain' },
};

/** What it does right now: the phase (with the typing shimmer) or the step, its time and its count. */
function NowRow({ live }: { readonly live: LiveView }) {
  const secs = useSince(live.since);
  const p = PHASE[live.phase];
  const frac = fraction(live.progress);
  const step = live.phase === 'step' || !p;
  const tool = step ? toolOf(live.tool) : undefined;
  const words = step ? (live.words ?? 'Working') : p!.label;
  return (
    <Animated.View key={`${live.phase}:${live.words ?? ''}`} entering={FadeInDown.duration(260)} layout={LinearTransition.springify().stiffness(220).damping(26)} style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Breathe>{step ? <ToolBadge kind={live.tool} size={28} /> : <PhaseBadge Icon={p!.Icon} tone={p!.tone} />}</Breathe>
        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <T v="callout" c={toneInk(tool?.tone && tool.tone !== 'plain' ? tool.tone : (p?.tone ?? 'peach'))} numberOfLines={1} style={{ fontWeight: '600', flexShrink: 1 }}>
            {words}
            {live.progress && !frac ? ` · ${live.progress}` : ''}
          </T>
          {live.phase === 'thinking' || live.phase === 'writing' || live.phase === 'starting' ? <TypingDots /> : null}
        </View>
        {secs !== undefined && secs >= 2 ? (
          <T v="caption" style={{ fontVariant: ['tabular-nums'] }}>
            {elapsed(secs)}
          </T>
        ) : null}
      </View>
      {frac !== undefined ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 38 }}>
          <View style={{ flex: 1 }}>
            <Bar value={frac} tone={tool?.tone === 'mint' ? 'mint' : 'sky'} />
          </View>
          <T v="caption" style={{ fontVariant: ['tabular-nums'] }}>
            {live.progress}
          </T>
        </View>
      ) : null}
    </Animated.View>
  );
}

function PhaseBadge({ Icon, tone }: { readonly Icon: LucideIcon; readonly tone: Tone }) {
  return (
    <View style={{ width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: toneBg(tone) }}>
      <Icon color={toneInk(tone)} size={15} strokeWidth={2.2} />
    </View>
  );
}

/** Steps in words, newest last; a long list shows its last few, the rest one tap away. */
export function StepList({ steps, shown = 5, live }: { readonly steps: readonly StepView[]; readonly shown?: number; /** The last step is the one it's on (its row breathes). */ readonly live?: boolean }) {
  const [all, setAll] = useState(false);
  const from = all ? 0 : Math.max(0, steps.length - shown);
  const hidden = from;
  return (
    <View style={{ gap: 2 }}>
      {hidden > 0 ? (
        <Press onPress={() => setAll(true)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4, paddingLeft: 4 }}>
          <ChevronDown color={color.text3} size={14} />
          <T v="caption">
            {hidden} earlier {hidden === 1 ? 'step' : 'steps'}
          </T>
        </Press>
      ) : null}
      {steps.slice(from).map((s, i, list) => {
        const last = i === list.length - 1;
        const on = Boolean(live && last);
        // Keyed by place in the whole list: a new step slides in, the others stay put.
        return (
          <Animated.View key={from + i} entering={FadeInDown.duration(280).springify().stiffness(220).damping(24)} layout={LinearTransition.springify().stiffness(220).damping(26)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 }}>
            <Breathe on={on}>
              <ToolBadge kind={s.tool} size={22} />
            </Breathe>
            <T v="callout" c={on ? color.text : color.text2} numberOfLines={1} style={{ flex: 1, fontSize: 13.5 }}>
              {s.text}
            </T>
            {!on ? <Check color={color.text3} size={13} /> : null}
          </Animated.View>
        );
      })}
    </View>
  );
}

/**
 * A running turn's live panel: what it's doing now on top of the steps it took. A Mac without
 * `live` (before 1.3) still has the step in words: it's shown as it was.
 */
export function LivePanel({ t }: { readonly t: TurnView }) {
  const live: LiveView = t.live ?? { phase: 'step', words: t.step ?? 'Working' };
  // While a step runs, its own row is the "now" row: the list holds the steps before it.
  const trail = t.trail ?? [];
  const done = live.phase === 'step' && trail.length ? trail.slice(0, -1) : trail;
  return (
    <View style={{ gap: 10, padding: 12, borderRadius: 16, backgroundColor: color.sunken }}>
      {done.length ? <StepList steps={done} shown={4} /> : null}
      <NowRow live={live} />
    </View>
  );
}

/** A finished turn's steps: "24 steps", and the list one tap away. */
export function StepsFold({ t }: { readonly t: TurnView }) {
  const [open, setOpen] = useState(false);
  const trail = t.trail ?? [];
  if (!trail.length) return null;
  return (
    <View>
      <Press onPress={() => setOpen((o) => !o)} accessibilityLabel={open ? 'Hide the steps' : 'Show the steps'} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start', height: 30, paddingHorizontal: 10, borderRadius: 15, backgroundColor: color.sunken }}>
        <View style={{ flexDirection: 'row' }}>
          {[...new Set(trail.map((s) => s.tool))].slice(0, 4).map((k, i) => (
            <View key={k} style={{ marginLeft: i ? -6 : 0, borderRadius: 11, borderWidth: 1.5, borderColor: color.card }}>
              <ToolBadge kind={k} size={18} />
            </View>
          ))}
        </View>
        <T v="caption" style={{ fontWeight: '600' }}>
          {(t.steps ?? trail.length) === 1 ? '1 step' : `${t.steps ?? trail.length} steps`}
        </T>
        <Animated.View style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}>
          <ChevronDown color={color.text3} size={14} />
        </Animated.View>
      </Press>
      {open ? (
        <Animated.View entering={FadeIn.duration(200)} exiting={FadeOut.duration(140)} style={{ marginTop: 8 }}>
          <StepList steps={trail} shown={12} />
        </Animated.View>
      ) : null}
    </View>
  );
}

const AGENT_TONE = (s: SubAgentView['status']): Tone => (s === 'running' ? 'lavender' : s === 'failed' ? 'rose' : 'mint');

/** The sub-agents of a run, each with what it's doing now (live), tap one for its steps and outputs. */
export function AgentList({ agents, onOpen }: { readonly agents: readonly SubAgentView[]; readonly onOpen: (a: SubAgentView) => void }) {
  const running = agents.filter((a) => a.status === 'running').length;
  return (
    <View style={{ gap: 6 }}>
      <T v="caption" style={{ fontWeight: '600' }}>
        {agents.length} {agents.length === 1 ? 'sub-agent' : 'sub-agents'}
        {running ? ` · ${running} working` : ''}
      </T>
      {agents.map((a) => {
        const tone = AGENT_TONE(a.status);
        const Icon = a.status === 'done' ? Check : a.status === 'failed' ? CircleAlert : Bot;
        const now = a.status === 'running' ? (a.step ?? a.steps.at(-1)) : (a.trail?.at(-1)?.text ?? a.steps.at(-1));
        return (
          <Animated.View key={a.id} entering={FadeInDown.duration(260)} layout={LinearTransition.springify().stiffness(220).damping(26)}>
            <Press scaleTo={0.985} onPress={() => onOpen(a)} accessibilityLabel={a.title} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: 14, backgroundColor: toneBg(tone) }}>
              <Breathe on={a.status === 'running'}>
                <View style={{ width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: color.card }}>
                  <Icon color={toneInk(tone)} size={14} strokeWidth={2.3} />
                </View>
              </Breathe>
              <View style={{ flex: 1, gap: 1 }}>
                <T v="callout" c={toneInk(tone)} numberOfLines={1} style={{ fontWeight: '600' }}>
                  {a.title}
                </T>
                {now ? (
                  <Animated.View key={now} entering={FadeInDown.duration(220)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    {a.status === 'running' && a.tool ? <ToolBadge kind={a.tool} size={16} /> : null}
                    <T v="caption" c={toneInk(tone)} numberOfLines={1} style={{ flex: 1, opacity: 0.85 }}>
                      {now}
                    </T>
                  </Animated.View>
                ) : null}
              </View>
              {a.outputs.length ? (
                <T v="caption" c={toneInk(tone)} style={{ fontWeight: '700' }}>
                  {a.outputs.length}
                </T>
              ) : null}
            </Press>
          </Animated.View>
        );
      })}
    </View>
  );
}
