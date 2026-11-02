import { router } from 'expo-router';
import { ChevronDown, ChevronRight, LayoutDashboard, MessagesSquare, Pin } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { useSupports, useView } from '../lib/hooks';
import { calls } from '../lib/link/calls';
import type { DashboardTileView, SentinelsView, Topic } from '../lib/link/protocol';
import { type Column, parseView, readJson } from '../lib/render';
import { convHref, Prose } from './Conv';
import { JsonTree } from './render/JsonTree';
import { store } from '../lib/store';
import { color, radius, tint, type } from '../lib/theme';
import { ChartView } from './render/Chart';
import { Spark } from './render/Inline';
import { ActionCell, TypedCell } from './TypedCell';
import { Card, Hairline, haptic, Press, Row, T } from './ui';

/**
 * Sentinel's dashboard on the phone (BLG-244, BLG-246, docs/sentinel.md §10): the tiles a Mac works
 * out (`DashboardView`), drawn with the phone's own parts: a number as a stat tile (its change in
 * the good / bad / quiet tone, a sparkline), a series with the views' chart (over time, or a kept
 * array), a table's first rows, a step's latest output (what Claude wrote, a service's JSON as a
 * tree or a table), the last headline of a sentinel, a divider. Home's row of three numbers, the
 * Sentinel screen's Dashboards rows and its Chat row live here too.
 */

export const dashboardHref = (id: string): string => `/dashboard/${encodeURIComponent(id)}`;
const sentinelPath = (topic: Topic): string => `/sentinel/${encodeURIComponent(topic.slice('sentinel:'.length))}`;

/** The compares, in the chips' order, and how a pinned one says itself. */
export const COMPARES = [
  { key: 'previous', label: 'Previous', vs: 'vs the run before' },
  { key: 'day', label: 'Yesterday', vs: 'vs yesterday' },
  { key: 'week', label: 'Last week', vs: 'vs last week' },
  { key: 'month', label: 'Last month', vs: 'vs last month' },
] as const;
export type CompareKey = (typeof COMPARES)[number]['key'];
/** A compare the phone doesn't know reads as the run before. */
export const compareOf = (k: string | undefined): CompareKey => (COMPARES.find((c) => c.key === k)?.key ?? 'previous');

/** A change's color: mint for the good way, rose for the bad, quiet otherwise. */
export const toneInkOf = (tone: string | undefined): string => (tone === 'good' ? color.ok : tone === 'bad' ? color.error : color.text3);

/** What a tile that can't draw says, quietly. */
const STATE_WORDS: Record<string, string> = { paused: 'paused', draft: 'a draft: turn it on', gone: 'gone', waiting: 'waiting for its first run' };
const stateWords = (state: string): string | undefined => (state === 'ok' ? undefined : (STATE_WORDS[state] ?? state));

function TileHead({ t, right }: { readonly t: DashboardTileView; readonly right?: React.ReactNode }) {
  const quiet = stateWords(t.state);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <T v="caption" numberOfLines={1} style={{ flex: 1, color: color.text2 }}>
        {t.title}
      </T>
      {quiet ? (
        <T v="caption" c={color.text3} numberOfLines={1}>
          {quiet}
        </T>
      ) : null}
      {right}
    </View>
  );
}

/** A tile's card (read at render time: the theme's colors change under it). */
const box = () => ({ borderRadius: radius.m, backgroundColor: color.card, borderWidth: 1, borderColor: color.hairline, padding: 12, gap: 6 }) as const;

// ---- a number

