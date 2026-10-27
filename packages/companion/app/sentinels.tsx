import { useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Header, Screen, useScrolled } from '../components/Screen';
import { SENTINEL_SEEN, SentinelsList } from '../components/Sentinels';
import { kv } from '../lib/kv';

/** Sentinel (BLG-237): your watchers, opened from Home's Sentinel row. */
export default function Sentinels() {
  const { scrolled, onScroll } = useScrolled();
  const insets = useSafeAreaInsets();
  useFocusEffect(
    useCallback(() => {
      kv.set(SENTINEL_SEEN, Date.now());
    }, []),
  );
  return (
    <Screen>
      <Header scrolled={scrolled} back title="Sentinel" />
      <ScrollView onScroll={onScroll} scrollEventThrottle={32} contentContainerStyle={{ paddingTop: 8, paddingBottom: insets.bottom + 40 }}>
        <SentinelsList />
      </ScrollView>
    </Screen>
  );
}
