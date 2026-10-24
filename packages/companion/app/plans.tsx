import { ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PlansList } from '../components/Plans';
import { Header, Screen, useScrolled } from '../components/Screen';

/** All plans (also in Work › Plans). */
export default function Plans() {
  const { scrolled, onScroll } = useScrolled();
  const insets = useSafeAreaInsets();
  return (
    <Screen>
      <Header scrolled={scrolled} back title="Plans" />
      <ScrollView onScroll={onScroll} scrollEventThrottle={32} contentContainerStyle={{ paddingTop: 8, paddingBottom: insets.bottom + 40 }}>
        <PlansList />
      </ScrollView>
    </Screen>
  );
}