export function NumberTile({ t, compare, width }: { readonly t: DashboardTileView; readonly compare: CompareKey; readonly width: number }) {
  const pinned = t.pinned ? compareOf(t.pinned) : undefined;
  const key = pinned ?? compare;
  const d = t.deltas?.[key];
  const open = t.topic?.startsWith('sentinel:') ? t.topic : undefined;
  return (
    <Press scaleTo={0.98} disabled={!open} onPress={() => open && router.push(sentinelPath(open) as never)} accessibilityLabel={`${t.title}: ${t.value ?? stateWords(t.state) ?? ''}${d?.change ? `, ${d.change}` : ''}`} style={{ width }}>
      <View style={[box(), { minHeight: 112, opacity: t.state === 'ok' ? 1 : 0.75 }]}>
        <TileHead t={t} />
        <Text numberOfLines={1} adjustsFontSizeToFit style={{ ...type.title, fontSize: 24, color: t.value ? color.text : color.text3, fontVariant: ['tabular-nums'] }}>
          {t.value ?? '–'}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8 }}>
          <Text numberOfLines={2} style={{ ...type.caption, flex: 1, fontWeight: '700', color: toneInkOf(d?.tone), fontVariant: ['tabular-nums'] }}>
            {d?.change ?? (t.value ? 'no earlier run' : '')}
          </Text>
          {t.trend && t.trend.length > 1 ? <Spark values={t.trend.slice(-30)} w={44} h={18} c={d?.tone === 'bad' ? color.error : color.info} /> : null}
        </View>
        {pinned ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Pin color={color.text3} size={11} strokeWidth={1.9} />
            <T v="caption" c={color.text3} numberOfLines={1} style={{ fontSize: 11.5 }}>
              {COMPARES.find((c) => c.key === pinned)!.vs}
            </T>
          </View>
        ) : null}
      </View>
    </Press>
  );
}

// ---- a chart: the views' own chart, from the tile's series

/** A metric's unit as a chart column's kind ("currency:USD" → currency USD, "ms" → a number in ms). */
function unitColumn(key: string, label: string, unit: string): Column {
  if (unit.startsWith('currency:')) return { key, label, type: 'currency', currency: unit.slice('currency:'.length).toUpperCase().slice(0, 3) };
  if (unit === 'percent') return { key, label, type: 'percent' };
  if (unit === 'bytes') return { key, label, type: 'bytes' };
  if (unit === 'ms') return { key, label, type: 'number', unit: 'ms' };
  return { key, label, type: 'number' };
}

function ChartTile({ t }: { readonly t: DashboardTileView }) {
  const view = useMemo(() => {
    const c = t.chart;
    if (!c?.series.length) return undefined;
    const kind = c.kind === 'area' || c.kind === 'bar' ? c.kind : 'line';
    // A kept array (1.23): each point's label along the bottom.
    if (c.labels?.length) {
      const s0 = c.series[0]!;
      const parsed = parseView(JSON.stringify({ type: 'chart', chart: kind, x: 'x', y: [{ key: 'y', label: s0.label }], columns: [{ key: 'x', type: 'text' }, unitColumn('y', s0.label, c.unit)], data: s0.points.map(([i, v]) => ({ x: c.labels![i] ?? String(i + 1), y: v })), height: 170 }), 'chart');
      return parsed.ok ? parsed.view : undefined;
    }
    const byAt = new Map<number, Record<string, string | number | null>>();
    c.series.forEach((s, i) => {
      for (const [at, v] of s.points) {
        const row = byAt.get(at) ?? { at: new Date(at).toISOString() };
        row[`s${i}`] = v;
        byAt.set(at, row);
      }
    });
    const rows = [...byAt.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r);
    const parsed = parseView(
      JSON.stringify({
        type: 'chart',
        chart: kind,
        x: 'at',
        y: c.series.map((s, i) => ({ key: `s${i}`, label: s.label })),
        columns: [{ key: 'at', type: rows.length > 1 && rows.some((r, i) => i && String(r.at).slice(0, 10) === String(rows[i - 1]!.at).slice(0, 10)) ? 'datetime' : 'date' }, ...c.series.map((s, i) => unitColumn(`s${i}`, s.label, c.unit))],
        data: rows,
        height: 170,
      }),
      'chart',
    );
    return parsed.ok ? parsed.view : undefined;
  }, [t.chart]);
  return (
    <View style={[box(), { opacity: t.state === 'ok' ? 1 : 0.8 }]}>
      <TileHead t={t} />
      {view ? <ChartView view={view} columns={view.columns} rows={view.rows} fit /> : <T v="caption">{t.state === 'ok' ? 'No numbers yet' : ''}</T>}
    </View>
  );
}

