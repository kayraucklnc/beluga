import { useMemo, useRef, useState } from 'react';
import { ScrollView, type ScrollViewInstance, Text, View } from 'react-native';
import { type CalendarDay, type Column, type GanttBar, type Row, type View as ViewSpec, along, barTone, formatCell, formatNumber, inkOn, parseColor, planCalendar, planGantt, planHeatmap, scaleColor, scaleOf } from '../../lib/render';
import { alpha, color, ink, scheme, tint, type } from '../../lib/theme';
import { haptic, Press, T } from '../ui';

/**
 * Gantt, heatmap and calendar views on the phone (BLG-87), drawn from the shared plans
 * (src/shared/render/grid-model.ts) with plain views: bars, cells and days to tap for their
 * details. Wider than the screen, they scroll sideways. Soft pastels, light and dark.
 */

type Props = { readonly view: ViewSpec; readonly rows: readonly Row[]; readonly columns: readonly Column[] };

const DAY = 86_400_000;
const dark = (): boolean => scheme === 'dark';

function Empty({ what }: { readonly what: string }) {
  return (
    <T v="callout" style={{ paddingHorizontal: 14, paddingVertical: 8 }}>
      {what}
    </T>
  );
}

function Details({ children }: { readonly children: React.ReactNode }) {
  return <View style={{ marginHorizontal: 12, marginTop: 8, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 12, backgroundColor: color.sunken, gap: 2 }}>{children}</View>;
}

const valueText = (v: number | null, col: Column | undefined): string => (v === null ? '–' : col ? formatCell(v, col) : formatNumber(v));

// ---------------------------------------------------------------- gantt

const LABEL_W = 112;
const ROW_H = 30;
const AXIS_H = 22;

/** A bar's fill, its done part and its ink, by the status's pastel ('neutral': grey). */
function barColors(status: string | undefined): { fill: string; done: string; ink: string } {
  const t = barTone(status);
  if (t === 'neutral') return { fill: color.hairlineStrong, done: alpha(dark() ? '#ECECEE' : '#1D1D1F', 0.28), ink: color.text2 };
  const i = ink[t];
  return dark() ? { fill: alpha(i, 0.4), done: alpha(i, 0.7), ink: i } : { fill: tint[t], done: alpha(i, 0.38), ink: i };
}

