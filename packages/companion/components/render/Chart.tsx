import { useMemo, useState } from 'react';
import { type GestureResponderEvent, Pressable, Text, View } from 'react-native';
import Svg, { Circle, G, Line, Path, Rect, Text as SvgText } from 'react-native-svg';
import { type Cell, type Column, type Row, SERIES_DARK, SERIES_LIGHT, type View as ViewSpec, formatCell, formatNumber, planChart, toDate } from '../../lib/render';
import { color, scheme, svgFont, type } from '../../lib/theme';
import { Press } from '../ui';

/**
 * A view's chart on the phone (line, area, bar, pie, donut, scatter), drawn with react-native-svg
 * from the shared plan (src/shared/render/chart-model.ts: which column runs along the bottom, the
 * series, long rows turned wide). It fits the width it's given; tap it for the values at that
 * point, tap the legend to hide a series. Series colors are the Mac's (checked for color-blind
 * readers, light and dark).
 */

const num = (c: Cell | undefined): number | undefined => (typeof c === 'number' && Number.isFinite(c) ? c : undefined);

/** A few round ticks between lo and hi. */
function ticks(lo: number, hi: number, n = 4): number[] {
  if (hi === lo) return [lo];
  const raw = (hi - lo) / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

const xLabel = (c: Cell | undefined, col: Column | undefined, time: boolean): string => {
  if (c === null || c === undefined) return '';
  if (time) {
    const d = toDate(c);
    return d ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : String(c);
  }
  return col ? formatCell(c, col) : String(c);
};

export function ChartView({ view, columns, rows, tall, fit }: { readonly view: ViewSpec; readonly columns: readonly Column[]; readonly rows: readonly Row[]; /** Full screen: taller. */ readonly tall?: boolean; /** A line's axis fits its values instead of starting at zero (a dashboard's number over time). */ readonly fit?: boolean }) {
  const [w, setW] = useState(0);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [at, setAt] = useState<number | undefined>();
  const plan = useMemo(() => planChart(view, columns, rows), [view, columns, rows]);
  const palette = view.colors?.length ? view.colors : scheme === 'dark' ? SERIES_DARK : SERIES_LIGHT;
  const series = plan.series.map((s, i) => ({ ...s, color: s.color ?? palette[i % palette.length]! }));
  const shown = series.filter((s) => !hidden.has(s.key));
  const kind = view.chart;
  const h = tall ? 380 : Math.max(150, Math.min(300, view.height ?? 200));
  const fmtY = (v: number): string => (plan.yColumn ? formatCell(v, plan.yColumn) : formatNumber(v, { compact: true }));
  const data = plan.rows;

  let body: React.ReactNode = null;
  if (w > 0 && data.length && (kind === 'pie' || kind === 'donut')) {
    const s = series[0];
    const vals = s ? data.map((r) => Math.max(0, num(r[s.key]) ?? 0)) : [];
    const sum = vals.reduce((a, b) => a + b, 0) || 1;
    const r = Math.min(w * 0.42, h / 2 - 6);
    const cx = r + 8;
    const cy = h / 2;
    let a0 = -Math.PI / 2;
    body = (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Svg width={r * 2 + 16} height={h}>
          {vals.map((v, i) => {
            const a1 = a0 + (v / sum) * Math.PI * 2;
            const large = a1 - a0 > Math.PI ? 1 : 0;
            const p = `M${cx},${cy} L${cx + r * Math.cos(a0)},${cy + r * Math.sin(a0)} A${r},${r} 0 ${large} 1 ${cx + r * Math.cos(a1)},${cy + r * Math.sin(a1)} Z`;
            a0 = a1;
            return <Path key={i} d={p} fill={palette[i % palette.length]!} stroke={color.card} strokeWidth={1.5}/>;
          })}
          {kind === 'donut' ? <Circle cx={cx} cy={cy} r={r * 0.58} fill={color.card} /> : null}
        </Svg>
        <View style={{ flex: 1, gap: 5 }}>
          {vals.slice(0, 8).map((v, i) => (
            <Press key={i} haptics={false} onPress={() => setAt(i)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, opacity: at === undefined || at === i ? 1 : 0.55 }}>
              <View style={{ width: 9, height: 9, borderRadius: 3, backgroundColor: palette[i % palette.length]! }} />
              <Text numberOfLines={1} style={{ ...type.caption, color: color.text, flex: 1 }}>
                {xLabel(data[i]![plan.x], plan.xColumn, plan.time)}
              </Text>
              <Text style={{ ...type.caption, color: color.text2, fontVariant: ['tabular-nums'] }}>{Math.round((v / sum) * 100)}%</Text>
            </Press>
          ))}
        </View>
      </View>
    );
  } else if (w > 0 && data.length) {
    const right = 8;
    const top = 8;
    const bottom = 22;
    const ih = h - top - bottom;
    const stacked = view.stacked && kind !== 'line' && kind !== 'scatter';
    const values = data.flatMap((r) => (stacked ? [shown.reduce((a, s) => a + (num(r[s.key]) ?? 0), 0)] : shown.map((s) => num(r[s.key]) ?? 0)));
    const fitted = fit && kind === 'line' && values.length > 1;
    const vLo = Math.min(...values);
    const vHi = Math.max(...values);
    const pad = (vHi - vLo || Math.abs(vHi) || 1) * 0.12;
    const lo = fitted ? vLo - pad : Math.min(0, ...values);
    const hi = fitted ? vHi + pad : Math.max(1e-9, ...values);
    const yTicks = ticks(lo, hi);
    // Room for the longest tick label ("$3,000", "600 ms"), at least 40.
    const left = Math.max(40, Math.min(90, 10 + 6.2 * Math.max(...yTicks.map((t) => fmtY(t).length))));
    const iw = Math.max(10, w - left - right);
    const y0 = Math.min(lo, yTicks[0] ?? lo);
    const y1 = Math.max(hi, yTicks.at(-1) ?? hi);
    const Y = (v: number): number => top + ih - ((v - y0) / (y1 - y0 || 1)) * ih;
    const n = data.length;
    // Scatter places x by value when it's a number; everything else by order.
    const xs = data.map((r) => num(r[plan.x]));
    const numericX = kind === 'scatter' && xs.every((x) => x !== undefined);
    const xLo = numericX ? Math.min(...(xs as number[])) : 0;
    const xHi = numericX ? Math.max(...(xs as number[])) : 1;
    const band = iw / n;
    const X = (i: number): number => (numericX ? left + (((xs[i] as number) - xLo) / (xHi - xLo || 1)) * iw : kind === 'bar' ? left + band * (i + 0.5) : left + (n === 1 ? iw / 2 : (i / (n - 1)) * iw));
    const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 64))));
    const tap = (e: GestureResponderEvent) => {
      const x = e.nativeEvent.locationX;
      let best = 0;
      for (let i = 1; i < n; i++) if (Math.abs(X(i) - x) < Math.abs(X(best) - x)) best = i;
      setAt(best);
    };
    const lines = kind === 'line' || kind === 'area';
    const curve = (pts: [number, number][]): string => {
      if (view.curve === 'step') return pts.map((p, i) => (i ? `H${p[0]}V${p[1]}` : `M${p[0]},${p[1]}`)).join('');
      if (view.curve === 'linear' || pts.length < 3) return pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join('');
      // A gentle smooth line through the points (Catmull-Rom as cubic Béziers).
      let d = `M${pts[0]![0]},${pts[0]![1]}`;
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i - 1] ?? pts[i]!;
        const p1 = pts[i]!;
        const p2 = pts[i + 1]!;
        const p3 = pts[i + 2] ?? p2;
        d += `C${p1[0] + (p2[0] - p0[0]) / 6},${p1[1] + (p2[1] - p0[1]) / 6} ${p2[0] - (p3[0] - p1[0]) / 6},${p2[1] - (p3[1] - p1[1]) / 6} ${p2[0]},${p2[1]}`;
      }
      return d;
    };
    body = (
      <Pressable onPress={tap}>
      <Svg width={w} height={h}>
        {view.grid !== false
          ? yTicks.map((t) => (
              <G key={t}>
                <Line x1={left} x2={left + iw} y1={Y(t)} y2={Y(t)} stroke={color.hairline} strokeWidth={1} />
                <SvgText fontFamily={svgFont} x={left - 6} y={Y(t) + 3.5} fontSize={10} fill={color.text3} textAnchor="end">
                  {fmtY(t)}
                </SvgText>
              </G>
            ))
          : null}
        {data.map((r, i) =>
          i % every === 0 ? (
            <SvgText fontFamily={svgFont} key={i} x={X(i)} y={h - 6} fontSize={10} fill={color.text3} textAnchor="middle">
              {xLabel(r[plan.x], plan.xColumn, plan.time).slice(0, 12)}
            </SvgText>
          ) : null,
        )}
        {at !== undefined && kind !== 'bar' ? <Line x1={X(at)} x2={X(at)} y1={top} y2={top + ih} stroke={color.hairlineStrong} strokeWidth={1} /> : null}
        {kind === 'bar'
          ? data.map((r, i) => {
              let base = 0;
              const bw = stacked ? band * 0.62 : (band * 0.72) / Math.max(1, shown.length);
              return shown.map((s, k) => {
                const v = num(r[s.key]) ?? 0;
                const from = stacked ? base : 0;
                const to = from + v;
                if (stacked) base = to;
                const x = stacked ? X(i) - bw / 2 : X(i) - (band * 0.72) / 2 + k * bw;
                const yTop = Y(Math.max(from, to));
                return <Rect key={`${i}:${s.key}`} x={x} y={yTop} width={Math.max(1, bw - 1.5)} height={Math.max(0.5, Math.abs(Y(from) - Y(to)))} rx={Math.min(3, bw / 3)} fill={s.color} opacity={at === undefined || at === i ? 1 : 0.55} />;
              });
            })
          : null}
        {lines
          ? (() => {
              let under: number[] = data.map(() => 0);
              return shown.map((s) => {
                const pts: [number, number][] = data.map((r, i) => {
                  const v = (num(r[s.key]) ?? 0) + (stacked ? under[i]! : 0);
                  return [X(i), Y(v)];
                });
                const base = stacked ? under.map((u, i) => [X(i), Y(u)] as [number, number]) : undefined;
                if (stacked) under = data.map((r, i) => under[i]! + (num(r[s.key]) ?? 0));
                const d = curve(pts);
                const fill = kind === 'area' ? `${d}L${pts.at(-1)![0]},${base ? base.at(-1)![1] : Y(Math.max(0, y0))}${base ? [...base].reverse().map((p) => `L${p[0]},${p[1]}`).join('') : `L${pts[0]![0]},${Y(Math.max(0, y0))}`}Z` : undefined;
                return (
                  <G key={s.key}>
                    {fill ? <Path d={fill} fill={s.color} opacity={0.18} /> : null}
                    <Path d={d} fill="none" stroke={s.color} strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" />
                    {view.dots || n <= 12 ? pts.map((p, i) => <Circle key={i} cx={p[0]} cy={p[1]} r={at === i ? 4 : 2.6} fill={s.color} />) : at !== undefined ? <Circle cx={pts[at]![0]} cy={pts[at]![1]} r={4} fill={s.color} /> : null}
                  </G>
                );
              });
            })()
          : null}
        {kind === 'scatter' ? shown.map((s) => data.map((r, i) => <Circle key={`${s.key}:${i}`} cx={X(i)} cy={Y(num(r[s.key]) ?? 0)} r={at === i ? 5 : 3.6} fill={s.color} opacity={0.85} />)) : null}
      </Svg>
      </Pressable>
    );
  }

  const point = at !== undefined ? data[at] : undefined;
  return (
    <View onLayout={(e) => setW(Math.floor(e.nativeEvent.layout.width))} style={{ gap: 8 }}>
      {body}
      {kind !== 'pie' && kind !== 'donut' && series.length > 1 && view.legend !== false ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          {series.map((s) => (
            <Press key={s.key} haptics={false} onPress={() => setHidden((now) => (now.has(s.key) ? new Set([...now].filter((k) => k !== s.key)) : new Set([...now, s.key])))} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, opacity: hidden.has(s.key) ? 0.4 : 1 }}>
              <View style={{ width: 10, height: 3, borderRadius: 2, backgroundColor: s.color }} />
              <Text style={{ ...type.caption, color: color.text2 }}>{s.label}</Text>
            </Press>
          ))}
        </View>
      ) : null}
      {point && kind !== 'pie' && kind !== 'donut' ? (
        <Text style={{ ...type.caption, color: color.text2, fontVariant: ['tabular-nums'] }}>
          <Text style={{ fontWeight: '700', color: color.text }}>{xLabel(point[plan.x], plan.xColumn, plan.time)}</Text>
          {shown.map((s) => `  ·  ${s.label} ${point[s.key] === null || point[s.key] === undefined ? '–' : fmtY(num(point[s.key]) ?? 0)}`).join('')}
        </Text>
      ) : null}
    </View>
  );
}
