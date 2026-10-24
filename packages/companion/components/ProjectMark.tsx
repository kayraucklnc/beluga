import { Image } from 'expo-image';
import { Text, View } from 'react-native';
import { useIcon } from '../lib/hooks';
import { elevation } from '../lib/theme';
import { hueOf, toneBg, toneInk } from './ui';

/**
 * A project's mark: its own icon from the Mac (small, by checksum, cached: lib/store.ts `icon`),
 * else its initial in a pastel tint, the same tint every time for the same name.
 */
export function ProjectMark({ name, icon, size = 34 }: { readonly name: string; readonly icon?: string; readonly size?: number }) {
  const uri = useIcon(icon);
  const r = size * 0.3;
  if (uri) {
    return (
      <View style={{ width: size, height: size, borderRadius: r, overflow: 'hidden', backgroundColor: elevation.raised.surface, borderWidth: 1, borderColor: elevation.raised.border }}>
        <Image source={{ uri }} style={{ flex: 1 }} contentFit="cover" transition={180} accessibilityLabel={name} />
      </View>
    );
  }
  const t = hueOf(name || '?');
  return (
    <View style={{ width: size, height: size, borderRadius: r, alignItems: 'center', justifyContent: 'center', backgroundColor: toneBg(t) }}>
      <Text style={{ color: toneInk(t), fontSize: size * 0.44, fontWeight: '700' }}>{(name.trim()[0] ?? '?').toUpperCase()}</Text>
    </View>
  );
}
