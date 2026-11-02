import { router, useLocalSearchParams } from 'expo-router';
import { ArrowDownToLine, ChevronDown, ChevronUp, Search, WrapText, X } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Platform, ScrollView, Text, TextInput, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Prose } from '../components/Conv';
import { sizeOf } from '../components/Outputs';
import { Header, Screen, useScrolled } from '../components/Screen';
import { Card, haptic, Press, T } from '../components/ui';
import { useFile, useOutput } from '../lib/hooks';
import { store } from '../lib/store';
import { color, tint, type } from '../lib/theme';

/**
 * Text an agent wrote or a test produced (logs, txt, json, md, csv): never blocked. Search with
 * next and previous, wrap or not, and "follow" for a log that's still being written: as the Mac
 * reports it grew (in the view, no polling), the next piece is fetched and the end kept in view.
 */
export default function Reader() {
  const { scrolled, onScroll } = useScrolled();
  const { ref, name } = useLocalSearchParams<{ ref: string; name?: string }>();
  const insets = useSafeAreaInsets();
  const file = useFile(ref, 'text');
  const latest = useOutput(ref);
  const isLog = /\.(log|out)$/i.test(name ?? '') || latest?.name.endsWith('.log');
  const [wrap, setWrap] = useState(!isLog);
  const [follow, setFollow] = useState(!!isLog);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [hit, setHit] = useState(0);
  const [formatted, setFormatted] = useState(true);
  const list = useRef<FlatList<string>>(null);

  const isMd = latest?.kind === 'markdown' || /\.md$/i.test(name ?? '');
  const isJson = latest?.kind === 'json' || /\.json$/i.test(name ?? '');
  const text = useMemo(() => {
    const t = file?.text ?? '';
    if (isJson && formatted) {
      try {
        return JSON.stringify(JSON.parse(t), null, 2);
      } catch {
        return t;
      }
    }
    return t;
  }, [file?.text, isJson, formatted]);
  const lines = useMemo(() => text.replace(/\n$/, '').split('\n'), [text]);
  const hits = useMemo(() => {
    if (!query) return [] as number[];
    const q = query.toLowerCase();
    return lines.flatMap((l, i) => (l.toLowerCase().includes(q) ? [i] : []));
  }, [lines, query]);

  // The log grew on the Mac (its size in the view): fetch the next piece while following.
  const size = latest?.size ?? file?.size ?? 0;
  const got = file?.got ?? 0;
  const more = size > got;
  useEffect(() => {
    if (follow && more && file?.status === 'ready' && ref) store.fetch(ref, 'text', true);
  }, [follow, more, file?.status, size]);
  useEffect(() => {
    if (follow && lines.length) setTimeout(() => list.current?.scrollToEnd({ animated: true }), 30);
  }, [lines.length, follow]);

  const jump = (dir: 1 | -1) => {
    if (!hits.length) return;
    const next = (hit + dir + hits.length) % hits.length;
    setHit(next);
    setFollow(false);
    haptic.tap();
    list.current?.scrollToIndex({ index: hits[next]!, viewPosition: 0.35, animated: true });
  };

  const tool = (on: boolean, Icon: typeof Search, label: string, press: () => void) => (
    <Press onPress={press} accessibilityLabel={label} style={{ height: 34, paddingHorizontal: 12, borderRadius: 17, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: on ? tint.sky : color.card }}>
      <Icon color={on ? color.info : color.text2} size={15} />
      <T v="caption" c={on ? color.info : color.text2} style={{ fontWeight: '600' }}>
        {label}
      </T>
    </Press>
  );

  const renderLine = ({ item, index }: { item: string; index: number }) => {
    const isHit = query && hits[hit] === index;
    let body: React.ReactNode = item || ' ';
    if (query && item.toLowerCase().includes(query.toLowerCase())) {
      const parts: React.ReactNode[] = [];
      const q = query.toLowerCase();
      let at = 0;
      let k = 0;
      for (let i = item.toLowerCase().indexOf(q); i >= 0; i = item.toLowerCase().indexOf(q, i + q.length)) {
        parts.push(item.slice(at, i));
        parts.push(
          <Text key={k++} style={{ backgroundColor: isHit ? tint.peach : tint.butter, color: isHit ? color.claude : color.warn }}>
            {item.slice(i, i + q.length)}
          </Text>,
        );
        at = i + q.length;
      }
      parts.push(item.slice(at));
      body = parts;
    }
    const fail = /✘|FAIL|Error|error:/.test(item);
    const pass = /^\s*✓/.test(item);
    return (
      <View style={{ flexDirection: 'row', paddingHorizontal: 12, backgroundColor: isHit ? tint.peach : undefined }}>
        <Text style={[type.mono, { width: 38, color: color.text3, fontSize: 11, textAlign: 'right', marginRight: 10, opacity: 0.7 }]}>{index + 1}</Text>
        <Text style={[type.mono, { color: fail ? color.error : pass ? color.text2 : color.text, flexShrink: wrap ? 1 : 0 }]} numberOfLines={wrap ? undefined : 1}>
          {body}
        </Text>
      </View>
    );
  };

  const reader =
    isMd && formatted ? (
      <ScrollView onScroll={onScroll} scrollEventThrottle={32} contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 40 }}>
        <Prose prose={{ text: text.replace(/^\|.*\|$/gm, (row) => (/^\|[-| ]+\|$/.test(row) ? '' : row.split('|').filter(Boolean).map((c) => c.trim()).join('  ·  '))), code: [] }} size={15} />
      </ScrollView>
    ) : (
      <FlatList
        ref={list}
        data={lines}
        keyExtractor={(_, i) => String(i)}
        renderItem={renderLine}
        initialNumToRender={60}
        getItemLayout={wrap ? undefined : (_, i) => ({ length: 18, offset: 12 + 18 * i, index: i })}
        windowSize={12}
        onScrollToIndexFailed={(e) => setTimeout(() => list.current?.scrollToIndex({ index: e.index, animated: false }), 60)}
        onScrollBeginDrag={() => follow && setFollow(false)}
        onScroll={onScroll}
        scrollEventThrottle={32}
        contentContainerStyle={{ paddingVertical: 12, paddingBottom: insets.bottom + 40, minWidth: wrap ? undefined : 1400 }}
        ListFooterComponent={
          more && !follow ? (
            <Press onPress={() => ref && store.fetch(ref, 'text', true)} style={{ alignSelf: 'center', marginTop: 14, height: 34, paddingHorizontal: 16, borderRadius: 17, justifyContent: 'center', backgroundColor: color.sunken }}>
              <T v="caption" c={color.text}>
                Load more · {sizeOf(size - got)} left
              </T>
            </Press>
          ) : undefined
        }
      />
    );

  return (
    <Screen>
      <Header scrolled={scrolled} back title={name ?? 'File'} eyebrow={`${isMd ? 'Markdown' : isJson ? 'JSON' : 'Text'} · ${sizeOf(size)}${more ? ` · ${sizeOf(got)} shown` : ''}`} />
      <Animated.View entering={FadeIn.duration(180)} style={{ paddingHorizontal: 16, paddingBottom: 10, gap: 10 }}>
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
              returnKeyType="search"
              onSubmitEditing={() => jump(1)}
              style={{ flex: 1, color: color.text, fontSize: 15, ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}) }}
            />
            <T v="caption" style={{ fontVariant: ['tabular-nums'] }}>
              {query ? `${hits.length ? hit + 1 : 0}/${hits.length}` : ''}
            </T>
            <Press onPress={() => jump(-1)} hitSlop={6}>
              <ChevronUp color={color.text2} size={20} />
            </Press>
            <Press onPress={() => jump(1)} hitSlop={6}>
              <ChevronDown color={color.text2} size={20} />
            </Press>
            <Press
              onPress={() => {
                setSearching(false);
                setQuery('');
              }}
              hitSlop={6}
            >
              <X color={color.text2} size={18} />
            </Press>
          </Card>
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
            {tool(false, Search, 'Find', () => setSearching(true))}
            {isMd || isJson ? tool(formatted, WrapText, isMd ? 'Formatted' : 'Pretty', () => setFormatted((f) => !f)) : null}
            {tool(wrap, WrapText, 'Wrap', () => setWrap((w) => !w))}
            {tool(follow, ArrowDownToLine, follow ? 'Following' : 'Follow', () => setFollow((f) => !f))}
          </ScrollView>
        )}
      </Animated.View>
      <View style={{ flex: 1, marginHorizontal: 10, borderRadius: 18, overflow: 'hidden', backgroundColor: color.card, borderWidth: 0.5, borderColor: color.hairline }}>
        {!file || (file.status === 'loading' && !file.text) ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator color={color.text2} />
          </View>
        ) : file.status === 'error' && !file.text ? (
          <Animated.View entering={FadeIn} style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30 }}>
            <T v="callout" style={{ textAlign: 'center' }}>
              {file.error ?? "Couldn't get it."}
            </T>
            <Press onPress={() => router.back()} style={{ marginTop: 12 }}>
              <T v="callout" c={color.info}>
                Back
              </T>
            </Press>
          </Animated.View>
        ) : wrap || (isMd && formatted) ? (
          reader
        ) : (
          <ScrollView horizontal bounces={false} contentContainerStyle={{ flexGrow: 1 }}>
            {reader}
          </ScrollView>
        )}
      </View>
    </Screen>
  );
}
