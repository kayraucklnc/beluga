import { useLocalSearchParams } from 'expo-router';
import { Monitor, RefreshCw } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Chips, COMPARES, type CompareKey, compareOf, Tiles } from '../../components/Dashboard';
import { Options } from '../../components/Options';
import { Segments } from '../../components/Segments';
import { Header, Screen, useScrolled } from '../../components/Screen';
import { More, T } from '../../components/ui';
import { useSupports, useView } from '../../lib/hooks';
import { calls } from '../../lib/link/calls';
import type { DashboardView, Topic } from '../../lib/link/protocol';
import { openOnMac } from '../../lib/mac';
import { store } from '../../lib/store';
import { color } from '../../lib/theme';

/**
 * A dashboard (BLG-244, docs/sentinel.md §10): the tiles your Mac works out from what your
 * sentinels keep, in two columns. Your dashboards are a row at the top when there are several; the
 * compare chips pick which change every number shows (a tile pinned to its own keeps it, and says
 * so). Pull to refresh runs every sentinel it draws from on the Mac, one at a time ("Fetching…
 * 2 of 3"). Arranging tiles stays on the Mac.
 */
export default function DashboardPage() {
  const { scrolled, onScroll } = useScrolled();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [current, setCurrent] = useState(decodeURIComponent(id ?? ''));
  useEffect(() => setCurrent(decodeURIComponent(id ?? '')), [id]);
  const topic = `dashboard:${current}` as Topic;
  const on = useSupports('dashboard');
  const view = useView<DashboardView>(on && current ? topic : undefined);
  const d = view?.data;
  const [compare, setCompare] = useState<CompareKey | undefined>();
  const [pulling, setPulling] = useState(false);
  const [menu, setMenu] = useState(false);
  const shown = compare ?? compareOf(d?.compare);
  const refreshing = d?.refreshing;

  const refresh = async () => {
    if (!d || pulling) return;
    setPulling(true);
    await store.call(calls.dashboardRefresh(d.id, d.name), { queue: false }).then(
      () => {},
      (e: Error) => store.toast({ text: e.message, tone: 'error' }),
    );
    setPulling(false);
  };
  const pick = (next: string) => {
    if (next === current) return;
    setCurrent(next);
    setCompare(undefined);
  };
  const tabs = d?.dashboards ?? [];

  return (
    <Screen>
      <Header scrolled={scrolled} back eyebrow="Dashboard" title={d?.name ?? 'Dashboard'} at={view?.at} right={d ? <More onPress={() => setMenu(true)} label="Dashboard options" /> : undefined} />
      {refreshing ? (
        <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(180)} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 20, paddingBottom: 6 }}>
          <ActivityIndicator size="small" color={color.text3} />
          <T v="caption" numberOfLines={1} style={{ flex: 1 }}>
            Fetching… {Math.min(refreshing.done + 1, refreshing.total)} of {refreshing.total}
            {refreshing.sentinel ? ` · ${refreshing.sentinel}` : ''}
          </T>
        </Animated.View>
      ) : null}
      <ScrollView
        onScroll={onScroll}
        scrollEventThrottle={32}
        contentContainerStyle={{ paddingTop: 6, paddingBottom: insets.bottom + 40, gap: 14 }}
        refreshControl={d ? <RefreshControl refreshing={pulling} onRefresh={() => void refresh()} tintColor={color.text3} colors={[color.info]} progressBackgroundColor={color.card} /> : undefined}
      >
        {!on ? (
          <T v="callout" style={{ textAlign: 'center', marginTop: 40, paddingHorizontal: 24 }}>
            Update Beluga on your Mac to see your dashboards here.
          </T>
        ) : !d ? (
          <T v="callout" style={{ textAlign: 'center', marginTop: 40, paddingHorizontal: 24 }}>
            {view === undefined ? 'Opening the dashboard…' : 'This dashboard is gone.'}
          </T>
        ) : (
          <Animated.View entering={FadeIn.duration(220)} style={{ gap: 14 }}>
            {tabs.length > 1 ? (
              tabs.length <= 3 ? (
                <View style={{ paddingHorizontal: 16 }}>
                  <Segments value={d.id} options={tabs.map((x) => ({ key: x.id, label: x.name }))} onChange={pick} />
                </View>
              ) : (
                <Chips value={d.id} options={tabs.map((x) => ({ key: x.id, label: x.name }))} onChange={pick} />
              )
            ) : null}
            <Chips value={shown} options={COMPARES.map((c) => ({ key: c.key, label: c.label }))} onChange={setCompare} />
            {d.tiles.length ? (
              <Tiles tiles={d.tiles} compare={shown} />
            ) : (
              <T v="callout" style={{ textAlign: 'center', marginTop: 24, paddingHorizontal: 24 }}>
                No tiles yet. Add them on the Dashboard page on your Mac.
              </T>
            )}
            <T v="caption" c={color.text3} style={{ textAlign: 'center', paddingHorizontal: 24, marginTop: 6 }}>
              Pull down to fetch every number again.
            </T>
          </Animated.View>
        )}
      </ScrollView>
      <Options
        visible={menu}
        onClose={() => setMenu(false)}
        title={d?.name}
        options={[
          { Icon: RefreshCw, label: 'Refresh', sub: 'Run every sentinel it draws from (or pull down)', tone: 'sky', hidden: Boolean(refreshing), onPress: () => void refresh() },
          { Icon: Monitor, label: 'Open on your Mac', sub: 'Arrange its tiles, add numbers', tone: 'plain', onPress: () => void openOnMac({ topic }) },
        ]}
      />
    </Screen>
  );
}
