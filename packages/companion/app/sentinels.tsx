import { useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DashboardRows } from '../components/Dashboard';
import { Header, Screen, useScrolled } from '../components/Screen';
import { SENTINEL_SEEN, SentinelsList } from '../components/Sentinels';
import { kv } from '../lib/kv';

/** Sentinel (BLG-237): your watchers, opened from Home's Sentinel row; your dashboards above them (1.22). */
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
        <View style={{ gap: 22 }}>
          <DashboardRows />
          <SentinelsList />
        </View>
      </ScrollView>
    </Screen>
  );
}
