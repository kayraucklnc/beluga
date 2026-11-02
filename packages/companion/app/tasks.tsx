import { ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Header, Screen, useScrolled } from '../components/Screen';
import { TasksList } from '../components/Tasks';

/** All tasks (also Work › Tasks), opened from Home when something waits for your review. */
export default function Tasks() {
  const { scrolled, onScroll } = useScrolled();
  const insets = useSafeAreaInsets();
  return (
    <Screen>
      <Header scrolled={scrolled} back title="Tasks" />
      <ScrollView onScroll={onScroll} scrollEventThrottle={32} contentContainerStyle={{ paddingTop: 8, paddingBottom: insets.bottom + 40 }}>
        <TasksList />
      </ScrollView>
    </Screen>
  );
}
