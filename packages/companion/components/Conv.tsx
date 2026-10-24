import { router } from 'expo-router';
import { Bot, Check, ChevronRight, CircleAlert, Hourglass, Images, MessageSquare } from 'lucide-react-native';
import { ProjectMark } from './ProjectMark';
import { Fragment, type ReactNode } from 'react';
import { Image } from 'expo-image';
import { Linking, Text, View } from 'react-native';
import { Block } from './render/Block';
import { CodeChip } from './render/CodeChip';
import { InlineThing } from './render/Inline';
import { ViewCard } from './render/ViewCard';
import { readInline, splitInlineMath, tableView } from '../lib/render';
import { InlineMath, type MathMap } from './render/MathBlock';
import Animated, { FadeInDown, FadeOutUp } from 'react-native-reanimated';
import { ago } from '../lib/hooks';
import type { ConvSummary, ProseView, SubAgentView, Topic } from '../lib/link/protocol';
import { color, tint, type } from '../lib/theme';
import { Card, IconBadge, Press, T, type Tone, toneInk } from './ui';

/** Pieces of a conversation: Claude's prose (code folded), the live step, sub-agents. */

export const convHref = (topic: string): string => `/conv/${encodeURIComponent(topic.replace(/^conv:/, ''))}`;
export const chatHref = (topic: string): string => `/chat/${encodeURIComponent(topic.replace(/^chat:/, ''))}`;

/** Base text style the inline pieces build on. */
type Base = { readonly fontSize: number; readonly color: string } & object;

/**
 * Words with their inline math (BLG-87): each `$…$` drawn as the Mac typeset it (or its TeX).
 * Prices ("$5 and $10") stay words (splitInlineMath).
 */
function withMath(s: string, base: Base, math: MathMap | undefined, key: () => number, bold = false): ReactNode[] {
  if (!s.includes('$')) return [s];
  return splitInlineMath(s).map((p) => ('tex' in p ? <InlineMath key={key()} tex={p.tex} {...(math ? { math } : {})} size={base.fontSize} ink={bold ? color.text : base.color} /> : p.text.replace(/\\\$/g, () => '$')));
}

/**
 * Inline: **bold**, `code` (an inline element when it reads as one: docs/views.md), [links](…),
 * and `$math$` in the words and bold around them (never inside code).
 */
function inline(s: string, base: Base, math?: MathMap): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]\n]+\]\([^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  const key = () => i++;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(...withMath(s.slice(last, m.index), base, math, key));
    const tok = m[0];
    if (tok.startsWith('**')) out.push(<Text key={i++} style={[base, { fontWeight: '700', color: color.text }]}>{withMath(tok.slice(2, -2), base, math, key, true)}</Text>);
    else if (tok.startsWith('[')) {
      const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)!;
      const href = lm[2]!;
      // A web link opens; anything else (a path on the Mac) reads as its words.
      out.push(
        /^https?:\/\//.test(href) ? (
          <Text key={i++} onPress={() => void Linking.openURL(href)} style={[base, { color: color.info, textDecorationLine: 'underline' }]}>
            {lm[1]}
          </Text>
        ) : (
          <Text key={i++} style={[base, { fontWeight: '600' }]}>
            {lm[1]}
          </Text>
        ),
      );
    } else {
      const el = readInline(tok.slice(1, -1));
      out.push(el ? <InlineThing key={i++} el={el} /> : <Text key={i++} style={[base, type.mono, { fontSize: 13.5, color: color.claude, backgroundColor: tint.claude }]}>{` ${tok.slice(1, -1)} `}</Text>);
    }
    last = m.index + tok.length;
  }
  if (last < s.length) out.push(...withMath(s.slice(last), base, math, key));
  return out;
}

export { CodeChip };