// ---- a table: its first rows, all of them a tap away

const FIRST_ROWS = 5;
const cellText = (c: string | number | boolean | null): string => (c === null ? '' : typeof c === 'boolean' ? (c ? 'yes' : 'no') : typeof c === 'number' ? c.toLocaleString() : c);

function TableTile({ t, rows: given }: { readonly t: DashboardTileView; readonly rows?: DashboardTileView['table'] }) {
  const [all, setAll] = useState(false);
  const tb = given ?? t.table;
  if (!tb) {
    return (
      <View style={box()}>
        <TileHead t={t} />
        <T v="caption">{t.state === 'ok' ? 'No rows yet' : ''}</T>
      </View>
    );
  }
  const rows = all ? tb.rows : tb.rows.slice(0, FIRST_ROWS);
  // Typed columns (1.29, BLG-386) draw their own cells: a chip, a bar, a person, stars, a button.
  const typedAt = new Map((tb.typed ?? []).map((x) => [x.col, x]));
  const widths = tb.columns.map((c, i) => {
    const ty = typedAt.get(i);
    const chip = ty?.docs ? Math.max(c.length, ...ty.docs.map((d) => (ty.button ?? d?.name ?? '').length)) + 4 : 0;
    const base = Math.max(56, Math.min(190, 14 + 7.2 * Math.max(c.length, chip, ...tb.rows.map((r) => cellText(r[i] ?? null).length))));
    return ty?.kind === 'progress' ? Math.max(base, 120) : ty?.kind === 'person' ? base + 26 : ty?.kind === 'action' ? Math.max(base, 14 + 7.2 * (ty.button ?? 'Run').length + 30) : base;
  });
  return (
    <View style={[box(), { paddingHorizontal: 0, opacity: t.state === 'ok' ? 1 : 0.85 }]}>
      <View style={{ paddingHorizontal: 12 }}>
        <TileHead t={t} />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 12 }}>
        <View>
          <View style={{ flexDirection: 'row', paddingVertical: 6 }}>
            {tb.columns.map((c, i) => (
              <Text key={i} numberOfLines={1} style={{ ...type.caption, width: widths[i], color: color.text3, fontWeight: '600' }}>
                {c.replace(/_/g, ' ')}
              </Text>
            ))}
          </View>
          {rows.map((r, ri) => (
            <View key={ri}>
              <Hairline />
              <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 36, paddingVertical: 6 }}>
                {tb.columns.map((_, i) => {
                  const ty = typedAt.get(i);
                  const drawn = ty?.kind === 'action' ? <ActionCell key={i} typed={ty} row={r} tb={tb} width={widths[i]!} /> : ty ? <TypedCell key={i} typed={ty} cell={r[i] ?? null} ri={ri} tb={tb} width={widths[i]!} /> : null;
                  return (
                    drawn ?? (
                      <Text key={i} numberOfLines={1} style={{ ...type.callout, width: widths[i], color: color.text, fontVariant: typeof r[i] === 'number' ? ['tabular-nums'] : undefined }}>
                        {cellText(r[i] ?? null)}
                      </Text>
                    )
                  );
                })}
              </View>
            </View>
          ))}
        </View>
      </ScrollView>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, gap: 8 }}>
        <T v="caption" style={{ flex: 1 }}>
          {tb.total === 1 ? '1 row' : `${tb.total.toLocaleString()} rows`}
        </T>
        {tb.rows.length > FIRST_ROWS ? (
          <Press haptics={false} onPress={() => (haptic.tap(), setAll((a) => !a))} accessibilityLabel={all ? 'Fewer rows' : 'All rows'} style={{ height: 28, paddingHorizontal: 12, borderRadius: 14, justifyContent: 'center', backgroundColor: color.sunken }}>
            <T v="caption" c={color.text2} style={{ fontWeight: '600' }}>
              {all ? 'Fewer' : `All ${tb.rows.length}`}
            </T>
          </Press>
        ) : null}
      </View>
    </View>
  );
}

