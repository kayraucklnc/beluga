import { router } from 'expo-router';
import { Bot, Check, ChevronRight, CircleAlert, Code, Hourglass, Images, MessageSquare } from 'lucide-react-native';
import { ProjectMark } from './ProjectMark';
import { Fragment, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import Animated, { FadeInDown, FadeOutUp } from 'react-native-reanimated';
import { ago } from '../lib/hooks';
import type { ConvSummary, ProseView, SubAgentView } from '../lib/link/protocol';
import { store } from '../lib/store';
import { color, tint, type } from '../lib/theme';
import { Card, IconBadge, Press, T, type Tone, toneInk } from './ui';

/** Pieces of a conversation: Claude's prose (code folded), the live step, sub-agents. */

export const convHref = (topic: string): string => `/conv/${encodeURIComponent(topic.replace(/^conv:/, ''))}`;
export const chatHref = (topic: string): string => `/chat/${encodeURIComponent(topic.replace(/^chat:/, ''))}`;

/** Inline: **bold** and `code` (a word in code is text; a code block never comes). */
function inline(s: string, base: object): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) out.push(<Text key={i++} style={[base, { fontWeight: '700', color: color.text }]}>{tok.slice(2, -2)}</Text>);
    else out.push(<Text key={i++} style={[base, type.mono, { fontSize: 13.5, color: color.claude, backgroundColor: tint.claude }]}>{` ${tok.slice(1, -1)} `}</Text>);
    last = m.index + tok.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

/** A code block Claude wrote, folded to a chip: no code on the phone. */
export function CodeChip({ lang, lines }: { readonly lang?: string; readonly lines: number }) {
  return (
    <Press onPress={() => store.toast({ text: 'Code stays on your Mac.', tone: 'info' })} style={{ alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 7, height: 32, paddingHorizontal: 12, borderRadius: 12, backgroundColor: color.code }}>
      <Code color={color.text2} size={15} strokeWidth={2.2} />
      <T v="caption" c={color.text2} style={{ fontWeight: '600' }}>
        Code · {lines} {lines === 1 ? 'line' : 'lines'}
      </T>
    </Press>
  );
}

export function Prose({ prose, color: tone = color.text, size = 15.5 }: { readonly prose: ProseView; readonly color?: string; readonly size?: number }) {
  const base = { ...type.body, fontSize: size, lineHeight: size * 1.42, color: tone };
  // Blocks: paragraphs, runs of bullets, headings, and code markers (each a chip).
  type Block = { kind: 'p'; lines: string[] } | { kind: 'ul'; items: string[] } | { kind: 'h'; text: string } | { kind: 'code'; n: number };
  const blocks: Block[] = [];
  for (const raw of prose.text.split('\n')) {
    const line = raw.trimEnd();
    const last = blocks.at(-1);
    const marker = /^\s*\[\[code:(\d+)\]\]\s*$/.exec(line);
    const bullet = /^\s*(?:[-*]|\d+\.) (.*)/.exec(line);
    const heading = /^#{1,3} (.*)/.exec(line) ?? /^\*\*([^*]+)\*\*:?$/.exec(line);
    if (!line.trim()) blocks.push({ kind: 'p', lines: [] });
    else if (marker) blocks.push({ kind: 'code', n: Number(marker[1]) });
    else if (heading) blocks.push({ kind: 'h', text: heading[1]! });
    else if (bullet) {
      if (last?.kind === 'ul') last.items.push(bullet[1]!);
      else blocks.push({ kind: 'ul', items: [bullet[1]!] });
    } else if (last?.kind === 'p') last.lines.push(line);
    else blocks.push({ kind: 'p', lines: [line] });
  }
  const shown = blocks.filter((b) => b.kind !== 'p' || b.lines.length);
  return (
    <View style={{ gap: 9 }}>
      {shown.map((b, bi) => {
        if (b.kind === 'code') {
          const c = prose.code[b.n];
          return <CodeChip key={bi} lang={c?.lang} lines={c?.lines ?? 0} />;
        }
        if (b.kind === 'h') {
          return (
            <Text key={bi} style={[base, { fontWeight: '700', marginTop: bi ? 4 : 0, marginBottom: -3 }]}>
              {inline(b.text, base)}
            </Text>
          );
        }
        if (b.kind === 'ul') {
          return (
            <View key={bi} style={{ gap: 6 }}>
              {b.items.map((item, li) => (
                <View key={li} style={{ flexDirection: 'row', gap: 10, paddingRight: 6 }}>
                  <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: color.text3, marginTop: size * 0.6 }} />
                  <Text style={[base, { flex: 1 }]}>{inline(item, base)}</Text>
                </View>
              ))}
            </View>
          );
        }
        return (
          <Text key={bi} style={base}>
            {b.lines.map((l, li) => (
              <Fragment key={li}>
                {li > 0 ? '\n' : ''}
                {inline(l.replace(/\[\[code:(\d+)\]\]/g, (_, n) => `‹code · ${prose.code[Number(n)]?.lines ?? 0} lines›`), base)}
              </Fragment>
            ))}
          </Text>
        );
      })}
    </View>
  );
}

