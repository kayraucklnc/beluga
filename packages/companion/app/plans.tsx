import { ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PlansList } from '../components/Plans';
import { Header, Screen } from '../components/Screen';

/** All plans (also in Work › Plans). */
export default function Plans() {
  const insets = useSafeAreaInsets();
  return (
    <Screen>
      <Header back title="Plans" />
      <ScrollView contentContainerStyle={{ paddingTop: 8, paddingBottom: insets.bottom + 40 }}>
        <PlansList />
      </ScrollView>
    </Screen>
  );
}
