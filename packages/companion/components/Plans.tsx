import { router } from 'expo-router';
import { ChevronRight, Workflow } from 'lucide-react-native';
import { View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useView } from '../lib/hooks';
import type { PlansView } from '../lib/link/protocol';
import { color } from '../lib/theme';
import { Card, IconBadge, Press, T, toneInk, toneOf } from './ui';

const STATE: Record<string, string> = { running: 'Running', done: 'Done', draft: 'Draft', waiting: 'Waiting', todo: 'To do' };

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
          <Animated.View key={p.id} entering={FadeInDown.delay(i * 50).duration(300)}>
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
