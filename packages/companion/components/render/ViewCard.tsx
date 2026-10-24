import * as Clipboard from 'expo-clipboard';
import { Image } from 'expo-image';
import { ArrowDown, ArrowUp, BarChart3, ChevronLeft, ChevronRight, MoveHorizontal, Maximize2, Play, RefreshCw, Rows3, Search, Table2, TriangleAlert } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Linking, Platform, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { type Column, type Control, type Row, type Stat, type View as ViewSpec, alignOf, columnChoices, contrast, formatCell, headingOf, inkOn, parseColor, toHex } from '../../lib/render';
import { store } from '../../lib/store';
import { openFull } from '../../lib/fullscreen';
import { color, elevation, ink, radius, tint, type } from '../../lib/theme';
import { haptic, Pill, Press, T, toneBg, toneInk } from '../ui';
import { ChartView } from './Chart';
import { CalendarView, GanttView, HeatmapView } from './Grids';
import { type BlockAt, useViewData, type ViewData } from './data';
import { Spark, badgeTone } from './Inline';

/**
 * A `beluga-view` on the phone (BLG-68): a card with its title, its controls, and the element
 * (table, chart, stats, code or colors), read by the Mac's own parser (src/shared/view-spec.ts).
 * Tables scroll sideways and sort, search and page; a source's rows come through the Mac. Every
 * view opens full screen (Expand, BLG-71), where the phone may turn sideways; a table too wide for
 * the screen can read as cards instead, one per row.
 */
