import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ClipboardPaste, Ellipsis } from 'lucide-react-native';
import type { LucideIcon } from 'lucide-react-native';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import { color, ink, tint } from '../lib/theme';
import { haptic, T } from './ui';

/**
 * The terminal's keys above the keyboard (BLG-42), calm: the essentials on the surface (Esc, Tab,
 * Ctrl, one arrows cluster) and ••• for the rest (|, ~, /, paste), on a second row.
 *
 * Snappy, like a keyboard (BLG-108): a key fires the moment it's touched (not on release), with a
 * light tick and a quiet pressed shade; nothing springs, scales or slides. Held, an arrow repeats.
 * Ctrl is sticky: lit until the next key uses it.
 */

const H = 40;
const R = 10;
/** Held arrows repeat after this, then every REPEAT_MS. */
const REPEAT_AFTER_MS = 380;
const REPEAT_MS = 55;

const face = (on: boolean, pressed: boolean): ViewStyle => ({
  height: H,
  borderRadius: R,
  alignItems: 'center',
  justifyContent: 'center',
  backgroundColor: on ? tint.lavender : pressed ? color.sunken : color.card,
  borderWidth: StyleSheet.hairlineWidth,
  borderColor: on ? ink.lavender : color.hairline,
});

/** A key: fires on touch down (and repeats while held, when `repeat`). */
function Key({ a11y, onFire, repeat, style, on = false, children }: { readonly a11y: string; readonly onFire: () => void; readonly repeat?: boolean; readonly style?: (pressed: boolean) => ViewStyle; readonly on?: boolean; readonly children: ReactNode }) {
  const timers = useRef<{ wait?: ReturnType<typeof setTimeout>; every?: ReturnType<typeof setInterval> }>({});
  const fire = useRef(onFire);
  fire.current = onFire;
  const stop = () => {
    clearTimeout(timers.current.wait);
    clearInterval(timers.current.every);
    timers.current = {};
  };
  useEffect(() => stop, []);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityState={on ? { selected: true } : undefined}
      // A screen reader activates (it never presses in).
      accessibilityActions={[{ name: 'activate' }]}
      onAccessibilityAction={() => fire.current()}
      onPressIn={() => {
        haptic.tap();
        fire.current();
        if (!repeat) return;
        stop();
        timers.current.wait = setTimeout(() => {
          timers.current.every = setInterval(() => fire.current(), REPEAT_MS);
        }, REPEAT_AFTER_MS);
      }}
      onPressOut={stop}
      style={({ pressed }) => (style ? style(pressed) : [face(on, pressed), { flex: 1 }])}
    >
      {children}
    </Pressable>
  );
}

function Label({ text, on }: { readonly text: string; readonly on?: boolean }) {
  return (
    <T v="callout" c={on ? ink.lavender : color.text} style={{ fontWeight: on ? '700' : '600', fontSize: text.length > 1 ? 14 : 17 }}>
      {text}
    </T>
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
    <View style={{ paddingHorizontal: 10, paddingTop: 8, paddingBottom: Math.max(8, bottom), gap: 6 }}>
      {more ? (
        <View style={{ flexDirection: 'row', gap: 6 }}>
          <Key a11y="Pipe" onFire={() => onKey('|')}><Label text="|" /></Key>
          <Key a11y="Tilde" onFire={() => onKey('~')}><Label text="~" /></Key>
          <Key a11y="Slash" onFire={() => onKey('/')}><Label text="/" /></Key>
          <Key a11y="Dash" onFire={() => onKey('-')}><Label text="-" /></Key>
          <Key a11y="Paste" onFire={onPaste}><ClipboardPaste color={color.text2} size={18} /></Key>
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 6 }}>
        <Key a11y="Escape" onFire={() => onKey('esc')}><Label text="Esc" /></Key>
        <Key a11y="Tab" onFire={() => onKey('tab')}><Label text="Tab" /></Key>
        <Key a11y="Control" on={ctrl} onFire={onCtrl}><Label text="Ctrl" on={ctrl} /></Key>
        {/* One control for the four arrows: a quiet segmented cluster. */}
        <View style={[face(false, false), { flex: 2.4, flexDirection: 'row', overflow: 'hidden' }]}>
          {ARROWS.map((a, i) => (
            <Key key={a.key} a11y={a.a11y} repeat onFire={() => onKey(a.key)} style={(pressed) => ({ flex: 1, height: H, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? color.sunken : 'transparent', borderLeftWidth: i ? StyleSheet.hairlineWidth : 0, borderLeftColor: color.hairline })}>
              <a.Icon color={color.text2} size={17} />
            </Key>
          ))}
        </View>
        <Key a11y={more ? 'Fewer keys' : 'More keys'} on={more} onFire={() => setMore((m) => !m)} style={(pressed) => ({ ...face(more, pressed), flex: 0.9 })}>
          <Ellipsis color={more ? ink.lavender : color.text2} size={18} />
        </Key>
      </View>
    </View>
  );
}
