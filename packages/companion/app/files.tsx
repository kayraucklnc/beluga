import { router, useLocalSearchParams } from 'expo-router';
import { ChevronRight, FolderTree, Lock, Search, X } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, FlatList, Platform, ScrollView, TextInput, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { openOutput, sizeOf } from '../components/Outputs';
import { Header, Screen, useScrolled } from '../components/Screen';
import { fileIcon } from '../components/fileIcon';
import { Card, Hairline, IconBadge, Press, T } from '../components/ui';
import { useLink } from '../lib/hooks';
import { calls } from '../lib/link/calls';
import type { FileEntryView, FolderView, FoundView, OutputView, Topic } from '../lib/link/protocol';
import { videoFormat } from '../lib/media';
import { store } from '../lib/store';
import { color, tint } from '../lib/theme';

/**
 * A worktree's files (BLG-42), read-only: folders and files with their icons, breadcrumbs to go
 * back up, and a search by name across the worktree. A file opens in the source viewer, a picture
 * in the image viewer. The Mac's file gate decides what's there: never secrets, nothing outside the
 * worktree. Nothing here can change a file.
 */

export default function Files() {
  const { scrolled, onScroll } = useScrolled();
  const { topic, name, path: start } = useLocalSearchParams<{ topic: string; name?: string; path?: string }>();
  const t = topic as Topic;
  const insets = useSafeAreaInsets();
  const link = useLink();
  const [path, setPath] = useState(start ?? '');
  const [folder, setFolder] = useState<FolderView | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<FoundView | undefined>();
  const [finding, setFinding] = useState(false);
  const cache = useRef(new Map<string, FolderView>());

  // A folder: from the Mac (kept for this visit, so going back up is instant).
  useEffect(() => {
    let live = true;
    const have = cache.current.get(path);
    setFolder(have);
    setError(undefined);
    // Asked once the link is open; until then what was seen this visit (or a spinner), or why not.
    if (link.phase !== 'open') {
      if (!have && link.phase === 'asleep') setError('Your Mac is away. Its files come back when it answers.');
      return;
    }
    store.call<FolderView>(calls.filesList(t, path), { queue: false }).then(
      (f) => {
        if (!live || !f) return;
        cache.current.set(path, f);
        setFolder(f);
      },
      (e: Error) => live && !have && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [path, t, link.phase === 'open']);

  // Search by name, a moment after you stop typing.
  useEffect(() => {
    const q = query.trim();
    if (!q) return setFound(undefined);
    setFinding(true);
    const timer = setTimeout(() => {
      store.call<FoundView>(calls.filesFind(t, q), { queue: false }).then(
        (f) => {
          setFound(f);
          setFinding(false);
        },
        (e: Error) => {
          setFinding(false);
          store.toast({ text: e.message, tone: 'error' });
        },
      );
    }, 260);
    return () => clearTimeout(timer);
  }, [query, t]);

  // Android's back goes up a folder first.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!path) return false;
      setPath(path.split('/').slice(0, -1).join('/'));
      return true;
    });
    return () => sub.remove();
  }, [path]);

  const crumbs = useMemo(() => {
    const parts = path ? path.split('/') : [];
    return [{ label: name ?? 'Worktree', path: '' }, ...parts.map((p, i) => ({ label: p, path: parts.slice(0, i + 1).join('/') }))];
  }, [path, name]);

  const open = (rel: string, dir: boolean, entry?: FileEntryView) => {
    if (dir) {
      setQuery('');
      return setPath(rel);
    }
    if (entry?.ref) {
      // Pictures and videos come with a ref (the Mac's file gate decides); the name says which.
      const o: OutputView = { ref: entry.ref, name: entry.name, kind: videoFormat(entry.name) ? 'video' : 'image', ...(entry.size !== undefined ? { size: entry.size } : {}) };
      return openOutput(o, [o], undefined, t);
    }
    router.push({ pathname: '/source', params: { topic: t, path: rel } });
  };

  const rows = found ? found.hits.map((h) => ({ key: h.path, label: h.path.split('/').pop() ?? h.path, sub: h.path.includes('/') ? h.path.slice(0, h.path.lastIndexOf('/')) : undefined, dir: h.dir, rel: h.path, entry: undefined as FileEntryView | undefined })) : (folder?.entries ?? []).map((e) => ({ key: e.name, label: e.name, sub: e.dir ? undefined : sizeOf(e.size), dir: e.dir, rel: path ? `${path}/${e.name}` : e.name, entry: e }));

  return (
    <Screen>
      <Header scrolled={scrolled} back eyebrow="Files · read only" title={name ?? 'Files'} lead={<IconBadge Icon={FolderTree} tone="sky" size={30} />} />
      <Animated.View entering={FadeIn.duration(180)} style={{ paddingHorizontal: 16, paddingBottom: 8, gap: 10 }}>
        <Card r={18} style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, height: 42, gap: 8 }}>
          <Search color={color.text2} size={16} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Find a file by name"
            placeholderTextColor={color.text3}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            style={{ flex: 1, color: color.text, fontSize: 15, ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}) }}
          />
          {finding ? <ActivityIndicator size="small" color={color.text3} /> : null}
          {query ? (
            <Press onPress={() => setQuery('')} hitSlop={8} accessibilityLabel="Clear">
              <X color={color.text2} size={17} />
            </Press>
          ) : null}
        </Card>
        {!found ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ alignItems: 'center', gap: 2, paddingRight: 8 }}>
            {crumbs.map((c, i) => {
              const last = i === crumbs.length - 1;
              return (
                <View key={c.path || '/'} style={{ flexDirection: 'row', alignItems: 'center' }}>
                  {i ? <ChevronRight color={color.text3} size={14} /> : null}
                  <Press onPress={() => setPath(c.path)} disabled={last} style={{ paddingHorizontal: 9, height: 28, borderRadius: 14, justifyContent: 'center', backgroundColor: last ? tint.sky : 'transparent' }}>
                    <T v="caption" c={last ? color.info : color.text2} numberOfLines={1} style={{ fontWeight: last ? '700' : '600', maxWidth: 180 }}>
                      {c.label}
                    </T>
                  </Press>
                </View>
              );
            })}
          </ScrollView>
        ) : (
          <T v="caption" style={{ paddingHorizontal: 4 }}>
            {found.hits.length ? `${found.hits.length}${found.more ? '+' : ''} ${found.hits.length === 1 ? 'match' : 'matches'}` : 'Nothing by that name'}
          </T>
        )}
      </Animated.View>
      {error && !folder ? (
        <Animated.View entering={FadeIn} style={{ alignItems: 'center', padding: 30, gap: 12 }}>
          <IconBadge Icon={Lock} tone="rose" size={44} />
          <T v="callout" style={{ textAlign: 'center' }}>
            {error}
          </T>
          {path ? (
            <Press onPress={() => setPath('')}>
              <T v="callout" c={color.info}>
                Back to the top
              </T>
            </Press>
          ) : null}
        </Animated.View>
      ) : !folder && !found ? (
        <View style={{ padding: 40, alignItems: 'center' }}>
          <ActivityIndicator color={color.text2} />
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.key}
          onScroll={onScroll}
          scrollEventThrottle={32}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 30 }}
          ListEmptyComponent={
            !found ? (
              <T v="callout" style={{ textAlign: 'center', marginTop: 30 }}>
                This folder is empty
              </T>
            ) : undefined
          }
          renderItem={({ item, index }) => {
            const { Icon, tone } = fileIcon(item.label, item.dir);
            return (
              <View style={{ backgroundColor: color.card, borderTopLeftRadius: index === 0 ? 18 : 0, borderTopRightRadius: index === 0 ? 18 : 0, borderBottomLeftRadius: index === rows.length - 1 ? 18 : 0, borderBottomRightRadius: index === rows.length - 1 ? 18 : 0 }}>
                {index ? <Hairline style={{ marginLeft: 58 }} /> : null}
                <Press scaleTo={0.985} onPress={() => open(item.rel, item.dir, item.entry)} accessibilityLabel={item.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 12 }}>
                  <IconBadge Icon={Icon} tone={tone} size={32} />
                  <View style={{ flex: 1 }}>
                    <T v="body" numberOfLines={1} style={{ fontWeight: item.dir ? '600' : '500', fontSize: 15 }}>
                      {item.label}
                    </T>
                    {item.sub ? (
                      <T v="caption" numberOfLines={1}>
                        {item.sub}
                      </T>
                    ) : null}
                  </View>
                  {item.dir ? <ChevronRight color={color.text3} size={18} /> : null}
                </Press>
              </View>
            );
          }}
          ListFooterComponent={
            folder?.more && !found ? (
              <T v="caption" style={{ textAlign: 'center', marginTop: 12 }}>
                The first 2,000 are shown. Search to find the rest.
              </T>
            ) : undefined
          }
        />
      )}
    </Screen>
  );
}