// ---- a sentinel's last headline: a tap unfolds its report (sentinel.runGet)

const words = (md: string): string => md.replace(/```[\s\S]*?(```|$)/g, '(code)').trim();

function TextTile({ t }: { readonly t: DashboardTileView }) {
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<string | null | undefined>();
  const sentinel = t.topic?.startsWith('sentinel:') ? t.topic : undefined;
  const toggle = () => {
    if (!t.runId) return sentinel ? router.push(sentinelPath(sentinel) as never) : undefined;
    setOpen((o) => !o);
    if (report !== undefined) return;
    void store.call<{ report?: string }>(calls.sentinelRunGet(t.runId), { queue: false }).then(
      // The headline shows already: the report from its second paragraph.
      (d) => setReport(d?.report ? words(t.text && d.report.startsWith(t.text) ? d.report.slice(t.text.length) : d.report) || null : null),
      (e: Error) => (setReport(null), store.toast({ text: e.message, tone: 'error' })),
    );
  };
  return (
    <View style={[box(), { padding: 0, gap: 0, opacity: t.state === 'ok' ? 1 : 0.8 }]}>
      <Press scaleTo={0.985} disabled={!t.runId && !sentinel} onPress={toggle} accessibilityLabel={`${t.title}: ${t.text ?? ''}`} style={{ padding: 12, gap: 6 }}>
        <TileHead t={t} right={t.runId ? open ? <ChevronDown color={color.text3} size={16} /> : <ChevronRight color={color.text3} size={16} /> : null} />
        <T v="body" numberOfLines={open ? undefined : 3} c={t.text ? color.text : color.text3}>
          {t.text ?? (t.state === 'ok' ? 'It hasn’t said anything yet.' : '')}
        </T>
      </Press>
      {open ? (
        <View style={{ paddingHorizontal: 12, paddingBottom: 12, gap: 10 }}>
          <Hairline />
          {report === undefined ? (
            <ActivityIndicator color={color.text3} style={{ alignSelf: 'flex-start' }} />
          ) : (
            <T v="callout" c={report ? color.text : color.text2} selectable>
              {report || 'This run left no report.'}
            </T>
          )}
          {sentinel ? (
            <Press haptics={false} onPress={() => (haptic.tap(), router.push(sentinelPath(sentinel) as never))} accessibilityLabel={`Open ${t.sentinel ?? 'the sentinel'}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start' }}>
              <T v="caption" c={color.info} style={{ fontWeight: '600' }}>
                Open {t.sentinel ?? 'the sentinel'}
              </T>
              <ChevronRight color={color.info} size={14} />
            </Press>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

// ---- a step's latest output: what Claude wrote, a service's answer (a tree, or a table), text

/** A JSON list of objects as a table's columns and rows (an output tile shown as a table). */
function jsonTable(text: string): DashboardTileView['table'] | undefined {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return undefined;
  }
  const list = Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v as Record<string, unknown>).find(Array.isArray) : undefined;
  const rows = (list ?? []).filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object' && !Array.isArray(r));
  if (!rows.length) return undefined;
  const columns = [...new Set(rows.slice(0, 50).flatMap((r) => Object.keys(r)))].slice(0, 12);
  const cell = (x: unknown): string | number | boolean | null => (x === null || x === undefined ? null : typeof x === 'number' || typeof x === 'boolean' ? x : typeof x === 'string' ? x.slice(0, 300) : JSON.stringify(x).slice(0, 300));
  return { columns, rows: rows.slice(0, 50).map((r) => columns.map((c) => cell(r[c]))), total: rows.length };
}

function OutputTile({ t }: { readonly t: DashboardTileView }) {
  const o = t.output;
  const sentinel = t.topic?.startsWith('sentinel:') ? t.topic : undefined;
  const doc = useMemo(() => (o && (o.look === 'tree' || o.look === 'table') ? readJson(o.text) : undefined), [o]);
  const table = useMemo(() => (o?.look === 'table' ? jsonTable(o.text) : undefined), [o]);
  if (o?.look === 'table' && table) return <TableTile t={t} rows={table} />;
  return (
    <View style={[box(), { opacity: t.state === 'ok' ? 1 : 0.8 }]}>
      <TileHead t={t} />
      {!o ? (
        <T v="caption">{t.state === 'ok' ? 'No output yet: it shows after its step runs' : ''}</T>
      ) : doc ? (
        <JsonTree doc={doc} text={o.text} />
      ) : o.look === 'markdown' ? (
        <Prose prose={{ text: o.text, code: [] }} size={14.5} />
      ) : (
        <T v="callout" c={color.text2} selectable numberOfLines={t.tall ? 40 : 14}>
          {o.text}
        </T>
      )}
      {o?.cut ? <T v="caption">Shortened: the run on your Mac has all of it.</T> : null}
      {sentinel ? (
        <Press haptics={false} onPress={() => (haptic.tap(), router.push(sentinelPath(sentinel) as never))} accessibilityLabel={`Open ${t.sentinel ?? 'the sentinel'}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start' }}>
          <T v="caption" c={color.info} style={{ fontWeight: '600' }}>
            {t.sentinel ?? 'Its sentinel'}
          </T>
          <ChevronRight color={color.info} size={14} />
        </Press>
      ) : null}
    </View>
  );
}

// ---- the tiles, two columns on the phone: numbers half width, the rest full

export function Tiles({ tiles, compare }: { readonly tiles: readonly DashboardTileView[]; readonly compare: CompareKey }) {
  const [w, setW] = useState(0);
  const gap = 10;
  const half = w ? Math.floor((w - gap) / 2) : 0;
  return (
    <View onLayout={(e) => setW(Math.floor(e.nativeEvent.layout.width) - 32)} style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: gap, rowGap: gap, paddingHorizontal: 16 }}>
      {w > 0
        ? tiles.map((t) => {
            const full = { width: w };
            if (t.kind === 'number') return <NumberTile key={t.id} t={t} compare={compare} width={half} />;
            if (t.kind === 'divider')
              return (
                <View key={t.id} style={[full, { paddingTop: 14, paddingHorizontal: 4 }]}>
                  <T v="eyebrow">{t.title}</T>
                </View>
              );
            return (
              <View key={t.id} style={full}>
                {t.kind === 'chart' || t.kind === 'series' ? <ChartTile t={t} /> : t.kind === 'table' ? <TableTile t={t} /> : t.kind === 'output' ? <OutputTile t={t} /> : t.kind === 'text' ? <TextTile t={t} /> : (
                  <View style={box()}>
                    <TileHead t={t} />
                    <T v="caption">Update Beluga on this phone to see this tile.</T>
                  </View>
                )}
              </View>
            );
          })
        : null}
    </View>
  );
}

/** A row of choices as soft chips (the compares; the dashboards when there are many). */
export function Chips<K extends string>({ value, options, onChange }: { readonly value: K; readonly options: readonly { key: K; label: string }[]; readonly onChange: (k: K) => void }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}>
      {options.map((o) => {
        const on = o.key === value;
        return (
          <Press key={o.key} haptics={false} accessibilityLabel={o.label} accessibilityState={{ selected: on }} onPress={() => (haptic.tap(), onChange(o.key))} style={{ height: 32, paddingHorizontal: 13, borderRadius: 16, justifyContent: 'center', backgroundColor: on ? tint.sky : color.sunken }}>
            <T v="callout" c={on ? color.text : color.text2} style={{ fontWeight: '600' }}>
              {o.label}
            </T>
          </Press>
        );
      })}
    </ScrollView>
  );
}

