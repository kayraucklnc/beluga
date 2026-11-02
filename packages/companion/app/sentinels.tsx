import { useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DashboardRows, SentinelChatRow } from '../components/Dashboard';
import { Header, Screen, useScrolled } from '../components/Screen';
import { SENTINEL_SEEN, SentinelsList } from '../components/Sentinels';
import { kv } from '../lib/kv';

/**
 * Sentinel (BLG-237): your watchers, opened from Home's Sentinel row, with the section's other two
 * parts above them, as on the Mac (docs/sentinel.md §10): its dashboards (1.22) and its Chat (1.23).
 */
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
          <SentinelChatRow />
          <SentinelsList />
        </View>
      </ScrollView>
    </Screen>
  );
}