export function GanttView({ view, rows, columns }: Props) {
  const plan = useMemo(() => planGantt(view, rows, columns), [view, rows, columns]);
  const [space, setSpace] = useState(0);
  const [picked, setPicked] = useState<GanttBar | undefined>();
  if (!plan) return <Empty what="No dates to draw." />;
  const W = Math.max(space - LABEL_W, plan.ticks.length * 56, 160);
  const X = (t: number): number => 10 + along(plan, t) * (W - 20);
  const fmt = (t: number): string => new Date(t).toLocaleDateString(undefined, plan.hours ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric', year: 'numeric' });
  // A date alone ends at the end of its day: show the day it ends on.
  const endOf = (b: GanttBar): number => (!plan.hours && b.end > b.start ? b.end - 1 : b.end);
  type Item = { kind: 'lane'; name: string } | { kind: 'bar'; bar: GanttBar };
  const items: Item[] = plan.lanes.flatMap((l): Item[] => [...(l.name && plan.lanes.length > 1 ? [{ kind: 'lane' as const, name: l.name }] : []), ...l.bars.map((bar) => ({ kind: 'bar' as const, bar }))]);
  const rowH = (it: Item): number => (it.kind === 'lane' ? 24 : ROW_H);
  const height = items.reduce((a, it) => a + rowH(it), 0);
  return (
    <View onLayout={(e) => setSpace(e.nativeEvent.layout.width)}>
      <View style={{ flexDirection: 'row' }}>
        {/* Labels stay put; the time runs sideways. */}
        <View style={{ width: LABEL_W, paddingLeft: 14, paddingTop: AXIS_H }}>
          {items.map((it, i) =>
            it.kind === 'lane' ? (
              <View key={i} style={{ height: 24, justifyContent: 'flex-end', paddingBottom: 3 }}>
                <T v="caption" numberOfLines={1} style={{ fontWeight: '700', color: color.text2 }}>
                  {it.name}
                </T>
              </View>
            ) : (
              <View key={i} style={{ height: ROW_H, justifyContent: 'center', paddingRight: 8 }}>
                <Text numberOfLines={1} style={{ ...type.caption, color: picked === it.bar ? color.text : color.text2, fontWeight: picked === it.bar ? '700' : '500' }}>
                  {it.bar.label || '–'}
                </Text>
              </View>
            ),
          )}
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flex: 1 }} contentContainerStyle={{ paddingRight: 14 }}>
          <View style={{ width: W, height: AXIS_H + height }}>
            {plan.ticks.map((tk) => (
              <View key={`g${tk.t}`} pointerEvents="none" style={{ position: 'absolute', left: X(tk.t), top: AXIS_H - 2, bottom: 0, width: 1, backgroundColor: color.hairline }} />
            ))}
            {plan.ticks.map((tk) => (
              <Text key={`l${tk.t}`} numberOfLines={1} style={{ ...type.caption, fontSize: 11, color: color.text3, position: 'absolute', top: 2, left: X(tk.t) + 3, width: Math.max(30, Math.min(80, W - X(tk.t) - 3)) }}>
                {tk.label}
              </Text>
            ))}
            {(() => {
              let y = AXIS_H;
              return items.map((it, i) => {
                const top = y;
                y += rowH(it);
                if (it.kind === 'lane') return null;
                const b = it.bar;
                const c = barColors(b.status);
                const on = picked === b;
                const pick = () => (haptic.tap(), setPicked(on ? undefined : b));
                if (b.milestone) {
                  return (
                    <Press key={i} haptics={false} onPress={pick} hitSlop={8} accessibilityLabel={`${b.label}, milestone`} style={{ position: 'absolute', left: X(b.start) - 9, top: top + ROW_H / 2 - 9, width: 18, height: 18, alignItems: 'center', justifyContent: 'center' }}>
                      <View style={{ width: 12, height: 12, borderRadius: 2, transform: [{ rotate: '45deg' }], backgroundColor: c.ink, borderWidth: on ? 2 : 0, borderColor: color.card }} />
                    </Press>
                  );
                }
                const left = X(b.start);
                const w = Math.max(6, X(b.end) - left);
                return (
                  <Press key={i} haptics={false} scaleTo={0.98} onPress={pick} hitSlop={{ top: 4, bottom: 4 }} accessibilityLabel={b.label} style={{ position: 'absolute', left, top: top + 6, width: w, height: ROW_H - 12, borderRadius: 6, backgroundColor: c.fill, overflow: 'hidden', borderWidth: on ? 1.5 : 0, borderColor: c.ink }}>
                    {b.progress !== undefined ? <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${b.progress * 100}%`, backgroundColor: c.done }} /> : null}
                  </Press>
                );
              });
            })()}
            {plan.today !== undefined ? (
              <View pointerEvents="none" style={{ position: 'absolute', left: X(plan.today) - 0.75, top: AXIS_H - 4, bottom: 0, width: 1.5, borderRadius: 1, backgroundColor: color.error, opacity: 0.55 }} />
            ) : null}
          </View>
        </ScrollView>
      </View>
      {picked ? (
        <Details>
          <T v="callout" c={color.text} style={{ fontWeight: '700' }} numberOfLines={2}>
            {picked.label || 'Untitled'}
          </T>
          <T v="caption">
            {[picked.milestone ? fmt(picked.start) : `${fmt(picked.start)} – ${fmt(endOf(picked))}`, picked.status, picked.progress !== undefined ? `${Math.round(picked.progress * 100)}% done` : undefined, !picked.milestone && !plan.hours ? `${Math.max(1, Math.round((picked.end - picked.start) / DAY))} d` : undefined].filter(Boolean).join(' · ')}
          </T>
        </Details>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------- heatmap

export function HeatmapView({ view, rows, columns }: Props) {
  const plan = useMemo(() => planHeatmap(view, rows, columns), [view, rows, columns]);
  const [space, setSpace] = useState(0);
  const [picked, setPicked] = useState<[number, number] | undefined>();
  if (!plan) return <Empty what="Nothing to draw." />;
  const scale = scaleOf(view, dark());
  const labelW = Math.min(110, Math.max(36, ...plan.ys.map((y) => y.length * 6.6 + 10)));
  const cell = Math.max(22, Math.min(44, Math.floor((space - labelW - 28) / Math.max(1, plan.xs.length))));
  const showValues = cell >= 34;
  const xLabelH = 20;
  const sel = picked ? { x: plan.xs[picked[0]]!, y: plan.ys[picked[1]]!, v: plan.cells[picked[1]]![picked[0]] ?? null } : undefined;
  return (
    <View onLayout={(e) => setSpace(e.nativeEvent.layout.width)}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 14 }}>
        <View>
          <View style={{ flexDirection: 'row', height: xLabelH, marginLeft: labelW }}>
            {plan.xs.map((x, xi) => (
              <Text key={xi} numberOfLines={1} style={{ width: cell, textAlign: 'center', ...type.caption, fontSize: 10.5, color: picked?.[0] === xi ? color.text : color.text3 }}>
                {x}
              </Text>
            ))}
          </View>
          {plan.ys.map((y, yi) => (
            <View key={yi} style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text numberOfLines={1} style={{ width: labelW, paddingRight: 8, ...type.caption, fontSize: 11.5, color: picked?.[1] === yi ? color.text : color.text2 }}>
                {y}
              </Text>
              {plan.xs.map((x, xi) => {
                const v = plan.cells[yi]![xi] ?? null;
                const bg = scaleColor(v, plan.min, plan.max, scale);
                const on = picked?.[0] === xi && picked[1] === yi;
                const rgb = parseColor(bg);
                return (
                  <Press key={xi} haptics={false} scaleTo={0.92} onPress={() => (haptic.tap(), setPicked(on ? undefined : [xi, yi]))} accessibilityLabel={`${y}, ${x}: ${valueText(v, plan.valueColumn)}`} style={{ width: cell, height: cell, padding: 1.5 }}>
                    <View style={{ flex: 1, borderRadius: 5, backgroundColor: bg, alignItems: 'center', justifyContent: 'center', borderWidth: on ? 2 : 0, borderColor: color.text }}>
                      {showValues && v !== null ? (
                        <Text numberOfLines={1} style={{ ...type.caption, fontSize: 10, color: rgb ? inkOn(rgb) : color.text, opacity: 0.8 }}>
                          {formatNumber(v, { compact: true })}
                        </Text>
                      ) : null}
                    </View>
                  </Press>
                );
              })}
            </View>
          ))}
        </View>
      </ScrollView>
      <Legend scale={scale} lo={valueText(plan.min, plan.valueColumn)} hi={valueText(plan.max, plan.valueColumn)} />
      {sel ? (
        <Details>
          <T v="callout" c={color.text} style={{ fontWeight: '700' }}>
            {valueText(sel.v, plan.valueColumn)}
          </T>
          <T v="caption">
            {sel.y} · {sel.x}
          </T>
        </Details>
      ) : null}
    </View>
  );
}

function Legend({ scale, lo, hi }: { readonly scale: readonly string[]; readonly lo: string; readonly hi: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingTop: 8 }}>
      <T v="caption" style={{ fontSize: 11 }}>
        {lo}
      </T>
      <View style={{ flexDirection: 'row', gap: 2 }}>
        {scale.map((c, i) => (
          <View key={i} style={{ width: 14, height: 10, borderRadius: 3, backgroundColor: c }} />
        ))}
      </View>
      <T v="caption" style={{ fontSize: 11 }}>
        {hi}
      </T>
    </View>
  );
}

// ---------------------------------------------------------------- calendar

const SQ = 12;
const GAP = 3;
const DOW = ['Mon', '', 'Wed', '', 'Fri', '', ''];

const dayDate = (k: string): Date => {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y!, m! - 1, d!);
};

export function CalendarView({ view, rows, columns }: Props) {
  const plan = useMemo(() => planCalendar(view, rows, columns), [view, rows, columns]);
  const [picked, setPicked] = useState<CalendarDay | undefined>();
  const scroll = useRef<ScrollViewInstance>(null);
  if (!plan) return <Empty what="No dates to draw." />;
  const scale = scaleOf(view, dark());
  const step = SQ + GAP;
  const unit = plan.valueColumn ? (plan.valueColumn.label ?? plan.valueColumn.key) : undefined;
  return (
    <View>
      <View style={{ flexDirection: 'row', paddingLeft: 14 }}>
        <View style={{ width: 28, paddingTop: 16 }}>
          {DOW.map((d, i) => (
            <Text key={i} style={{ height: step, ...type.caption, fontSize: 9.5, lineHeight: step, color: color.text3 }}>
              {d}
            </Text>
          ))}
        </View>
        {/* The latest days are where it opens. */}
        <ScrollView ref={scroll} horizontal showsHorizontalScrollIndicator={false} onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })} contentContainerStyle={{ paddingRight: 14 }}>
          <View>
            <View style={{ height: 16, width: plan.weeks.length * step }}>
              {plan.months.map((m, i) => (
                <Text key={i} numberOfLines={1} style={{ position: 'absolute', left: m.week * step, ...type.caption, fontSize: 10.5, color: color.text3, width: 40 }}>
                  {m.label}
                </Text>
              ))}
            </View>
            <View style={{ flexDirection: 'row', gap: GAP }}>
              {plan.weeks.map((w, wi) => (
                <View key={wi} style={{ gap: GAP }}>
                  {w.map((d) => {
                    const on = picked?.date === d.date;
                    return d.inside ? (
                      <Press key={d.date} haptics={false} scaleTo={0.85} onPress={() => (haptic.tap(), setPicked(on ? undefined : d))} hitSlop={1} accessibilityLabel={`${d.date}: ${valueText(d.value, plan.valueColumn)}`} style={{ width: SQ, height: SQ, borderRadius: 3, backgroundColor: scaleColor(d.value, plan.min, plan.max, scale), borderWidth: on ? 1.5 : 0, borderColor: color.text }} />
                    ) : (
                      <View key={d.date} style={{ width: SQ, height: SQ }} />
                    );
                  })}
                </View>
              ))}
            </View>
          </View>
        </ScrollView>
      </View>
      {picked ? (
        <Details>
          <T v="callout" c={color.text} style={{ fontWeight: '700' }}>
            {valueText(picked.value, plan.valueColumn)}
            {unit ? <Text style={{ fontWeight: '400', color: color.text2 }}> {unit}</Text> : null}
          </T>
          <T v="caption">{[dayDate(picked.date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }), picked.note].filter(Boolean).join(' · ')}</T>
        </Details>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingTop: 8, gap: 8 }}>
        <T v="caption" style={{ flex: 1 }}>
          {plan.days} {plan.days === 1 ? 'day' : 'days'} active · {valueText(plan.total, plan.valueColumn)} total
        </T>
        <View style={{ flexDirection: 'row', gap: 2, alignItems: 'center' }}>
          {scale.map((c, i) => (
            <View key={i} style={{ width: 10, height: 10, borderRadius: 2.5, backgroundColor: c }} />
          ))}
        </View>
      </View>
    </View>
  );
}

