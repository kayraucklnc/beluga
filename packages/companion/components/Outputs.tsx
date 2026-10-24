import { Image } from 'expo-image';
import { router } from 'expo-router';
import { FileJson, FileText, FileType, Film, ImageIcon, Play, ScrollText } from 'lucide-react-native';
import { useRef, useState } from 'react';
import { ActivityIndicator, FlatList, ScrollView, StyleSheet, View, type ViewStyle } from 'react-native';
import { useFile } from '../lib/hooks';
import type { OutputView } from '../lib/link/protocol';
import { store } from '../lib/store';
import { color, elevation, radius } from '../lib/theme';
import { IconBadge, Press, T } from './ui';

/**
 * Outputs: pictures as thumbnails (fetched by ref, thumb first; the full image only when opened),
 * videos as their first frame with a play mark (streamed only when played, in the viewer), and
 * text files as tiles that open in the reader. Never source code: the Mac only hands out what
 * `isArtifact` calls an output.
 */

export type Origin = { x: number; y: number; w: number; h: number };

export const isText = (o: OutputView): boolean => o.kind === 'text' || o.kind === 'json' || o.kind === 'markdown';

/**
 * Open an output from where it is, in the viewer: one page per output of the list it was tapped
 * in (pictures, and text files as previews with Open), starting at it and growing from its place.
 * A text file on its own goes straight to the reader.
 */
export function openOutput(o: OutputView, group: readonly OutputView[], origin?: Origin): void {
  const items = group.some((g) => g.ref === o.ref) ? [...group] : [o];
  if (o.kind === 'image' || o.kind === 'video' || items.length > 1) {
    store.gallery = { items, index: Math.max(0, items.findIndex((g) => g.ref === o.ref)), origin };
    router.push('/viewer');
    return;
  }
  if (isText(o)) {
    router.push({ pathname: '/reader', params: { ref: o.ref, name: o.name } });
    return;
  }
  store.toast({ text: `${o.name}: open it on your Mac.`, tone: 'info' });
}

const iconOf = (o: OutputView) => (o.kind === 'json' ? FileJson : o.kind === 'markdown' ? FileType : o.kind === 'video' ? Film : o.name.endsWith('.log') ? ScrollText : FileText);
export const sizeOf = (n?: number): string => (n === undefined ? '' : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export function Thumb({ o, group, w, h, style }: { readonly o: OutputView; readonly group: readonly OutputView[]; readonly w: number; readonly h: number; readonly style?: ViewStyle }) {
  const ref = useRef<React.ComponentRef<typeof View>>(null);
  const image = o.kind === 'image';
  const video = o.kind === 'video';
  // A video's thumbnail is its first frame (a Mac that can't make one says so: then it's a tile).
  const file = useFile(image || video ? o.ref : undefined, 'thumb');
  const Icon = iconOf(o);
  const open = () => {
    if (!ref.current) return openOutput(o, group);
    ref.current.measureInWindow((x: number, y: number, mw: number, mh: number) => openOutput(o, group, { x, y, w: mw, h: mh }));
  };
  return (
    <Press onPress={open} accessibilityLabel={o.name} style={[{ width: w, height: h, borderRadius: radius.m, overflow: 'hidden', backgroundColor: elevation.raised.surface, borderWidth: 1, borderColor: elevation.raised.border }, style]}>
      <View ref={ref} collapsable={false} style={{ flex: 1 }}>
        {image ? (
          file?.uri ? (
            <Image source={{ uri: file.uri }} style={{ flex: 1 }} contentFit="cover" transition={260} />
          ) : (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>{file?.status === 'error' ? <ImageIcon color={color.text3} size={22} /> : <ActivityIndicator color={color.text3} />}</View>
          )
        ) : video && file?.uri ? (
          <View style={{ flex: 1 }}>
            <Image source={{ uri: file.uri }} style={{ flex: 1 }} contentFit="cover" transition={260} />
            <PlayMark size={Math.min(40, Math.round(Math.min(w, h) * 0.34))} />
          </View>
        ) : (
          <View style={{ flex: 1, padding: 12, justifyContent: 'space-between' }}>
            <IconBadge Icon={Icon} tone={o.kind === 'json' ? 'butter' : o.kind === 'markdown' ? 'lavender' : 'sky'} size={34} square />
            <View>
              <T v="callout" c={color.text} numberOfLines={1} ellipsizeMode="middle" style={{ fontWeight: '600', fontSize: 13.5 }}>
                {o.name}
              </T>
              <T v="caption" style={{ marginTop: 2 }}>
                {sizeOf(o.size)}
              </T>
            </View>
          </View>
        )}
      </View>
    </Press>
  );
}

/** A video's mark over its first frame: a quiet round chip, no glow. */
export function PlayMark({ size = 40 }: { readonly size?: number }) {
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
      <View style={{ width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: color.onStageChip }}>
        <Play color={color.onStage} fill={color.onStage} size={Math.round(size * 0.42)} style={{ marginLeft: size * 0.06 }} />
      </View>
    </View>
  );
}

