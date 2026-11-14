import { useLocalSearchParams } from 'expo-router';
import { ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { HomePlans, PlansList } from '../components/Plans';
import type { Topic } from '../lib/link/protocol';
import { Header, Screen, useScrolled } from '../components/Screen';

/** All plans (also in Work › Plans), or one chat's plans (`?home=conv:…`, its plan band's earlier plans). */
export default function Plans() {
  const { scrolled, onScroll } = useScrolled();
  const { home } = useLocalSearchParams<{ home?: string }>();
  const insets = useSafeAreaInsets();
  return (
    <Screen>
      <Header scrolled={scrolled} back eyebrow={home ? 'This chat' : undefined} title="Plans" />
      <ScrollView onScroll={onScroll} scrollEventThrottle={32} contentContainerStyle={{ paddingTop: 8, paddingBottom: insets.bottom + 40 }}>
        {home?.startsWith('conv:') ? <HomePlans home={home as Topic} /> : <PlansList />}
      </ScrollView>
    </Screen>
  );
}
