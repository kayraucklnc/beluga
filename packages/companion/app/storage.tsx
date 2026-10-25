import { Archive, Eraser, FileText, Film, FolderOpen, HardDrive, ImageIcon, Trash2 } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Platform, ScrollView, Switch, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Options, type Option } from '../components/Options';
import { sizeOf } from '../components/Outputs';
import { Header, Screen, useScrolled } from '../components/Screen';
import { Card, haptic, Row, T } from '../components/ui';
import { useView } from '../lib/hooks';
import { isMacTopic, type WorkView } from '../lib/link/protocol';
import { cacheSize, cleanupOn, clearCache, folderName, keepsTrack, pickFolder, prune, removeSaved, type SavedFile, setCleanup, useSaved } from '../lib/saved';
import { groups, totalBytes } from '../lib/saved-list';
import { store } from '../lib/store';
import { color, ink } from '../lib/theme';

/**
 * Settings › Storage (BLG-125): what Beluga keeps on the phone. The files you saved, by the
 * conversation they came from (each, or a conversation's, deleted from the ••• sheet), the cache
 * (full pictures shown, emptied at every launch, or here), where saves go, and whether saved files
 * go when their conversation is archived or deleted on your Mac.
 */
export default function Storage() {
  const { scrolled, onScroll } = useScrolled();
  const insets = useSafeAreaInsets();
  const saved = useSaved();
  const work = useView<WorkView>('work');
  const [cache, setCache] = useState(0);
  const [cleanup, setCleanupOn] = useState(cleanupOn());
  const [folder, setFolder] = useState(folderName());
  const [sheet, setSheet] = useState<{ title: string; options: Option[] }>();
  useEffect(() => {
    // Files you deleted in the gallery or Files leave the list.
    prune();
    setCache(cacheSize());
  }, []);

  const titles = new Map((work?.data.projects ?? []).flatMap((p) => p.conversations.map((c) => [c.topic as string, c.title] as const)));
  const titleOf = (topic: string | undefined): string => (!topic ? 'Elsewhere' : isMacTopic(topic) ? 'Your Mac' : (titles.get(topic) ?? 'A conversation'));
  const byConv = groups(saved, titleOf);

  const remove = (which: readonly SavedFile[]) => {
    haptic.warn();
    const n = removeSaved(which);
    store.toast({ text: n === 1 ? 'Deleted from the phone' : `Deleted ${n} files from the phone`, tone: 'ok' });
  };
  const toggle = (on: boolean) => (
    <View pointerEvents="none">
      <Switch value={on} trackColor={{ true: ink.mint, false: color.hairlineStrong }} thumbColor={color.white} {...(Platform.OS === 'web' ? ({ activeThumbColor: color.white } as object) : {})} />
    </View>
  );

  return (
    <Screen>
      <Header scrolled={scrolled} back title="Storage" />
      <ScrollView onScroll={onScroll} scrollEventThrottle={32} contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40, gap: 20 }}>
        <Animated.View entering={FadeInDown.duration(300)} style={{ gap: 20 }}>
          <Card>
            <Row first Icon={HardDrive} tone="sky" label="Saved on this phone" sub={saved.length ? `${saved.length} ${saved.length === 1 ? 'file' : 'files'} · ${sizeOf(totalBytes(saved))}` : 'Nothing yet'} chevron={false} />
            <Row
              Icon={Eraser}
              tone="butter"
              label="Cache"
              sub={`${sizeOf(cache)} · pictures you opened`}
              onPress={() =>
                setSheet({
                  title: 'Cache',
                  options: [
                    {
                      Icon: Eraser,
                      label: 'Clear the cache',
                      sub: 'Saved files stay',
                      tone: 'butter',
                      onPress: () =>
                        void clearCache().then(() => {
                          setCache(cacheSize());
                          store.toast({ text: 'Cache cleared', tone: 'ok' });
                        }),
                    },
                  ],
                })
              }
            />
          </Card>

          {keepsTrack ? (
            <Card>
              <Row
                first
                Icon={Archive}
                tone="mint"
                label="Remove when archived"
                sub="Saved files go with their conversation"
                right={toggle(cleanup)}
                chevron={false}
                onPress={() => {
                  haptic.tap();
                  setCleanupOn(!cleanup);
                  setCleanup(!cleanup);
                }}
              />
              <Row Icon={FolderOpen} tone="lavender" label="Save to" sub={folder ?? 'Asked the first time you save'} onPress={() => void pickFolder().then(() => setFolder(folderName()))} />
            </Card>
          ) : (
            <T v="caption" style={{ paddingHorizontal: 6 }}>
              On iPhone, Save opens the share sheet: what you save there is yours to keep or delete.
            </T>
          )}

          {byConv.map((g) => (
            <View key={g.key} style={{ gap: 8 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6, gap: 8 }}>
                <T v="eyebrow" numberOfLines={1} style={{ flex: 1 }}>
                  {g.title}
                </T>
                <T v="caption">{sizeOf(g.bytes)}</T>
              </View>
              <Card>
                {g.files.map((f, i) => (
                  <Row
                    key={f.uri}
                    first={i === 0}
                    Icon={f.kind === 'image' ? ImageIcon : f.kind === 'video' ? Film : FileText}
                    tone={f.kind === 'image' ? 'peach' : f.kind === 'video' ? 'lavender' : 'sky'}
                    label={f.name}
                    sub={`${sizeOf(f.size)} · ${new Date(f.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`}
                    chevron={false}
                    onPress={() =>
                      setSheet({
                        title: f.name,
                        options: [
                          { Icon: Trash2, label: 'Delete from the phone', tone: 'rose', onPress: () => remove([f]) },
                          { Icon: Trash2, label: `Delete all ${g.files.length} from this conversation`, sub: `${g.title} · ${sizeOf(g.bytes)}`, tone: 'rose', hidden: g.files.length < 2, onPress: () => remove(g.files) },
                        ],
                      })
                    }
                  />
                ))}
              </Card>
            </View>
          ))}
          {!saved.length ? (
            <T v="caption" style={{ paddingHorizontal: 6 }}>
              Open a picture, video or file full screen and tap Save to keep it on the phone.
            </T>
          ) : null}
        </Animated.View>
      </ScrollView>
      <Options visible={Boolean(sheet)} onClose={() => setSheet(undefined)} title={sheet?.title} options={sheet?.options ?? []} />
    </Screen>
  );
}
