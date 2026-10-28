import { router, Stack, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import * as NavigationBar from 'expo-navigation-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { LucideProvider } from 'lucide-react-native';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Toasts } from '../components/Screen';
import { useScheme } from '../lib/appearance';
import { startSaved } from '../lib/saved';
import { store } from '../lib/store';
import { startWidgets } from '../lib/widgets';
// Loaded at once: sends that waited while your Mac was away go when it answers, whatever is on screen.
import '../lib/sends';
import { allowTurning } from '../lib/fullscreen';
import { color, stroke } from '../lib/theme';

/** The app: one store (lib/store.ts), a stack of screens over the tabs, toasts on top. */
export default function Root() {
  const scheme = useScheme();
  useEffect(() => {
    // The cache holds nothing a new launch uses; saved files are checked when the link opens.
    startSaved();
    // The Home-screen widgets (Android) get your boards' tiles once the store knows its Mac.
    void store.boot().then(startWidgets);
    // Upright everywhere; only data full screen turns (lib/fullscreen.ts).
    allowTurning(false);
    // A notification from Stay connected (lib/stay.ts) opens what it's about.
    if (Platform.OS === 'web') return;
    const open = (topic: unknown): void => {
      if (typeof topic !== 'string') return;
      if (topic.startsWith('conv:')) router.push(`/conv/${encodeURIComponent(topic.slice(5))}`);
      else if (topic.startsWith('chat:')) router.push(`/chat/${encodeURIComponent(topic.slice(5))}`);
      else if (topic.startsWith('sentinel:')) router.push(`/sentinel/${encodeURIComponent(topic.slice(9))}`);
      else if (topic.startsWith('dashboard:')) router.push(`/dashboard/${encodeURIComponent(topic.slice(10))}`);
    };
    const sub = Notifications.addNotificationResponseReceivedListener((r) => open(r.notification.request.content.data?.topic));
    return () => sub.remove();
  }, []);
  // A new theme remounts the screens (every color is read afresh); come back to where you were.
  const pathname = usePathname();
  const where = useRef({ path: pathname, scheme });
  useEffect(() => {
    const was = where.current;
    if (was.scheme !== scheme && was.path && was.path !== '/') setTimeout(() => router.push(was.path as never), 0);
    where.current = { path: pathname, scheme };
  }, [scheme]);
  useEffect(() => {
    where.current.path = pathname;
  }, [pathname]);
  // The window behind the app and Android's navigation bar follow the theme too.
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(color.bg).catch(() => {});
    if (Platform.OS === 'android') NavigationBar.setStyle(scheme === 'dark' ? 'dark' : 'light');
  }, [scheme]);
  return (
    <GestureHandlerRootView key={scheme} style={{ flex: 1, backgroundColor: color.bg }}>
      <SafeAreaProvider>
        {/* Every icon one line weight (lib/theme.ts `stroke`) unless it says otherwise. */}
        <LucideProvider strokeWidth={stroke}>
        <KeyboardProvider>
        <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
        {/* A new theme fades in over the old background: no flash. */}
        <Animated.View entering={FadeIn.duration(240)} style={{ flex: 1, ...(Platform.OS === 'web' ? { maxWidth: 520, width: '100%', alignSelf: 'center' } : {}) }}>
          <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.bg }, animation: 'slide_from_right', gestureEnabled: true }}>
            <Stack.Screen name="index" options={{ animation: 'none' }} />
            <Stack.Screen name="pair" options={{ animation: 'fade' }} />
            <Stack.Screen name="(tabs)" options={{ animation: 'fade' }} />
            <Stack.Screen name="ask" options={{ presentation: 'transparentModal', animation: 'none', contentStyle: { backgroundColor: 'transparent' } }} />
            <Stack.Screen name="viewer" options={{ presentation: 'transparentModal', animation: 'none', contentStyle: { backgroundColor: 'transparent' } }} />
            <Stack.Screen name="need/[id]" options={{ presentation: 'transparentModal', animation: 'none', contentStyle: { backgroundColor: 'transparent' } }} />
            <Stack.Screen name="reader" options={{ animation: 'slide_from_bottom' }} />
            <Stack.Screen name="data" options={{ animation: 'fade_from_bottom' }} />
          </Stack>
          <Toasts />
        </Animated.View>
        </KeyboardProvider>
        </LucideProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
