import { Braces, ChevronDown, ChevronRight, Copy, FileJson, ListTree } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { type Json, type JsonDoc, jsonPreview, jsonSize, openDepth } from '../../lib/render';
import { color, ink, radius, type } from '../../lib/theme';
import { haptic, Press, T } from '../ui';
import { copy, SmallChip } from './parts';

/**
 * JSON Claude wrote (BLG-87), read by the Mac's own reader (src/shared/render/json-tree.ts): a
 * tree that folds, each kind of value in its soft color, a folded object or array with a preview
 * and how much it holds. Raw shows it beautified. Copy copies it as written; long-press copies it
 * beautified.
 */

interface Line {
  readonly id: string;
  readonly depth: number;
  readonly key?: string | number;
  readonly value: Json;
  readonly open: boolean;
  readonly container: boolean;
}

const MAX_ROWS = 400;
/** Rows read at all (Raw has the rest). */
const MAX_LINES = 5000;

const isContainer = (v: Json): v is readonly Json[] | { readonly [k: string]: Json } => v !== null && typeof v === 'object';

function linesOf(doc: JsonDoc, toggled: ReadonlySet<string>): Line[] {
  const depthOpen = openDepth(doc);
  const out: Line[] = [];
  const walk = (value: Json, depth: number, id: string, key?: string | number): void => {
    if (out.length >= MAX_LINES) return;
    const container = isContainer(value);
    // Open to the document's depth at first; each tap flips one.
    const open = container && (depth < depthOpen) !== toggled.has(id);
    out.push({ id, depth, ...(key !== undefined ? { key } : {}), value, open, container });
    if (!open) return;
    if (Array.isArray(value)) value.forEach((v, i) => walk(v, depth + 1, `${id}.${i}`, i));
    else Object.entries(value as Record<string, Json>).forEach(([k, v]) => walk(v, depth + 1, `${id}.${JSON.stringify(k)}`, k));
  };
  walk(doc.value, 0, '$');
  return out;
}

/** Soft colors for each kind of value (the pastels' inks, light and dark). */
const valueColor = (v: Json): string => (v === null ? color.text3 : typeof v === 'string' ? ink.mint : typeof v === 'number' ? ink.sky : typeof v === 'boolean' ? ink.lavender : color.text2);
const leaf = (v: Json): string => (typeof v === 'string' ? JSON.stringify(v) : String(v));

export function JsonTree({ doc, text }: { readonly doc: JsonDoc; readonly text: string }) {
  const [raw, setRaw] = useState(false);
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const [all, setAll] = useState(false);
  const lines = useMemo(() => linesOf(doc, toggled), [doc, toggled]);
  const shown = all ? lines : lines.slice(0, MAX_ROWS);
  const flip = (id: string) => {
    haptic.tap();
    setToggled((t) => {
      const n = new Set(t);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };
  const mono = [type.mono, { fontSize: 12.5, lineHeight: 20 }];
  return (
    <Press haptics={false} scaleTo={1} onLongPress={() => copy(doc.pretty, 'Copied, beautified')} delayLongPress={380} style={{ gap: 8 }}>
      <View style={{ borderRadius: radius.m - 2, backgroundColor: color.code, overflow: 'hidden' }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ padding: raw ? 12 : 8, minWidth: '100%' }}>
          {raw ? (
            <Text selectable style={[...mono, { color: color.text }]}>
              {doc.pretty}
            </Text>
          ) : (
            <View style={{ flexGrow: 1 }}>
              {shown.map((l) => {
                const keyText =
                  l.key === undefined ? null : typeof l.key === 'number' ? (
                    <Text style={{ color: color.text3 }}>{l.key}: </Text>
                  ) : (
                    <Text style={{ color: color.text, fontWeight: '600' }}>
                      {/^[A-Za-z_$][\w$-]*$/.test(l.key) ? l.key : JSON.stringify(l.key)}
                      <Text style={{ color: color.text3, fontWeight: '400' }}>: </Text>
                    </Text>
                  );
                const row = (
                  <View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: l.depth * 14, paddingRight: 8, minHeight: 22 }}>
                    <View style={{ width: 16, alignItems: 'center' }}>{l.container ? l.open ? <ChevronDown color={color.text3} size={12} strokeWidth={1.9} /> : <ChevronRight color={color.text3} size={12} strokeWidth={1.9} /> : null}</View>
                    <Text numberOfLines={1} style={mono}>
                      {keyText}
                      {l.container ? (
                        l.open ? (
                          <Text style={{ ...type.caption, color: color.text3 }}>{jsonSize(l.value)}</Text>
                        ) : (
                          <Text>
                            <Text style={{ color: color.text2 }}>{jsonPreview(l.value)}</Text>
                            <Text style={{ ...type.caption, color: color.text3 }}> {jsonSize(l.value)}</Text>
                          </Text>
                        )
                      ) : (
                        <Text style={{ color: valueColor(l.value) }}>{leaf(l.value)}</Text>
                      )}
                    </Text>
                  </View>
                );
                return l.container ? (
                  <Press key={l.id} haptics={false} scaleTo={0.99} onPress={() => flip(l.id)} onLongPress={() => copy(doc.pretty, 'Copied, beautified')} delayLongPress={380} accessibilityLabel={`${l.key ?? 'root'}, ${l.open ? 'open' : 'folded'}`}>
                    {row}
                  </Press>
                ) : (
                  <View key={l.id}>{row}</View>
                );
              })}
              {lines.length > shown.length ? (
                <View style={{ paddingLeft: 16, paddingTop: 4, alignSelf: 'flex-start' }}>
                  <SmallChip label={`Show ${lines.length - shown.length} more rows`} onPress={() => setAll(true)} />
                </View>
              ) : null}
            </View>
          )}
        </ScrollView>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={{ flexDirection: 'row', padding: 2, gap: 2, borderRadius: 15, backgroundColor: color.sunken }}>
          {([['Tree', ListTree, false], ['Raw', Braces, true]] as const).map(([label, Icon, on]) => (
            <Press key={label} haptics={false} onPress={() => (haptic.tap(), setRaw(on))} accessibilityLabel={label} accessibilityState={{ selected: raw === on }} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, height: 26, paddingHorizontal: 10, borderRadius: 13, backgroundColor: raw === on ? color.card : 'transparent' }}>
              <Icon color={raw === on ? color.text : color.text3} size={13} />
              <Text style={{ ...type.caption, color: raw === on ? color.text : color.text3, fontWeight: '700' }}>{label}</Text>
            </Press>
          ))}
        </View>
        <SmallChip label="Copy" Icon={Copy} onPress={() => copy(text)} />
        <View style={{ flex: 1 }} />
        <FileJson color={color.text3} size={13} />
        <T v="caption">{isContainer(doc.value) ? jsonSize(doc.value) : 'JSON'}</T>
      </View>
    </Press>
  );
}