export function ViewCard({ view, at, warnings = 0, full }: { readonly view: ViewSpec; readonly at?: BlockAt; readonly warnings?: number; readonly full?: boolean }) {
  const [asChart, setAsChart] = useState(false);
  const chartable = view.type === 'table' && view.columns.some((c) => c.type === 'number' || c.type === 'percent' || c.type === 'currency');
  const chart = view.type === 'chart' || asChart;
  // Gantt, heatmap and calendar draw every row at once, as a chart does.
  const grid = view.type === 'gantt' || view.type === 'heatmap' || view.type === 'calendar';
  const d = useViewData(view, at, { ...(chart || grid ? { limit: Math.max(view.pageSize, 500) } : {}), ...(view.type === 'code' ? { text: true } : {}) });
  return (
    <View style={{ borderRadius: radius.m, backgroundColor: elevation.raised.surface, borderWidth: 1, borderColor: elevation.raised.border, overflow: 'hidden' }}>
      <View style={{ paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <T v="heading" numberOfLines={2} style={{ flex: 1, fontSize: 15.5 }}>
            {view.title ?? (view.type === 'code' ? (view.filename ?? 'Code') : view.type === 'colors' ? 'Colors' : view.type === 'stats' ? 'Numbers' : view.type === 'gantt' ? 'Timeline' : view.type === 'calendar' ? 'Activity' : 'Data')}
          </T>
          {d.live && view.source?.refresh ? <Pill label="Live" tone="mint" /> : null}
          {chartable ? (
            <Press onPress={() => setAsChart((v) => !v)} accessibilityLabel={asChart ? 'Show as a table' : 'Show as a chart'} hitSlop={6} style={{ width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: color.sunken }}>
              {asChart ? <Table2 color={color.text2} size={15} /> : <BarChart3 color={color.text2} size={15} />}
            </Press>
          ) : null}
          {full ? null : (
            <Press onPress={() => openFull({ kind: 'view', view, ...(at ? { at } : {}) })} accessibilityLabel="Full screen" hitSlop={6} style={{ width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: color.sunken }}>
              <Maximize2 color={color.text2} size={14} />
            </Press>
          )}
          {d.live ? (
            <Press onPress={d.refresh} accessibilityLabel="Fetch again on your Mac" hitSlop={6} style={{ width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: color.sunken }}>
              {d.loading ? <ActivityIndicator size="small" color={color.text3} /> : <RefreshCw color={color.text2} size={14} />}
            </Press>
          ) : null}
        </View>
        {view.summary ? <T v="caption">{view.summary}</T> : null}
      </View>
      {view.controls.length ? <Controls view={view} d={d} /> : null}
      {view.actions.some((a) => a.source || a.href) ? <Actions view={view} d={d} /> : null}
      {d.needsApproval ? (
        <View style={{ margin: 12, padding: 12, borderRadius: 12, backgroundColor: tint.butter, gap: 8 }}>
          <T v="callout" c={ink.butter}>
            This runs on your Mac: {d.needsApproval}
          </T>
          <Press onPress={() => (haptic.commit(), d.approve())} style={{ alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6, height: 34, paddingHorizontal: 14, borderRadius: 17, backgroundColor: color.primary }}>
            <Play color={color.onPrimary} size={13} />
            <T v="callout" c={color.onPrimary} style={{ fontWeight: '700' }}>
              Run on your Mac
            </T>
          </Press>
        </View>
      ) : null}
      {d.error ? (
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', marginHorizontal: 14, marginBottom: 8 }}>
          <TriangleAlert color={color.error} size={14} />
          <T v="caption" c={color.error} style={{ flex: 1 }}>
            {d.error}
          </T>
        </View>
      ) : null}
      <View style={{ paddingBottom: 12 }}>
        {chart ? (
          <View style={{ paddingHorizontal: 12 }}>
            <ChartView view={view} columns={d.columns} rows={d.rows} {...(full ? { tall: true } : {})} />
          </View>
        ) : view.type === 'gantt' ? (
          <GanttView view={view} rows={d.rows} columns={d.columns} />
        ) : view.type === 'heatmap' ? (
          <HeatmapView view={view} rows={d.rows} columns={d.columns} />
        ) : view.type === 'calendar' ? (
          <CalendarView view={view} rows={d.rows} columns={d.columns} />
        ) : view.type === 'stats' ? (
          <StatsView view={view} d={d} />
        ) : view.type === 'code' ? (
          <CodeView view={view} text={d.text ?? ''} />
        ) : view.type === 'colors' ? (
          <ColorsView view={view} />
        ) : (
          <TableView view={view} d={d} />
        )}
      </View>
      {warnings ? (
        <T v="caption" style={{ paddingHorizontal: 14, paddingBottom: 10 }}>
          {warnings} small {warnings === 1 ? 'mistake was' : 'mistakes were'} left out
        </T>
      ) : null}
      {d.live && d.at ? (
        <T v="caption" style={{ paddingHorizontal: 14, paddingBottom: 10 }}>
          From your Mac · {new Date(d.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </T>
      ) : null}
    </View>
  );
}

// ---- table

const MIN_COL = 84;
const MAX_COL = 220;

function CellView({ c, col }: { readonly c: Row[string] | undefined; readonly col: Column }) {
  const v = c ?? null;
  if (v === null || v === '') return <T v="callout" c={color.text3}>–</T>;
  if (col.type === 'badge' && typeof v === 'string') {
    const t = badgeTone(v);
    return <Pill label={v} tone={t} style={{ height: 22, paddingHorizontal: 8, alignSelf: alignOf(col) === 'right' ? 'flex-end' : 'flex-start' }} />;
  }
  if (col.type === 'color' && typeof v === 'string' && parseColor(v)) {
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <View style={{ width: 14, height: 14, borderRadius: 4, backgroundColor: v, borderWidth: 1, borderColor: color.hairlineStrong }} />
        <Text style={[type.mono, { color: color.text, fontSize: 12 }]}>{v}</Text>
      </View>
    );
  }
  if (col.type === 'image' && typeof v === 'string' && /^https?:\/\//.test(v)) return <Image source={{ uri: v }} style={{ width: 40, height: 28, borderRadius: 4 }} contentFit="cover" />;
  if (col.type === 'url' && typeof v === 'string' && /^https?:\/\//.test(v)) {
    return (
      <Text onPress={() => void Linking.openURL(v)} numberOfLines={1} style={{ ...type.callout, color: color.info }}>
        {v.replace(/^https?:\/\//, '')}
      </Text>
    );
  }
  const text = formatCell(v, col);
  return (
    <Text numberOfLines={2} style={[col.type === 'code' || col.type === 'path' ? type.mono : type.callout, { color: color.text, textAlign: alignOf(col), fontVariant: ['tabular-nums'] }]}>
      {text}
    </Text>
  );
}

function TableView({ view, d }: { readonly view: ViewSpec; readonly d: ViewData }) {
  const cols = d.columns.filter((c) => !c.hidden);
  // Each column as wide as its heading and longest value asks, within bounds.
  const widths = useMemo(
    () =>
      cols.map((c) => {
        const longest = Math.max(headingOf(c).length, ...d.rows.slice(0, 50).map((r) => (r[c.key] === null || r[c.key] === undefined ? 1 : formatCell(r[c.key]!, c).length)));
        return Math.max(MIN_COL, Math.min(MAX_COL, longest * 7.6 + 24));
      }),
    [cols, d.rows],
  );
  const [open, setOpen] = useState<number | undefined>();
  // Wider than the screen: it scrolls sideways, or reads as cards (one per row, its columns as lines).
  const [space, setSpace] = useState(0);
  const [cards, setCards] = useState(false);
  const wide = space > 0 && widths.reduce((a, b) => a + b, 0) + 24 > space;
  const searchable = view.search || d.live || view.rows.length > d.pageSize;
  const from = d.page * d.pageSize;
  const sortBy = (key: string) => {
    haptic.tap();
    // Again: the other way; a third time: as they came (the Mac's order).
    const s = d.sort;
    d.setSort(!s || s.key !== key ? { key, dir: 'asc' } : s.dir === 'asc' ? { key, dir: 'desc' } : undefined);
  };
  return (
    <View style={{ gap: 8 }}>
      {searchable ? (
        <View style={{ marginHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 8, height: 36, paddingHorizontal: 10, borderRadius: 18, backgroundColor: color.sunken }}>
          <Search color={color.text3} size={15} />
          <TextInput value={d.search} onChangeText={d.setSearch} placeholder="Search" placeholderTextColor={color.text3} style={{ flex: 1, color: color.text, fontSize: 14, ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}) }} />
        </View>
      ) : null}
      {wide && cards ? (
        <View style={{ gap: 8, paddingHorizontal: 12 }}>
          {d.rows.map((r, ri) => (
            <View key={`${from + ri}`} style={{ padding: 12, borderRadius: 12, backgroundColor: color.sunken, gap: 5 }}>
              {cols.map((c) => (
                <View key={c.key} style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
                  <T v="caption" numberOfLines={2} style={{ width: 112, fontWeight: '700' }}>
                    {headingOf(c)}
                  </T>
                  <View style={{ flex: 1 }}>
                    <CellView c={r[c.key]} col={{ ...c, align: 'left' } as Column} />
                  </View>
                </View>
              ))}
            </View>
          ))}
        </View>
      ) : (
      <ScrollView onLayout={(e) => setSpace(e.nativeEvent.layout.width)} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 12 }}>
        <View>
          <View style={{ flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: color.hairline }}>
            {cols.map((c, i) => {
              const on = d.sort?.key === c.key;
              return (
                <Press key={c.key} haptics={false} onPress={() => sortBy(c.key)} style={{ width: widths[i], paddingVertical: 8, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', gap: 4, justifyContent: alignOf(c) === 'right' ? 'flex-end' : 'flex-start' }}>
                  <Text numberOfLines={1} style={{ ...type.caption, color: on ? color.text : color.text2, fontWeight: '700' }}>
                    {headingOf(c)}
                  </Text>
                  {on ? d.sort!.dir === 'asc' ? <ArrowUp color={color.text} size={12} /> : <ArrowDown color={color.text} size={12} /> : null}
                </Press>
              );
            })}
          </View>
          {d.rows.map((r, ri) => (
            <Animated.View key={`${from + ri}`} entering={FadeIn.duration(160)}>
              <Press haptics={false} scaleTo={0.995} onPress={() => setOpen(open === ri ? undefined : ri)} style={{ flexDirection: 'row', alignItems: 'center', minHeight: 40, backgroundColor: ri % 2 ? color.sunken : 'transparent', borderRadius: 8 }}>
                {cols.map((c, i) => (
                  <View key={c.key} style={{ width: widths[i], paddingHorizontal: 8, paddingVertical: 6 }}>
                    <CellView c={r[c.key]} col={c} />
                  </View>
                ))}
              </Press>
            </Animated.View>
          ))}
          {!d.rows.length ? (
            <T v="callout" style={{ padding: 14 }}>
              {d.loading ? 'Asking your Mac…' : d.needsApproval ? '' : 'Nothing here'}
            </T>
          ) : null}
        </View>
      </ScrollView>
      )}
      {open !== undefined && d.rows[open] && !(wide && cards) ? (
        <View style={{ marginHorizontal: 12, padding: 12, borderRadius: 12, backgroundColor: color.sunken, gap: 6 }}>
          {d.columns.map((c) => (
            <View key={c.key} style={{ flexDirection: 'row', gap: 10 }}>
              <T v="caption" style={{ width: 110, fontWeight: '700' }} numberOfLines={1}>
                {headingOf(c)}
              </T>
              <View style={{ flex: 1 }}>
                <CellView c={d.rows[open]![c.key]} col={c} />
              </View>
            </View>
          ))}
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Pager d={d} from={from} />
        </View>
        {wide ? (
          <View style={{ flexDirection: 'row', marginRight: 12, padding: 2, gap: 2, borderRadius: 15, backgroundColor: color.sunken }}>
            {([['Scroll sideways', MoveHorizontal, false], ['As cards', Rows3, true]] as const).map(([label, Icon, on]) => (
              <Press key={label} haptics={false} onPress={() => (haptic.tap(), setCards(on))} accessibilityLabel={label} accessibilityState={{ selected: cards === on }} style={{ width: 34, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: cards === on ? color.card : 'transparent' }}>
                <Icon color={cards === on ? color.text : color.text3} size={15} />
              </Press>
            ))}
          </View>
        ) : null}
      </View>
    </View>
  );
}

function Pager({ d, from }: { readonly d: ViewData; readonly from: number }) {
  const shown = d.rows.length;
  if (!shown || (d.page === 0 && !d.hasMore)) {
    return shown ? (
      <T v="caption" style={{ paddingHorizontal: 14 }}>
        {shown} {shown === 1 ? 'row' : 'rows'}
      </T>
    ) : null;
  }
  const btn = (on: boolean, Icon: typeof ChevronLeft, go: () => void, label: string) => (
    <Press disabled={!on} onPress={go} accessibilityLabel={label} style={{ width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: color.sunken, opacity: on ? 1 : 0.4 }}>
      <Icon color={color.text} size={17} />
    </Press>
  );
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12 }}>
      <T v="caption" style={{ flex: 1, fontVariant: ['tabular-nums'] }}>
        {from + 1}–{from + shown}
        {d.total !== undefined ? ` of ${d.total.toLocaleString()}` : ''}
      </T>
      {btn(d.page > 0, ChevronLeft, () => d.setPage(d.page - 1), 'Previous page')}
      {btn(d.hasMore, ChevronRight, () => d.setPage(d.page + 1), 'Next page')}
    </View>
  );
}

// ---- controls and actions

function Controls({ view, d }: { readonly view: ViewSpec; readonly d: ViewData }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 8, gap: 8, alignItems: 'center' }}>
      {view.controls.map((c) => (
        <ControlView key={c.id} c={c} view={view} d={d} />
      ))}
    </ScrollView>
  );
}

