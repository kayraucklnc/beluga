import { router, useLocalSearchParams } from 'expo-router';
import { ChevronDown, ChevronUp, Lock, Search, WrapText, X } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Platform, ScrollView, Text, TextInput, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { sizeOf } from '../components/Outputs';
import { Header, Screen, useScrolled } from '../components/Screen';
import { Card, haptic, IconBadge, Press, T } from '../components/ui';
import { blockStates, LANG_NAMES, type TokenKind, tokenize } from '../lib/highlight';
import { useLink } from '../lib/hooks';
import { calls } from '../lib/link/calls';
import type { FilePageView, Topic } from '../lib/link/protocol';
import { store } from '../lib/store';
import { color, ink, tint, type } from '../lib/theme';
import { fileIcon } from '../components/fileIcon';

/**
 * A worktree's file, read-only (BLG-42): monospace with line numbers, colours by language, wrap
 * or not, and find with next and previous. A big file comes in 512 KB pages ("Load more"). There
 * is no way to edit: the phone only reads.
 */

const tokenColor = (k: TokenKind): string => (k === 'keyword' ? ink.lavender : k === 'string' ? ink.mint : k === 'number' ? ink.peach : k === 'type' ? ink.sky : k === 'comment' ? color.text3 : k === 'heading' ? ink.lavender : color.text);
const LINE_H = 18;