/** The live step: a calm dot, and each new step rolls up into place (counts change in place). */
export function StepTicker({ step, tone = 'peach', size = 13.5 }: { readonly step?: string; readonly tone?: Tone; readonly size?: number }) {
  if (!step) return null;
  const words = step.replace(/\d+/g, '#');
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, height: size * 1.6, overflow: 'hidden' }}>
      <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: toneInk(tone) }} />
      <Animated.View key={words} entering={FadeInDown.duration(260)} exiting={FadeOutUp.duration(160)} style={{ flex: 1 }}>
        <T v="callout" c={toneInk(tone)} numberOfLines={1} style={{ fontSize: size, fontWeight: '600', fontVariant: ['tabular-nums'] }}>
          {step}
        </T>
      </Animated.View>
    </View>
  );
}

/** Sub-agents as small lavender dots: filled while running, hollow when done. */
export function AgentDots({ count, done = 0 }: { readonly count: number; readonly done?: number }) {
  return (
    <View style={{ flexDirection: 'row', gap: 3, alignItems: 'center' }}>
      {Array.from({ length: Math.min(count, 6) }, (_, i) => (
        <View key={i} style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color.subagent }} />
      ))}
      {Array.from({ length: Math.min(done, 6) }, (_, i) => (
        <View key={`d${i}`} style={{ width: 6, height: 6, borderRadius: 3, borderWidth: 1.5, borderColor: color.subagent }} />
      ))}
    </View>
  );
}

const STATUS: Record<string, { Icon: typeof Bot; tone: Tone }> = {
  working: { Icon: Hourglass, tone: 'peach' },
  waiting: { Icon: CircleAlert, tone: 'butter' },
  failed: { Icon: CircleAlert, tone: 'rose' },
  idle: { Icon: MessageSquare, tone: 'plain' },
  done: { Icon: Check, tone: 'mint' },
};
export const statusIcon = (s: string) => STATUS[s] ?? STATUS.idle!;

/** A conversation in a list (Home's Running now). */
export function ConvCard({ c }: { readonly c: ConvSummary }) {
  const st = statusIcon(c.needsYou ? 'waiting' : c.status);
  const working = c.status === 'working';
  return (
    <Press scaleTo={0.985} onPress={() => router.push(convHref(c.topic))} style={{ marginHorizontal: 16 }}>
      <Card style={{ padding: 14, gap: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          {c.project && c.projectId ? (
            <View>
              <ProjectMark name={c.project} icon={c.icon} size={36} />
              {/* What it's doing, as a small badge on the project's mark. */}
              <View style={{ position: 'absolute', right: -4, bottom: -4, borderRadius: 10, borderWidth: 2, borderColor: color.card }}>
                <IconBadge Icon={st.Icon} tone={st.tone} size={18} />
              </View>
            </View>
          ) : (
            <IconBadge Icon={st.Icon} tone={st.tone} size={36} />
          )}
          <View style={{ flex: 1 }}>
            <T v="heading" numberOfLines={1}>
              {c.title}
            </T>
            <T v="caption" numberOfLines={1}>
              {[c.project, c.needsYou ? 'needs you' : undefined, ago(c.lastAt)].filter(Boolean).join(' · ')}
            </T>
          </View>
          {c.fresh ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, height: 24, paddingHorizontal: 8, borderRadius: 12, backgroundColor: tint.sky }}>
              <Images color={color.info} size={12} />
              <T v="caption" c={color.info} style={{ fontWeight: '700' }}>
                {c.fresh}
              </T>
            </View>
          ) : null}
          {c.agents ? <AgentDots count={c.agents} /> : null}
          <ChevronRight color={color.text3} size={18} />
        </View>
        {working && c.last ? <StepTicker step={c.last} /> : null}
      </Card>
    </Press>
  );
}

/** A row of sub-agent chips under a turn. */
export function AgentChips({ agents, onOpen }: { readonly agents: readonly SubAgentView[]; readonly onOpen: (a: SubAgentView) => void }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {agents.map((a) => {
        const t: Tone = a.status === 'running' ? 'lavender' : a.status === 'failed' ? 'rose' : 'mint';
        const Icon = a.status === 'done' ? Check : a.status === 'failed' ? CircleAlert : Bot;
        return (
          <Press key={a.id} onPress={() => onOpen(a)} style={{ flexDirection: 'row', alignItems: 'center', gap: 7, height: 34, paddingHorizontal: 12, borderRadius: 17, backgroundColor: tint[t] }}>
            <Icon color={toneInk(t)} size={15} strokeWidth={2.3} />
            <T v="caption" c={toneInk(t)} numberOfLines={1} style={{ fontWeight: '600', maxWidth: 200 }}>
              {a.title}
            </T>
            {a.outputs.length ? (
              <T v="caption" c={toneInk(t)} style={{ opacity: 0.7, fontWeight: '700' }}>
                {a.outputs.length}
              </T>
            ) : null}
          </Press>
        );
      })}
    </View>
  );
}
