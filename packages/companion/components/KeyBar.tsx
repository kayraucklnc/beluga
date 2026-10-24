import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ClipboardPaste, Ellipsis } from 'lucide-react-native';
import type { LucideIcon } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { FadeInDown, FadeOutDown, LinearTransition } from 'react-native-reanimated';
import { color, ink, tint } from '../lib/theme';
import { haptic, Press, T } from './ui';

/**
 * The terminal's keys above the keyboard (BLG-42), calm: the essentials on the surface (Esc, Tab,
 * Ctrl, one arrows cluster) and ••• for the rest (|, ~, /, paste), on a second row that slides up.
 */

const H = 44;
const keyStyle = (on = false) => ({ height: H, borderRadius: 14, alignItems: 'center' as const, justifyContent: 'center' as const, backgroundColor: on ? tint.lavender : color.card, borderWidth: StyleSheet.hairlineWidth, borderColor: on ? 'transparent' : color.hairline });

function Key({ label, Icon, a11y, on, onPress, flex = 1 }: { readonly label?: string; readonly Icon?: LucideIcon; readonly a11y: string; readonly on?: boolean; readonly onPress: () => void; readonly flex?: number }) {
  return (
    <Press haptics={false} scaleTo={0.94} accessibilityLabel={a11y} onPress={() => (haptic.tap(), onPress())} style={[keyStyle(on), { flex }]}>
      {Icon ? (
        <Icon color={on ? ink.lavender : color.text2} size={18} />
      ) : (
        <T v="callout" c={on ? ink.lavender : color.text} style={{ fontWeight: '600', fontSize: label && label.length > 1 ? 14 : 17 }}>
          {label}
        </T>
      )}
    </Press>
  );
}

const ARROWS: ReadonlyArray<{ key: string; Icon: LucideIcon; a11y: string }> = [
  { key: 'left', Icon: ArrowLeft, a11y: 'Left' },
  { key: 'up', Icon: ArrowUp, a11y: 'Up' },
  { key: 'down', Icon: ArrowDown, a11y: 'Down' },
  { key: 'right', Icon: ArrowRight, a11y: 'Right' },
];

export function KeyBar({ ctrl, onKey, onCtrl, onPaste, bottom }: { readonly ctrl: boolean; readonly onKey: (key: string) => void; readonly onCtrl: () => void; readonly onPaste: () => void; readonly bottom: number }) {
  const [more, setMore] = useState(false);
  return (
    <Animated.View layout={LinearTransition.springify().stiffness(260).damping(28)} style={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: Math.max(10, bottom), gap: 8 }}>
      {more ? (
        <Animated.View entering={FadeInDown.springify().stiffness(260).damping(26)} exiting={FadeOutDown.duration(140)} style={{ flexDirection: 'row', gap: 8 }}>
          <Key label="|" a11y="Pipe" onPress={() => onKey('|')} />
          <Key label="~" a11y="Tilde" onPress={() => onKey('~')} />
          <Key label="/" a11y="Slash" onPress={() => onKey('/')} />
          <Key Icon={ClipboardPaste} a11y="Paste" onPress={onPaste} />
        </Animated.View>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Key label="Esc" a11y="Escape" onPress={() => onKey('esc')} />
        <Key label="Tab" a11y="Tab" onPress={() => onKey('tab')} />
        <Key label="Ctrl" a11y="Control" on={ctrl} onPress={onCtrl} />
        {/* One control for the four arrows: a quiet segmented cluster. */}
        <View style={[keyStyle(), { flex: 2.2, flexDirection: 'row', overflow: 'hidden' }]}>
          {ARROWS.map((a, i) => (
            <Press key={a.key} haptics={false} scaleTo={0.9} accessibilityLabel={a.a11y} onPress={() => (haptic.tap(), onKey(a.key))} style={{ flex: 1, height: H, alignItems: 'center', justifyContent: 'center', borderLeftWidth: i ? StyleSheet.hairlineWidth : 0, borderLeftColor: color.hairline }}>
              <a.Icon color={color.text2} size={17} />
            </Press>
          ))}
        </View>
        <Key Icon={Ellipsis} a11y={more ? 'Fewer keys' : 'More keys'} on={more} onPress={() => setMore((m) => !m)} flex={0.9} />
      </View>
    </Animated.View>
  );
}