/** A strip you swipe: the newest outputs. */
export function OutputStrip({ items, h = 132 }: { readonly items: readonly OutputView[]; readonly h?: number }) {
  return (
    <FlatList
      horizontal
      data={items as OutputView[]}
      keyExtractor={(o) => o.ref}
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ paddingHorizontal: 16, gap: 10 }}
      decelerationRate="fast"
      snapToInterval={h * 0.78 + 10}
      renderItem={({ item }) => <Thumb o={item} group={items} w={item.kind === 'image' ? h * 0.78 : h * 0.78} h={h} />}
    />
  );
}

/** A grid (a sub-agent's outputs): fills the width it's given. */
export function OutputGrid({ items, cols = 3, gap = 8 }: { readonly items: readonly OutputView[]; readonly cols?: number; readonly gap?: number; readonly width?: number }) {
  const [width, setWidth] = useState(0);
  const w = Math.floor((width - gap * (cols - 1)) / cols);
  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={{ flexDirection: 'row', flexWrap: 'wrap', gap }}>
      {width ? items.map((o) => <Thumb key={o.ref} o={o} group={items} w={w} h={Math.round(w * (o.kind === 'image' ? 1.3 : 0.8))} />) : null}
    </View>
  );
}

/** A turn's outputs, compact (BLG-71): images and files are a row of small cards. */
const TURN_H = 84;

/**
 * What one answer made, as one strip you swipe sideways: pictures as ~110 px thumbnails, text and
 * logs as small cards (an icon, the name, the size). A tap opens the viewer, which swipes through
 * this answer's outputs.
 */
export function TurnOutputs({ items }: { readonly items: readonly OutputView[] }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -16 }} contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}>
      {items.map((o) => (o.kind === 'image' || o.kind === 'video' ? <Thumb key={o.ref} o={o} group={items} w={110} h={TURN_H} /> : <FileCard key={o.ref} o={o} group={items} />))}
    </ScrollView>
  );
}

/** A text output in a turn's strip: its icon, name and size on one small card. */
function FileCard({ o, group }: { readonly o: OutputView; readonly group: readonly OutputView[] }) {
  const Icon = iconOf(o);
  return (
    <Press onPress={() => openOutput(o, group)} accessibilityLabel={o.name} style={{ width: 156, height: TURN_H, borderRadius: radius.m, padding: 10, justifyContent: 'space-between', backgroundColor: elevation.raised.surface, borderWidth: 1, borderColor: elevation.raised.border }}>
      <IconBadge Icon={Icon} tone={o.kind === 'json' ? 'butter' : o.kind === 'markdown' ? 'lavender' : 'sky'} size={28} square />
      <View>
        <T v="caption" c={color.text} numberOfLines={1} ellipsizeMode="middle" style={{ fontWeight: '600' }}>
          {o.name}
        </T>
        <T v="caption" style={{ fontSize: 11.5 }}>{sizeOf(o.size)}</T>
      </View>
    </Press>
  );
}