export default function Source() {
  const { scrolled, onScroll } = useScrolled();
  const { topic, path } = useLocalSearchParams<{ topic: string; path: string }>();
  const insets = useSafeAreaInsets();
  const linked = useLink().phase;
  const name = (path ?? '').split('/').pop() ?? 'File';
  const [page, setPage] = useState<FilePageView | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [hit, setHit] = useState(0);
  const list = useRef<FlatList<string>>(null);

  const load = (off = 0) => {
    if (!topic || !path) return;
    setBusy(true);
    if (!off) setError(undefined);
    store.call<FilePageView>(calls.filesRead(topic as Topic, path, off), { queue: false }).then(
      (p) => {
        setBusy(false);
        if (!p) return;
        setPage((was) => (off && was ? { ...p, text: was.text + p.text, off: was.off } : p));
      },
      (e: Error) => {
        setBusy(false);
        if (!off) setError(e.message);
        else store.toast({ text: e.message, tone: 'error' });
      },
    );
  };
  // Read once the link is open (a cold start dials first); the Mac away says so.
  useEffect(() => {
    if (linked === 'open' && !page) load(0);
    else if (linked === 'asleep' && !page) setError('Your Mac is away. The file comes back when it answers.');
  }, [topic, path, linked]);

  const lines = useMemo(() => (page?.text ?? '').replace(/\n$/, '').split('\n'), [page?.text]);
  const blocks = useMemo(() => blockStates(lines, page?.lang), [lines, page?.lang]);
  const hits = useMemo(() => {
    if (!query) return [] as number[];
    const q = query.toLowerCase();
    return lines.flatMap((l, i) => (l.toLowerCase().includes(q) ? [i] : []));
  }, [lines, query]);
  const gutter = Math.max(2, String(lines.length).length) * 7.5 + 8;

  const jump = (dir: 1 | -1) => {
    if (!hits.length) return;
    const next = (hit + dir + hits.length) % hits.length;
    setHit(next);
    haptic.tap();
    list.current?.scrollToIndex({ index: hits[next]!, viewPosition: 0.35, animated: true });
  };

  const renderLine = ({ item, index }: { item: string; index: number }) => {
    const isHit = Boolean(query) && hits[hit] === index;
    const q = query.toLowerCase();
    const tokens = tokenize(item, page?.lang, blocks[index]);
    const body = tokens.map((tk, k) => {
      if (!q || !tk.text.toLowerCase().includes(q)) {
        return (
          <Text key={k} style={{ color: tokenColor(tk.kind), fontStyle: tk.kind === 'comment' ? 'italic' : 'normal', fontWeight: tk.kind === 'heading' ? '700' : 'normal' }}>
            {tk.text}
          </Text>
        );
      }
      // The match, marked inside its token.
      const parts: React.ReactNode[] = [];
      let at = 0;
      let n = 0;
      const low = tk.text.toLowerCase();
      for (let i = low.indexOf(q); i >= 0; i = low.indexOf(q, i + q.length)) {
        parts.push(tk.text.slice(at, i));
        parts.push(
          <Text key={n++} style={{ backgroundColor: isHit ? tint.peach : tint.butter, color: isHit ? color.claude : color.warn }}>
            {tk.text.slice(i, i + q.length)}
          </Text>,
        );
        at = i + q.length;
      }
      parts.push(tk.text.slice(at));
      return (
        <Text key={k} style={{ color: tokenColor(tk.kind) }}>
          {parts}
        </Text>
      );
    });
    return (
      <View style={{ flexDirection: 'row', paddingRight: 12, backgroundColor: isHit ? tint.peach : undefined }}>
        <Text style={[type.mono, { width: gutter, color: color.text3, fontSize: 11, textAlign: 'right', marginRight: 10, opacity: 0.7 }]}>{index + 1}</Text>
        <Text style={[type.mono, { color: color.text, flexShrink: wrap ? 1 : 0 }, Platform.OS === 'web' ? ({ whiteSpace: wrap ? 'pre-wrap' : 'pre' } as object) : null]} numberOfLines={wrap ? undefined : 1}>
          {body.length ? body : ' '}
        </Text>
      </View>
    );
  };

  const tool = (on: boolean, Icon: typeof Search, label: string, press: () => void) => (
    <Press onPress={press} accessibilityLabel={label} style={{ height: 34, paddingHorizontal: 12, borderRadius: 17, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: on ? tint.sky : color.card }}>
      <Icon color={on ? color.info : color.text2} size={15} />
      <T v="caption" c={on ? color.info : color.text2} style={{ fontWeight: '600' }}>
        {label}
      </T>
    </Press>
  );

  const more = page && !page.eof;
  const { Icon, tone } = fileIcon(name, false);
  const viewer = (
    <FlatList
      ref={list}
      data={lines}
      keyExtractor={(_, i) => String(i)}
      renderItem={renderLine}
      initialNumToRender={60}
      getItemLayout={wrap ? undefined : (_, i) => ({ length: LINE_H, offset: 12 + LINE_H * i, index: i })}
      windowSize={12}
      onScrollToIndexFailed={(e) => setTimeout(() => list.current?.scrollToIndex({ index: e.index, animated: false }), 60)}
      onScroll={onScroll}
      scrollEventThrottle={32}
      contentContainerStyle={{ paddingVertical: 12, paddingBottom: insets.bottom + 40, minWidth: wrap ? undefined : 1400 }}
      ListFooterComponent={
        more ? (
          <Press onPress={() => !busy && load(page.next)} style={{ alignSelf: wrap ? 'center' : 'flex-start', marginLeft: wrap ? 0 : 16, marginTop: 14, height: 34, paddingHorizontal: 16, borderRadius: 17, justifyContent: 'center', backgroundColor: color.sunken }}>
            <T v="caption" c={color.text}>
              {busy ? 'Loading…' : `Load more · ${sizeOf(page.size - page.next)} left`}
            </T>
          </Press>
        ) : undefined
      }
    />
  );

  return (
    <Screen>
      <Header scrolled={scrolled} back title={name} lead={<IconBadge Icon={Icon} tone={tone} size={30} />} eyebrow={['Read only', page?.lang ? LANG_NAMES[page.lang] : undefined, page ? sizeOf(page.size) : undefined].filter(Boolean).join(' · ')} />
      <Animated.View entering={FadeIn.duration(180)} style={{ paddingHorizontal: 16, paddingBottom: 10 }}>
        {searching ? (
          <Card r={18} style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, height: 42, gap: 8 }}>
            <Search color={color.text2} size={16} />
            <TextInput
              autoFocus
              value={query}
              onChangeText={(q) => {
                setQuery(q);
                setHit(0);
              }}
              placeholder="Find in file"
              placeholderTextColor={color.text3}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              onSubmitEditing={() => jump(1)}
              style={{ flex: 1, color: color.text, fontSize: 15, ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}) }}
            />
            <T v="caption" style={{ fontVariant: ['tabular-nums'] }}>
              {query ? `${hits.length ? hit + 1 : 0}/${hits.length}` : ''}
            </T>
            <Press onPress={() => jump(-1)} hitSlop={6} accessibilityLabel="Previous">
              <ChevronUp color={color.text2} size={20} />
            </Press>
            <Press onPress={() => jump(1)} hitSlop={6} accessibilityLabel="Next">
              <ChevronDown color={color.text2} size={20} />
            </Press>
            <Press
              onPress={() => {
                setSearching(false);
                setQuery('');
              }}
              hitSlop={6}
              accessibilityLabel="Close find"
            >
              <X color={color.text2} size={18} />
            </Press>
          </Card>
        ) : (
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {tool(false, Search, 'Find', () => setSearching(true))}
            {tool(wrap, WrapText, 'Wrap', () => setWrap((w) => !w))}
          </View>
        )}
      </Animated.View>
      <View style={{ flex: 1, marginHorizontal: 10, borderRadius: 18, overflow: 'hidden', backgroundColor: color.card, borderWidth: 0.5, borderColor: color.hairline }}>
        {error ? (
          <Animated.View entering={FadeIn} style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30, gap: 12 }}>
            <IconBadge Icon={Lock} tone="rose" size={44} />
            <T v="callout" style={{ textAlign: 'center' }}>
              {error}
            </T>
            <Press onPress={() => router.back()}>
              <T v="callout" c={color.info}>
                Back
              </T>
            </Press>
          </Animated.View>
        ) : !page ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator color={color.text2} />
          </View>
        ) : page.binary ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30 }}>
            <T v="callout" style={{ textAlign: 'center' }}>
              This isn’t a text file, so it can’t be shown here. Open it on your Mac.
            </T>
          </View>
        ) : wrap ? (
          viewer
        ) : (
          <ScrollView horizontal bounces={false} contentContainerStyle={{ flexGrow: 1 }}>
            {viewer}
          </ScrollView>
        )}
      </View>
    </Screen>
  );
}
