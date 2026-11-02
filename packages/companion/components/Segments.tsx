import type { LucideIcon } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { color, scheme } from '../lib/theme';
import { Press, T } from './ui';

/** A segmented control: the choice you're on is a raised plate that glides (never springs) to it. */
export function Segments<K extends string>({ value, options, onChange }: { readonly value: K; readonly options: readonly { key: K; label: string; badge?: number; Icon?: LucideIcon }[]; readonly onChange: (k: K) => void }) {
  const [w, setW] = useState(0);
  const seg = w / options.length;
  const x = useSharedValue(0);
  const i = options.findIndex((o) => o.key === value);
  useEffect(() => {
    x.value = withTiming(i * seg, { duration: 200, easing: Easing.out(Easing.cubic) });
  }, [i, seg]);
  const capsule = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  return (
    <View onLayout={(e) => setW(e.nativeEvent.layout.width - 6)} style={{ flexDirection: 'row', height: 36, padding: 3, borderRadius: 10, backgroundColor: color.sunken }}>
      {w ? <Animated.View style={[{ position: 'absolute', top: 3, left: 3, width: seg, height: 30, borderRadius: 8, backgroundColor: color.selected, ...(scheme === 'light' ? { borderWidth: 0.5, borderColor: 'rgba(0,0,0,0.06)' } : {}) }, capsule]} /> : null}
      {options.map((o) => (
        <Press key={o.key} onPress={() => onChange(o.key)} style={{ width: seg || undefined, flex: seg ? undefined : 1, height: 30, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6 }}>
          {o.Icon ? <o.Icon color={o.key === value ? color.text : color.text2} size={16} strokeWidth={1.9} /> : null}
          <T v="callout" c={o.key === value ? color.text : color.text2} style={{ fontWeight: o.key === value ? '600' : '500' }}>
            {o.label}
          </T>
          {o.badge ? (
            <View style={{ minWidth: 16, alignItems: 'center', justifyContent: 'center' }}>
              <T v="caption" c={color.text3} style={{ fontSize: 12, fontWeight: '600' }}>
                {o.badge}
              </T>
            </View>
          ) : null}
        </Press>
      ))}
    </View>
  );
}
