import { ArrowDownToLine } from 'lucide-react-native';
import { ScrollView, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { appUpdate } from '../modules/app-update';
import { installUpdate, type UpdateState, useUpdate } from '../lib/update';
import { color, ink } from '../lib/theme';
import { Sheet } from './Sheet';
import { Button, Press, T } from './ui';

/**
 * A new version of the phone app (BLG-426, lib/update.ts), as the Mac's sidebar pill does it: a
 * small pill under Home's greeting, "Beluga 1.8.0 is ready", that opens a sheet with the release's
 * notes, Update Now and Later.
 */
const shows = (u: UpdateState): boolean => !!u.release && ['found', 'downloading', 'ready', 'installing', 'confirm', 'failed'].includes(u.phase);

export function UpdatePill({ onPress }: { readonly onPress: () => void }) {
  const u = useUpdate();
  if (!shows(u)) return null;
  const label = u.phase === 'downloading' ? `Getting Beluga ${u.release!.version}…` : u.phase === 'found' ? `Beluga ${u.release!.version} is out` : `Beluga ${u.release!.version} is ready`;
  return (
    <Animated.View entering={FadeIn.duration(200)} style={{ marginTop: 12, flexDirection: 'row' }}>
      <Press onPress={onPress} accessibilityLabel={label} hitSlop={6} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 30, paddingHorizontal: 12, borderRadius: 15, backgroundColor: color.sunken }}>
        <ArrowDownToLine color={ink.mint} size={15} />
        <T v="caption" c={color.text} style={{ fontWeight: '600' }}>
          {label}
        </T>
      </Press>
    </Animated.View>
  );
}

export function UpdateSheet({ visible, onClose }: { readonly visible: boolean; readonly onClose: () => void }) {
  const u = useUpdate();
  const r = u.release;
  const pct = Math.round((u.progress ?? 0) * 100);
  const label =
    u.phase === 'downloading' ? `Downloading ${pct}%` : u.phase === 'installing' ? 'Installing…' : u.phase === 'confirm' ? 'Waiting for Android' : 'Update Now';
  const sub = u.phase === 'found' ? `${Math.round((r?.size ?? 0) / 1e6)} MB to download` : u.phase === 'ready' ? 'Downloaded and checked' : undefined;
  const busy = u.phase === 'downloading' || u.phase === 'installing' || u.phase === 'confirm';
  return (
    <Sheet window visible={visible && !!r} onDismiss={onClose}>
      {r ? (
        <View style={{ paddingHorizontal: 20, paddingBottom: 12, gap: 14, flexShrink: 1 }}>
          <View style={{ gap: 2 }}>
            <T v="heading" style={{ fontSize: 19 }}>
              Beluga {r.version}
            </T>
            {sub ? <T v="caption">{sub}</T> : null}
          </View>
          {r.notes ? (
            <ScrollView style={{ flexShrink: 1 }} contentContainerStyle={{ paddingBottom: 4 }}>
              <T v="callout" c={color.text2} style={{ lineHeight: 21 }}>
                {r.notes}
              </T>
            </ScrollView>
          ) : null}
          {u.phase === 'downloading' ? (
            <View style={{ height: 6, borderRadius: 3, backgroundColor: color.sunken, overflow: 'hidden' }}>
              <View style={{ height: 6, width: `${pct}%`, borderRadius: 3, backgroundColor: ink.mint, opacity: 0.6 }} />
            </View>
          ) : null}
          {u.error ? (
            <T v="caption" c={color.warn}>
              {u.error}
            </T>
          ) : null}
          {!appUpdate.canInstall() ? (
            <T v="caption">Android asks once to let Beluga install apps. After that, updates go in with one tap, or by themselves.</T>
          ) : (
            <T v="caption">Beluga closes while it updates. Open it again to link to your Mac.</T>
          )}
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Button quiet label="Later" onPress={onClose} flex={1} />
            <Button label={label} Icon={busy ? undefined : ArrowDownToLine} disabled={busy} onPress={() => void installUpdate()} flex={2} />
          </View>
        </View>
      ) : null}
    </Sheet>
  );
}
