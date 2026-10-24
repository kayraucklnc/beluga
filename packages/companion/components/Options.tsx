import type { LucideIcon } from 'lucide-react-native';
import { View } from 'react-native';
import { Sheet } from './Sheet';
import { haptic, IconBadge, Press, T, type Tone } from './ui';

/**
 * The "•••" sheet: the advanced options of whatever it was opened from, one row each (an icon in
 * a pastel circle, a word or two). The same sheet everywhere, so it's learned once.
 */
export interface Option {
  readonly Icon: LucideIcon;
  readonly label: string;
  readonly sub?: string;
  readonly tone?: Tone;
  readonly onPress: () => void;
  readonly hidden?: boolean;
}

export function Options({ visible, onClose, title, options }: { readonly visible: boolean; readonly onClose: () => void; readonly title?: string; readonly options: readonly Option[] }) {
  return (
    <Sheet visible={visible} onDismiss={onClose}>
      <View style={{ paddingHorizontal: 12, paddingBottom: 8 }}>
        {title ? (
          <T v="eyebrow" numberOfLines={1} style={{ paddingHorizontal: 10, paddingBottom: 8 }}>
            {title}
          </T>
        ) : null}
        {options
          .filter((o) => !o.hidden)
          .map((o) => (
            <Press
              key={o.label}
              scaleTo={0.98}
              haptics={false}
              onPress={() => {
                haptic.tap();
                onClose();
                setTimeout(o.onPress, 180);
              }}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 11, paddingHorizontal: 10, borderRadius: 16 }}
            >
              <IconBadge Icon={o.Icon} tone={o.tone ?? 'plain'} size={38} />
              <View style={{ flex: 1 }}>
                <T v="body" style={{ fontWeight: '500' }}>
                  {o.label}
                </T>
                {o.sub ? <T v="caption">{o.sub}</T> : null}
              </View>
            </Press>
          ))}
      </View>
    </Sheet>
  );
}