function Chip({ label, on, onPress }: { readonly label: string; readonly on: boolean; readonly onPress: () => void }) {
  return (
    <Press haptics={false} accessibilityLabel={label} accessibilityState={{ selected: on }} onPress={() => (haptic.tap(), onPress())} style={{ height: 32, paddingHorizontal: 12, borderRadius: 16, justifyContent: 'center', backgroundColor: on ? tint.sky : color.sunken }}>
      <Text style={{ ...type.caption, color: on ? ink.sky : color.text2, fontWeight: '700' }}>{label}</Text>
    </Press>
  );
}

function ControlView({ c, view, d }: { readonly c: Control; readonly view: ViewSpec; readonly d: ViewData }) {
  const v = d.controls[c.id];
  if (c.options?.length) {
    return (
      <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
        {c.label ? <T v="caption">{c.label}</T> : null}
        {c.type === 'select' ? <Chip label="All" on={v === undefined} onPress={() => d.setControl(c.id, undefined)} /> : null}
        {c.options.map((o, i) => (
          <Chip key={i} label={o.label} on={v === i} onPress={() => d.setControl(c.id, c.type === 'select' && v === i ? undefined : i)} />
        ))}
      </View>
    );
  }
  if (c.type === 'select' && c.column) {
    const choices = columnChoices(c.column, view.rows, 12);
    return (
      <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
        <T v="caption">{c.label ?? headingOf({ key: c.column })}</T>
        <Chip label="All" on={v === undefined} onPress={() => d.setControl(c.id, undefined)} />
        {choices.map((x, i) => (
          <Chip key={i} label={String(x)} on={v === x} onPress={() => d.setControl(c.id, v === x ? undefined : x)} />
        ))}
      </View>
    );
  }
  if (c.type === 'toggle') {
    return (
      <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
        <Switch value={v === true} onValueChange={(on) => d.setControl(c.id, on)} trackColor={{ true: ink.sky, false: color.hairlineStrong }} />
        <T v="caption">{c.label ?? c.id}</T>
      </View>
    );
  }
  if (c.type === 'number' || c.type === 'range') {
    const step = c.step ?? 1;
    const n = typeof v === 'number' ? v : (c.min ?? 0);
    const clamp = (x: number) => Math.max(c.min ?? -Infinity, Math.min(c.max ?? Infinity, x));
    return (
      <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
        <T v="caption">{c.label ?? c.id}</T>
        <Chip label="−" on={false} onPress={() => d.setControl(c.id, clamp(n - step))} />
        <T v="callout" c={color.text} style={{ minWidth: 36, textAlign: 'center', fontVariant: ['tabular-nums'] }}>
          {typeof v === 'number' ? String(v) : '–'}
        </T>
        <Chip label="+" on={false} onPress={() => d.setControl(c.id, clamp(n + step))} />
      </View>
    );
  }
  // search
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 32, width: 170, paddingHorizontal: 10, borderRadius: 16, backgroundColor: color.sunken }}>
      <Search color={color.text3} size={13} />
      <TextInput value={typeof v === 'string' ? v : ''} onChangeText={(t) => d.setControl(c.id, t)} placeholder={c.placeholder ?? c.label ?? 'Filter'} placeholderTextColor={color.text3} style={{ flex: 1, color: color.text, fontSize: 13, ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}) }} />
    </View>
  );
}