/** A Markdown table's cells (`| a | b |`). */
const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim().replace(/\*\*/g, '').replace(/`/g, ''));
const isRule = (line: string): boolean => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

/**
 * Claude's words: paragraphs, bullets, headings, Markdown tables (drawn as table views, as on the
 * Mac), pictures from the web, and what it drew (views, graphs, tasks: components/render), with
 * any other code folded into a chip. `at`: the conversation and turn, for a live view's rows.
 */
export function Prose({ prose, color: tone = color.text, size = 15.5, at }: { readonly prose: ProseView; readonly color?: string; readonly size?: number; readonly at?: { topic: Topic; turn: string } }) {
  const base = { ...type.body, fontSize: size, lineHeight: size * 1.42, color: tone };
  type Block = { kind: 'p'; lines: string[] } | { kind: 'ul'; items: string[] } | { kind: 'h'; text: string } | { kind: 'code'; n: number } | { kind: 'table'; lines: string[] } | { kind: 'img'; alt: string; src: string };
  const blocks: Block[] = [];
  const lines = prose.text.split('\n');
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!.trimEnd();
    const last = blocks.at(-1);
    const marker = /^\s*\[\[code:(\d+)\]\]\s*$/.exec(line);
    const bullet = /^\s*(?:[-*]|\d+\.) (.*)/.exec(line);
    const heading = /^#{1,3} (.*)/.exec(line) ?? /^\*\*([^*]+)\*\*:?$/.exec(line);
    const img = /^\s*!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)\s*$/.exec(line);
    if (/^\s*\|.*\|\s*$/.test(line) && isRule(lines[li + 1] ?? '')) {
      // A table: its heading, the rule, and the rows after it.
      const t: string[] = [line];
      li += 1;
      while (li + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[li + 1]!)) t.push(lines[++li]!);
      blocks.push({ kind: 'table', lines: t });
    } else if (!line.trim()) blocks.push({ kind: 'p', lines: [] });
    else if (marker) blocks.push({ kind: 'code', n: Number(marker[1]) });
    else if (img) blocks.push({ kind: 'img', alt: img[1]!, src: img[2]! });
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
          if (c?.block) return <Block key={bi} entry={c} {...(at ? { at: { ...at, block: b.n } } : {})} {...(prose.math ? { math: prose.math } : {})} />;
          return <CodeChip key={bi} lang={c?.lang} lines={c?.lines ?? 0} />;
        }
        if (b.kind === 'table') {
          const [head, ...rows] = b.lines;
          const view = tableView({ columns: cells(head!), rows: rows.map(cells) });
          return view ? <ViewCard key={bi} view={view} /> : <Text key={bi} style={base}>{b.lines.join('\n')}</Text>;
        }
        if (b.kind === 'img') return <WebImage key={bi} src={b.src} alt={b.alt} />;
        if (b.kind === 'h') {
          return (
            <Text key={bi} style={[base, { fontWeight: '700', marginTop: bi ? 4 : 0, marginBottom: -3 }]}>
              {inline(b.text, base, prose.math)}
            </Text>
          );
        }
        if (b.kind === 'ul') {
          return (
            <View key={bi} style={{ gap: 6 }}>
              {b.items.map((item, li) => (
                <View key={li} style={{ flexDirection: 'row', gap: 10, paddingRight: 6 }}>
                  <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: color.text3, marginTop: size * 0.6 }} />
                  <Text style={[base, { flex: 1 }]}>{inline(item, base, prose.math)}</Text>
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
                {inline(l.replace(/\[\[code:(\d+)\]\]/g, (_, n) => `‹code · ${prose.code[Number(n)]?.lines ?? 0} lines›`), base, prose.math)}
              </Fragment>
            ))}
          </Text>
        );
      })}
    </View>
  );
}

/** A picture from the web in Claude's words (a path on the Mac comes as an output instead). */
function WebImage({ src, alt }: { readonly src: string; readonly alt: string }) {
  return (
    <View style={{ borderRadius: 14, overflow: 'hidden', backgroundColor: color.sunken }}>
      <Image source={{ uri: src }} style={{ width: '100%', aspectRatio: 16 / 10 }} contentFit="cover" transition={200} accessibilityLabel={alt} />
      {alt ? <T v="caption" style={{ padding: 8 }}>{alt}</T> : null}
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
