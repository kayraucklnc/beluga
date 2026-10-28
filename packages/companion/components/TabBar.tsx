import { router } from 'expo-router';
import type { BottomTabBarProps } from 'expo-router/build/layouts/Tabs';
import { House, Layers, MessageCircle, Plus, Users } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useView, useVisibleNeeds } from '../lib/hooks';
import type { HomeView } from '../lib/link/protocol';
import { color } from '../lib/theme';
import { haptic, Press } from './ui';

/**
 * The tab bar, drawn by the app: Home · Work · [Ask] · Chats · People. A solid bar with a hairline
 * on top; the tab you're on is in full ink, the rest quiet; badges count what's waiting, in one
 * color. Ask sits in the middle, always there, in the primary ink.
 */
const ICONS = { index: House, work: Layers, chats: MessageCircle, people: Users } as const;
const LABELS = { index: 'Home', work: 'Work', chats: 'Chats', people: 'People' } as const;

export function TabBar({ state, navigateToTab, insets }: BottomTabBarProps) {
  const [width, setWidth] = useState(0);
  const home = useView<HomeView>('home');
  const needs = useVisibleNeeds(home?.data.needsYou);
  const badges: Record<string, number> = { index: needs.length, work: home?.data.unread.work ?? 0, chats: home?.data.unread.chats ?? 0, people: 0 };

  // Five slots: two tabs, Ask, two tabs.
  const slot = width / 5;

  const tab = (route: (typeof state.routes)[number], i: number) => {
    const name = route.name as keyof typeof ICONS;
    const Icon = ICONS[name] ?? House;
    const on = state.index === i;
    const badge = badges[name] ?? 0;
    return (
      <Press key={route.key} onPress={() => !on && navigateToTab(route.key)} accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={LABELS[name]} style={{ width: slot, height: 54, alignItems: 'center', justifyContent: 'center', gap: 3 }}>
        <View>
          <Icon color={on ? color.text : color.text3} size={22} strokeWidth={on ? 2 : 1.75} />
          {badge > 0 ? (
            <View style={{ position: 'absolute', top: -5, right: -11, minWidth: 18, height: 18, paddingHorizontal: 5, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: name === 'index' ? color.error : color.text, borderWidth: 2, borderColor: color.bar }}>
              {/* Solid in both themes: dark's tints are see-through, and a count over an icon must read at a glance. */}
              <Text style={{ color: color.bar, fontSize: 10, fontWeight: '800' }}>{badge > 9 ? '9+' : badge}</Text>
            </View>
          ) : null}
        </View>
        <Text style={{ fontSize: 11, fontWeight: on ? '600' : '500', color: on ? color.text : color.text3 }}>{LABELS[name]}</Text>
      </Press>
    );
  };

  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={{ position: 'absolute', left: 0, right: 0, bottom: 0, paddingBottom: Math.max(insets.bottom, 6), backgroundColor: color.bar, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.hairlineStrong }}>
      <View style={{ height: 58, flexDirection: 'row', alignItems: 'center' }}>
        {state.routes.slice(0, 2).map((r, i) => tab(r, i))}
        <View style={{ width: slot, alignItems: 'center' }}>
          <Press
            haptics={false}
            onPress={() => {
              haptic.commit();
              router.push('/ask');
            }}
            accessibilityLabel="Ask your Mac"
            style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: color.primary }}
          >
            <Plus color={color.onPrimary} size={22} strokeWidth={2} />
          </Press>
        </View>
        {state.routes.slice(2).map((r, i) => tab(r, i + 2))}
      </View>
    </View>
  );
}
