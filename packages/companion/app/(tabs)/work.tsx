import { router } from 'expo-router';
import { Folder } from 'lucide-react-native';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AgentDots, convHref, statusIcon } from '../../components/Conv';
import { PlansList } from '../../components/Plans';
import { Header, Screen } from '../../components/Screen';
import { Segments } from '../../components/Segments';
import { Card, Row, T } from '../../components/ui';
import { ago, useView } from '../../lib/hooks';
import type { PlansView, WorkView } from '../../lib/link/protocol';
import { color, TAB_BAR_H } from '../../lib/theme';

/** Work: projects and their conversations; plans beside them. */
export default function Work() {
  const insets = useSafeAreaInsets();
  const work = useView<WorkView>('work');
  const plans = useView<PlansView>('plans');
  const [tab, setTab] = useState<'convs' | 'plans'>('convs');
  const runningPlans = plans?.data.plans.filter((p) => p.state === 'running').length ?? 0;

  return (
    <Screen>
      <Header title="Work" at={work?.at} />
      <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
        <Segments
          value={tab}
          onChange={setTab}
          options={[
            { key: 'convs', label: 'Conversations' },
            { key: 'plans', label: 'Plans', badge: runningPlans },
          ]}
        />
      </View>
      <ScrollView contentContainerStyle={{ paddingTop: 8, paddingBottom: TAB_BAR_H + insets.bottom + 40 }} showsVerticalScrollIndicator={false}>
        {tab === 'plans' ? (
          <Animated.View entering={FadeIn}>
            <PlansList />
          </Animated.View>
        ) : (
          <Animated.View entering={FadeIn} style={{ gap: 22 }}>
            {(work?.data.projects ?? []).filter((p) => p.conversations.length).map((p, pi) => (
              <Animated.View key={p.id} entering={FadeInDown.delay(pi * 60).duration(300)}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 22, marginBottom: 8 }}>
                  <Folder color={color.text3} size={14} />
                  <T v="eyebrow" style={{ flex: 1 }}>
                    {p.name}
                  </T>
                </View>
                <Card style={{ marginHorizontal: 16 }}>
                  {p.conversations.map((c, i) => {
                    const st = statusIcon(c.needsYou ? 'waiting' : c.status);
                    return (
                      <Row
                        key={c.topic}
                        first={i === 0}
                        Icon={st.Icon}
                        tone={st.tone}
                        label={c.title}
                        sub={[c.needsYou ? 'Needs you' : c.status === 'working' ? c.last : undefined, ago(c.lastAt)].filter(Boolean).join(' · ') || c.last}
                        right={c.agents ? <AgentDots count={c.agents} /> : c.unread ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color.info }} /> : null}
                        onPress={() => router.push(convHref(c.topic))}
                      />
                    );
                  })}
                </Card>
              </Animated.View>
            ))}
          </Animated.View>
        )}
      </ScrollView>
    </Screen>
  );
}