// ---- Home's row: the first dashboard's first three numbers

export function NumbersHome() {
  const on = useSupports('dashboard');
  const view = useView<SentinelsView>(on ? 'sentinels' : undefined);
  const n = view?.data.numbers;
  if (!on || !n?.items.length) return null;
  return (
    <Press scaleTo={0.985} onPress={() => router.push(dashboardHref(n.dashboard.id) as never)} accessibilityLabel={`${n.dashboard.name}: ${n.items.map((i) => `${i.label} ${i.value}${i.change ? `, ${i.change}` : ''}`).join('; ')}`} style={{ marginHorizontal: 16, marginTop: 10 }}>
      <Card style={{ paddingVertical: 12, paddingHorizontal: 14, gap: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <LayoutDashboard color={color.text3} size={14} strokeWidth={1.9} />
          <T v="caption" numberOfLines={1} style={{ flex: 1 }}>
            {n.dashboard.name}
          </T>
          <ChevronRight color={color.text3} size={16} />
        </View>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          {n.items.map((i, k) => (
            <View key={k} style={{ flex: 1, gap: 1 }}>
              <T v="caption" numberOfLines={1} c={color.text2}>
                {i.label}
              </T>
              <Text numberOfLines={1} adjustsFontSizeToFit style={{ ...type.heading, fontSize: 18, color: color.text, fontVariant: ['tabular-nums'] }}>
                {i.value}
              </Text>
              {i.change ? (
                <Text numberOfLines={1} style={{ ...type.caption, fontSize: 11.5, fontWeight: '700', color: toneInkOf(i.tone), fontVariant: ['tabular-nums'] }}>
                  {i.change}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      </Card>
    </Press>
  );
}

// ---- the Sentinel list's Dashboards

export function DashboardRows() {
  const on = useSupports('dashboard');
  const view = useView<SentinelsView>(on ? 'sentinels' : undefined);
  const list = view?.data.dashboards ?? [];
  if (!on || !list.length) return null;
  const first = view?.data.numbers;
  return (
    <View style={{ gap: 10 }}>
      <T v="eyebrow" style={{ paddingHorizontal: 20 }}>
        Dashboards
      </T>
      <Card style={{ marginHorizontal: 16 }}>
        {list.map((d, i) => (
          <Row key={d.id} first={i === 0} Icon={LayoutDashboard} tone="sky" label={d.name} {...(first && first.dashboard.id === d.id ? { sub: first.items.map((x) => `${x.label} ${x.value}`).join(' · ') } : {})} onPress={() => router.push(dashboardHref(d.id) as never)} />
        ))}
      </Card>
    </View>
  );
}

// ---- the Sentinel screen's Chat: the Sentinel chat's open conversation (1.23, docs/sentinel.md §12)

export function SentinelChatRow() {
  const on = useSupports('sentinelChat');
  const view = useView<SentinelsView>(on ? 'sentinels' : undefined);
  const chat = view?.data.chat;
  if (!on || !chat) return null;
  return (
    <View style={{ gap: 10 }}>
      <T v="eyebrow" style={{ paddingHorizontal: 20 }}>
        Chat
      </T>
      <Card style={{ marginHorizontal: 16 }}>
        <Row first Icon={MessagesSquare} tone="lavender" label={chat.title} sub={chat.working ? 'Your agent is working…' : (chat.last ?? 'Ask about your sentinels, or tell your agent what to watch')} onPress={() => router.push(convHref(chat.topic) as never)} />
      </Card>
    </View>
  );
}
