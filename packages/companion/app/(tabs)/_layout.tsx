import { Tabs } from 'expo-router';
import { TabBar } from '../../components/TabBar';
import { color } from '../../lib/theme';

/** Home · Work · [Ask] · Chats · People, with the bar drawn by the app (components/TabBar.tsx). */
export default function TabsLayout() {
  return (
    <Tabs tabBar={(props) => <TabBar {...props} />} screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: color.bg }, animation: 'shift' }}>
      <Tabs.Screen name="index" options={{ title: 'Home' }} />
      <Tabs.Screen name="work" options={{ title: 'Work' }} />
      <Tabs.Screen name="chats" options={{ title: 'Chats' }} />
      <Tabs.Screen name="people" options={{ title: 'People' }} />
    </Tabs>
  );
}
