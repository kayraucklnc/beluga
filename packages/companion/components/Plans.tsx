import { router } from 'expo-router';
import { ChevronRight, Workflow } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import type { PhoneResult } from '../../../src/companion/calls';
import { useView } from '../lib/hooks';
import { calls } from '../lib/link/calls';
import type { PlansView, Topic } from '../lib/link/protocol';
import { store } from '../lib/store';
import { color } from '../lib/theme';
import { Card, IconBadge, Pill, Press, T, toneInk, toneOf } from './ui';

/** One plan of a chat (plans.ofHome, 1.57). */
type HomePlan = PhoneResult<'plans.ofHome'>[number];

const STATE: Record<string, string> = { running: 'Running', done: 'Done', draft: 'Draft', waiting: 'Waiting', todo: 'To do', closed: 'Closed', active: 'Running' };

/** The plans, as cards with their progress (Work › Plans, and /plans). */
export function PlansList() {
  const plans = useView<PlansView>('plans');
  const list = plans?.data.plans ?? [];
  if (!plans) return <T v="callout" style={{ paddingHorizontal: 20 }}>Loading plans…</T>;
  if (!list.length) {
    return (
      <Card style={{ marginHorizontal: 16, padding: 18 }}>
        <T v="heading">No plans yet</T>
        <T v="callout" style={{ marginTop: 4 }}>
          Plans are made on your Mac.
        </T>
      </Card>
    );
  }
  return (
    <View style={{ gap: 10 }}>
      {list.map((p, i) => {
        const tone = toneOf(p.state);
        const pct = p.total ? p.done / p.total : 0;
        return (
          <Animated.View key={p.id} entering={FadeIn.duration(180)}>
            <Press scaleTo={0.985} onPress={() => router.push(`/plan/${p.id}`)} style={{ marginHorizontal: 16 }}>
              <Card style={{ padding: 14, gap: 12 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <IconBadge Icon={Workflow} tone={tone === 'plain' ? 'butter' : tone} />
                  <View style={{ flex: 1 }}>
                    <T v="heading" numberOfLines={1}>
                      {p.title}
                    </T>
                    <T v="caption">
                      {STATE[p.state] ?? p.state} · {p.done} of {p.total}
                    </T>
                  </View>
                  <ChevronRight color={color.text3} size={18} />
                </View>
                <View style={{ height: 6, borderRadius: 3, backgroundColor: color.sunken, overflow: 'hidden' }}>
                  <View style={{ width: `${pct * 100}%`, height: 6, borderRadius: 3, backgroundColor: toneInk(tone === 'plain' ? 'mint' : tone), opacity: 0.5 }} />
                </View>
              </Card>
            </Press>
          </Animated.View>
        );
      })}
    </View>
  );
}

/**
 * A chat's plans, newest first (1.57, the chatPlans pref): its current one, then the earlier ones,
 * closed or done. Each opens read-only once closed (app/plan/[id].tsx).
 */
export function HomePlans({ home }: { readonly home: Topic }) {
  const [list, setList] = useState<readonly HomePlan[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    let live = true;
    store.call<HomePlan[]>(calls.plansOfHome(home), { queue: false }).then(
      (plans) => live && setList(plans ?? []),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [home]);
  if (error) return <T v="callout" style={{ paddingHorizontal: 20 }}>{error}</T>;
  if (!list) return <T v="callout" style={{ paddingHorizontal: 20 }}>Loading the chat’s plans…</T>;
  if (!list.length) return <T v="callout" style={{ paddingHorizontal: 20 }}>This chat has no plans yet.</T>;
  return (
    <View style={{ gap: 10 }}>
      {list.map((p) => {
        const state = p.closedAt ? 'closed' : p.status;
        const when = new Date(p.closedAt ?? p.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
        return (
          <Animated.View key={p.id} entering={FadeIn.duration(180)}>
            <Press scaleTo={0.985} onPress={() => router.push(`/plan/${p.id}`)} style={{ marginHorizontal: 16 }} accessibilityLabel={`Open the plan ${p.title}`}>
              <Card style={{ padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <IconBadge Icon={Workflow} tone={p.current ? 'lavender' : 'plain'} />
                <View style={{ flex: 1 }}>
                  <T v="heading" numberOfLines={1} c={p.current ? color.text : color.text2}>
                    {p.title}
                  </T>
                  <T v="caption">{p.current ? `Current · since ${when}` : `${STATE[state] ?? state} ${when}`}</T>
                </View>
                <Pill label={p.current ? 'Current' : (STATE[state] ?? state)} tone={p.current ? 'lavender' : toneOf(state)} />
                <ChevronRight color={color.text3} size={18} />
              </Card>
            </Press>
          </Animated.View>
        );
      })}
    </View>
  );
}
