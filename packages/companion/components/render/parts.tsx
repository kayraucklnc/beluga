import * as Clipboard from 'expo-clipboard';
import type { LucideIcon } from 'lucide-react-native';
import { Text } from 'react-native';
import { store } from '../../lib/store';
import { color, ink, tint, type } from '../../lib/theme';
import { haptic, Press } from '../ui';

/** Small pieces the drawn blocks share (file trees, JSON, terminals). */

/** Copies, with a tick and a toast. */
export function copy(text: string, what = 'Copied'): void {
  haptic.success();
  void Clipboard.setStringAsync(text);
  store.toast({ text: what, tone: 'ok' });
}

/** A small rounded chip under or on a block: one or two words, maybe an icon. */
export function SmallChip({ label, Icon, on = false, onPress, accessibilityLabel }: { readonly label: string; readonly Icon?: LucideIcon; readonly on?: boolean; readonly onPress: () => void; readonly accessibilityLabel?: string }) {
  return (
    <Press haptics={false} accessibilityLabel={accessibilityLabel ?? label} accessibilityState={{ selected: on }} onPress={() => (haptic.tap(), onPress())} hitSlop={4} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, height: 28, paddingHorizontal: 10, borderRadius: 14, backgroundColor: on ? tint.sky : color.sunken }}>
      {Icon ? <Icon color={on ? ink.sky : color.text2} size={13} strokeWidth={2.2} /> : null}
      <Text style={{ ...type.caption, color: on ? ink.sky : color.text2, fontWeight: '700' }}>{label}</Text>
    </Press>
  );
}
