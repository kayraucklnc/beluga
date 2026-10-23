import type { LucideIcon } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { color, spring, tint } from '../lib/theme';
import { Press, T } from './ui';

/** A segmented control with a capsule that springs between the choices. */
export function Segments<K extends string>({ value, options, onChange }: { readonly value: K; readonly options: readonly { key: K; label: string; badge?: number; Icon?: LucideIcon }[]; readonly onChange: (k: K) => void }) {
  const [w, setW] = useState(0);
  const seg = w / options.length;
  const x = useSharedValue(0);
  const i = options.findIndex((o) => o.key === value);
  useEffect(() => {
    x.value = withSpring(i * seg, spring.snappy);
  }, [i, seg]);
  const capsule = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  return (
    <View onLayout={(e) => setW(e.nativeEvent.layout.width - 6)} style={{ flexDirection: 'row', height: 38, padding: 3, borderRadius: 19, backgroundColor: color.sunken }}>
      {w ? <Animated.View style={[{ position: 'absolute', top: 3, left: 3, width: seg, height: 32, borderRadius: 16, backgroundColor: color.selected }, capsule]} /> : null}
      {options.map((o) => (
        <Press key={o.key} onPress={() => onChange(o.key)} style={{ width: seg || undefined, flex: seg ? undefined : 1, height: 32, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6 }}>
          {o.Icon ? <o.Icon color={o.key === value ? color.text : color.text2} size={16} strokeWidth={2.2} /> : null}
          <T v="callout" c={o.key === value ? color.text : color.text2} style={{ fontWeight: '600' }}>
            {o.label}
          </T>
          {o.badge ? (
            <View style={{ minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5, backgroundColor: tint.claude, alignItems: 'center', justifyContent: 'center' }}>
              <T v="caption" c={color.claude} style={{ fontSize: 10.5, fontWeight: '800' }}>
                {o.badge}
              </T>
            </View>
          ) : null}
        </Press>
      ))}
    </View>
  );
}
