import { router } from 'expo-router';
import { FileText, Play, Star } from 'lucide-react-native';
import { Alert, Linking, Text, View } from 'react-native';
import { calls } from '../lib/link/calls';
import type { DashboardTileView, DocRefView } from '../lib/link/protocol';
import { store } from '../lib/store';
import { color, tint, type } from '../lib/theme';
import { deltaCellOf, documentLook, personOf, progressOf, ratingOf, sparkOf } from '../../../src/shared/typed-cells';
import { openOutput } from './Outputs';
import { Spark } from './render/Inline';
import { haptic, Press } from './ui';

type Table = NonNullable<DashboardTileView['table']>;
export type Typed = NonNullable<Table['typed']>[number];
type Cell = string | number | boolean | null;

/**
 * A kept table's typed cell on the phone (BLG-386), as the Mac draws it (BLG-381): a link opens, a
 * document or storage object is a chip that streams it from the Mac into the phone's viewer
 * (pictures and videos in the gallery, text in the reader, a page or a PDF on its own screen, and a
 * kind the phone doesn't show by what it is, with Open on your Mac); progress is a bar, a person their
 * initials, a rating its stars, a change green or rose, a status a badge. Nothing back: the plain cell.
 */
export function TypedCell({ typed, cell, ri, tb, width }: { readonly typed: Typed; readonly cell: Cell; readonly ri: number; readonly tb: Table; readonly width: number }) {
  if (cell === null || cell === '') return null;
  const text = typeof cell === 'string' ? cell : String(cell);
  const whole = typed.values[ri] ?? text;
  switch (typed.kind) {
    case 'url':
      return /^https?:\/\//i.test(whole) ? (
        <Text numberOfLines={1} onPress={() => (haptic.tap(), void Linking.openURL(whole))} accessibilityRole="link" style={{ ...type.callout, width, color: color.info, textDecorationLine: 'underline' }}>
          {whole.replace(/^https?:\/\/(www\.)?/, '')}
        </Text>
      ) : null;
    case 'path':
      return (
        <Text numberOfLines={1} onPress={() => store.toast({ text: `On your Mac: ${whole}`, tone: 'info' })} style={{ ...type.mono, width, color: color.text2 }}>
          {whole.replace(/^\/Users\/[^/]+/, '~')}
        </Text>
      );
    case 'html':
    case 'file':
    case 'storage': {
      const doc = typed.docs?.[ri];
      const metric = tb.metric;
      if (!doc || !metric) return null;
      return (
        <View style={{ width }}>
          <Press onPress={() => openDocument(doc, { sentinelId: metric.sentinelId, metric: metric.name, column: typed.key, value: whole, storage: typed.kind === 'storage' })} accessibilityLabel={`Open ${doc.name}`} style={{ alignSelf: 'flex-start', maxWidth: width - 6, flexDirection: 'row', alignItems: 'center', gap: 5, height: 26, paddingHorizontal: 9, borderRadius: 13, backgroundColor: tint.info }}>
            <FileText size={12} color={color.info} />
            <Text numberOfLines={1} style={{ ...type.caption, color: color.info, fontWeight: '600', flexShrink: 1 }}>
              {typed.button ?? doc.name}
            </Text>
          </Press>
        </View>
      );
    }
    case 'progress': {
      const share = progressOf(cell, typed.max);
      if (share === undefined) return null;
      return (
        <View style={{ width, flexDirection: 'row', alignItems: 'center', gap: 6, paddingRight: 8 }} accessibilityLabel={`${Math.round(share * 100)}%`}>
          <View style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: color.sunken, overflow: 'hidden' }}>
            <View style={{ width: `${share * 100}%`, height: 6, borderRadius: 3, backgroundColor: color.info }} />
          </View>
          <Text style={{ ...type.caption, color: color.text2, fontVariant: ['tabular-nums'] }}>{typeof cell === 'number' ? cell.toLocaleString() : text}</Text>
        </View>
      );
    }
    case 'sparkline': {
      const values = sparkOf(cell);
      return values ? (
        <View style={{ width }}>
          <Spark values={values} w={Math.min(80, width - 8)} h={18} c={color.info} />
        </View>
      ) : null;
    }
    case 'delta': {
      const d = deltaCellOf(cell, typed.better === 'down' || typed.better === 'none' ? typed.better : 'up');
      return d ? <Text style={{ ...type.callout, width, color: d.tone === 'good' ? color.ok : d.tone === 'bad' ? color.error : color.text3, fontVariant: ['tabular-nums'] }}>{d.text}</Text> : null;
    }
    case 'person': {
      const p = personOf(cell);
      return p ? (
        <View style={{ width, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: tint.info, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ fontSize: 9, fontWeight: '700', color: color.info }}>{p.initials}</Text>
          </View>
          <Text numberOfLines={1} style={{ ...type.callout, color: color.text, flexShrink: 1 }}>
            {p.name}
          </Text>
        </View>
      ) : null;
    }
    case 'rating': {
      const r = ratingOf(cell, typed.max);
      return r ? (
        <View style={{ width, flexDirection: 'row', gap: 1 }} accessibilityLabel={`${r.value} of ${r.max}`}>
          {Array.from({ length: r.max }, (_, i) => (
            <Star key={i} size={11} color={i < Math.round(r.value) ? color.warn : color.hairlineStrong} fill={i < Math.round(r.value) ? color.warn : 'transparent'} />
          ))}
        </View>
      ) : null;
    }
    case 'badge': {
      const tone = /fail|error|down|broken|reject|cancel/i.test(text) ? 'error' : /warn|pending|wait|slow|retry/i.test(text) ? 'warn' : /ok|done|pass|success|up|live|merged|active/i.test(text) ? 'ok' : undefined;
      return (
        <View style={{ width }}>
          <View style={{ alignSelf: 'flex-start', height: 20, paddingHorizontal: 8, borderRadius: 10, justifyContent: 'center', backgroundColor: tone ? tint[tone] : color.sunken }}>
            <Text numberOfLines={1} style={{ ...type.caption, fontWeight: '600', color: tone ? color[tone] : color.text2 }}>
              {text}
            </Text>
          </View>
        </View>
      );
    }
    default:
      return null;
  }
}