function Actions({ view, d }: { readonly view: ViewSpec; readonly d: ViewData }) {
  const [on, setOn] = useState<number | undefined>();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 8, gap: 8 }}>
      {view.actions.map((a, i) =>
        a.source ? (
          <Chip key={i} label={a.label} on={on === i} onPress={() => (on === i ? (setOn(undefined), d.useSource(undefined)) : (setOn(i), d.useSource(a.source)))} />
        ) : a.href && /^https?:\/\//.test(a.href) ? (
          <Chip key={i} label={a.label} on={false} onPress={() => void Linking.openURL(a.href!)} />
        ) : a.copy ? (
          <Chip key={i} label={a.label} on={false} onPress={() => (void Clipboard.setStringAsync(a.copy!), store.toast({ text: 'Copied', tone: 'ok' }))} />
        ) : null,
      )}
    </ScrollView>
  );
}

// ---- stats

function StatsView({ view, d }: { readonly view: ViewSpec; readonly d: ViewData }) {
  // Without items, a source's rows become tiles: label/value, or each numeric column's latest.
  const items: readonly Stat[] = view.items.length
    ? view.items
    : d.rows.length && d.columns.some((c) => c.key === 'label') && d.columns.some((c) => c.key === 'value')
      ? d.rows.map((r) => ({ label: String(r.label ?? ''), value: (r.value ?? '') as string | number }))
      : d.columns
          .filter((c) => c.type === 'number' || c.type === 'currency' || c.type === 'percent')
          .map((c) => ({ label: headingOf(c), value: (d.rows.at(-1)?.[c.key] ?? '') as string | number, trend: d.rows.map((r) => Number(r[c.key])).filter(Number.isFinite), type: c.type }));
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 12 }}>
      {items.map((s, i) => {
        const delta = typeof s.delta === 'number' ? `${s.delta > 0 ? '+' : ''}${s.delta}%` : s.delta;
        const up = typeof s.delta === 'number' ? s.delta > 0 : typeof s.delta === 'string' ? !s.delta.trim().startsWith('-') && !s.delta.trim().startsWith('−') : undefined;
        const good = up === undefined ? undefined : s.invert ? !up : up;
        const statusTone = s.status === 'critical' || s.status === 'serious' ? 'rose' : s.status === 'warning' ? 'butter' : s.status === 'good' ? 'mint' : undefined;
        const value = typeof s.value === 'number' ? formatCell(s.value, { type: s.type ?? 'number', ...(s.unit ? { unit: s.unit } : {}), ...(s.currency ? { currency: s.currency } : {}) }) : String(s.value ?? '');
        return (
          <View key={i} style={{ flexGrow: 1, flexBasis: '45%', padding: 12, borderRadius: 14, backgroundColor: statusTone ? toneBg(statusTone) : color.sunken, gap: 4 }}>
            <T v="caption" numberOfLines={1}>
              {s.label}
            </T>
            <Text numberOfLines={1} adjustsFontSizeToFit style={{ ...type.title, fontSize: 22, color: statusTone ? toneInk(statusTone) : color.text, fontVariant: ['tabular-nums'] }}>
              {value}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              {delta ? (
                <Text style={{ ...type.caption, fontWeight: '700', color: good === undefined ? color.text2 : good ? color.ok : color.error }}>
                  {delta}
                  {s.deltaLabel ? ` ${s.deltaLabel}` : ''}
                </Text>
              ) : null}
              <View style={{ flex: 1 }} />
              {s.trend?.length ? <Spark values={s.trend} w={56} h={18} c={good === false ? color.error : color.info} /> : null}
            </View>
            {s.hint ? (
              <T v="caption" numberOfLines={2}>
                {s.hint}
              </T>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

// ---- code (a view Claude chose to show: drawn, as the Mac draws it)

const FOLD = 40;

function CodeView({ view, text }: { readonly view: ViewSpec; readonly text: string }) {
  const [all, setAll] = useState(false);
  const lines = text.replace(/\n$/, '').split('\n');
  const shown = all ? lines : lines.slice(0, FOLD);
  const hl = new Set(view.highlight);
  const pad = String(view.startLine + lines.length - 1).length;
  return (
    <View style={{ gap: 6 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: 12, borderRadius: 12, backgroundColor: color.code }} contentContainerStyle={{ paddingVertical: 10 }}>
        <View>
          {shown.map((l, i) => {
            const n = view.startLine + i;
            return (
              <View key={i} style={{ flexDirection: 'row', backgroundColor: hl.has(n) ? tint.butter : 'transparent', paddingRight: 14 }}>
                <Text style={[type.mono, { color: color.text3, width: pad * 8 + 18, textAlign: 'right', paddingRight: 10 }]}>{n}</Text>
                <Text style={[type.mono, { color: color.text }]}>{l || ' '}</Text>
              </View>
            );
          })}
        </View>
      </ScrollView>
      <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 12 }}>
        {lines.length > FOLD ? <Chip label={all ? 'Fold' : `All ${lines.length} lines`} on={false} onPress={() => setAll((a) => !a)} /> : null}
        <Chip label="Copy" on={false} onPress={() => (void Clipboard.setStringAsync(text), store.toast({ text: 'Copied', tone: 'ok' }))} />
        {view.language ? <Pill label={view.language} /> : null}
      </View>
    </View>
  );
}

// ---- colors

function ColorsView({ view }: { readonly view: ViewSpec }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 12 }}>
      {view.swatches.map((s, i) => {
        const rgb = parseColor(s.value);
        const white = rgb ? contrast(rgb, { r: 255, g: 255, b: 255 }) : 0;
        return (
          <Press key={i} haptics={false} onPress={() => (haptic.tap(), void Clipboard.setStringAsync(s.value), store.toast({ text: `Copied ${s.value}`, tone: 'ok' }))} style={{ width: '31%', flexGrow: 1, borderRadius: 14, overflow: 'hidden', backgroundColor: color.sunken }}>
            <View style={{ height: 64, backgroundColor: rgb ? s.value : color.sunken, justifyContent: 'flex-end', padding: 8 }}>
              {rgb ? <Text style={{ ...type.caption, color: inkOn(rgb), fontWeight: '700' }}>Aa {white.toFixed(1)}</Text> : null}
            </View>
            <View style={{ padding: 8, gap: 1 }}>
              {s.name ? (
                <T v="caption" c={color.text} numberOfLines={1} style={{ fontWeight: '700' }}>
                  {s.name}
                </T>
              ) : null}
              <Text numberOfLines={1} style={[type.mono, { color: color.text2, fontSize: 11.5 }]}>
                {rgb ? toHex(rgb) : s.value}
              </Text>
            </View>
          </Press>
        );
      })}
    </View>
  );
}