/** An action column's button: asks first, then runs its sentinel with the row (the columns the phone has). */
export function ActionCell({ typed, row, tb, width }: { readonly typed: Typed; readonly row: readonly Cell[]; readonly tb: Table; readonly width: number }) {
  const words = typed.button ?? 'Run';
  const metric = tb.metric;
  const keys = tb.keys;
  if (!metric || !keys) return null;
  const run = () => {
    // Cells the view cut short can't name the row: they're left out (the Mac checks what's left names one row).
    const sent: Record<string, Cell> = {};
    keys.forEach((k, i) => {
      const v = row[i] ?? null;
      if (k !== typed.key && !(typeof v === 'string' && v.length >= 300)) sent[k] = v;
    });
    Alert.alert(words, 'Runs its sentinel on your Mac with this row.', [
      { text: 'Cancel', style: 'cancel' },
      { text: words, onPress: () => void store.call(calls.sentinelRunRow(metric.sentinelId, metric.name, typed.key, sent, words)).then(() => store.toast({ text: `${words}: running on your Mac`, tone: 'ok' }), (e: Error) => store.toast({ text: e.message, tone: 'error' })) },
    ]);
  };
  return (
    <View style={{ width }}>
      <Press onPress={run} accessibilityLabel={words} style={{ alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 5, height: 26, paddingHorizontal: 10, borderRadius: 13, backgroundColor: color.sunken }}>
        <Play size={11} color={color.text} />
        <Text numberOfLines={1} style={{ ...type.caption, fontWeight: '600', color: color.text }}>
          {words}
        </Text>
      </Press>
    </View>
  );
}

export interface DocCell {
  readonly sentinelId: string;
  readonly metric: string;
  readonly column: string;
  readonly value: string;
  readonly storage: boolean;
}

/**
 * Open a document streamed from the Mac: a picture or a video in the gallery, text (Markdown, JSON,
 * a log) in the reader, the rest on its own screen (a page with nothing allowed to run, a PDF, or
 * what it is and Open on your Mac).
 */
export function openDocument(doc: DocRefView, cell: DocCell): void {
  haptic.tap();
  const look = documentLook(doc.mime);
  if (look === 'image' && doc.mime !== 'image/svg+xml') return openOutput({ ref: doc.ref, name: doc.name, kind: 'image' }, []);
  if (look === 'video') return openOutput({ ref: doc.ref, name: doc.name, kind: 'video' }, []);
  if (look === 'text' || look === 'json' || look === 'markdown') return void router.push({ pathname: '/reader', params: { ref: doc.ref, name: doc.name } });
  router.push({ pathname: '/document', params: { ref: doc.ref, name: doc.name, mime: doc.mime, sentinelId: cell.sentinelId, metric: cell.metric, column: cell.column, value: cell.value, storage: cell.storage ? '1' : '' } });
}
