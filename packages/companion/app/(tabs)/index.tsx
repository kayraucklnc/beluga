import { router } from 'expo-router';
import { ChevronRight, Settings, Workflow } from 'lucide-react-native';
import { ScrollView, View } from 'react-native';
import Animated, { FadeInDown, LinearTransition } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ConvCard } from '../../components/Conv';
import { Mark } from '../../components/Mark';
import { NeedsStack } from '../../components/Needs';
import { OutputStrip } from '../../components/Outputs';
import { AwayBand, Screen } from '../../components/Screen';
import { UsageCard } from '../../components/Usage';
import { Card, IconBadge, Pill, Press, Section, T } from '../../components/ui';
import { useLink, useView, useVisibleNeeds } from '../../lib/hooks';
import type { HomeView, PlansView } from '../../lib/link/protocol';
import { color, TAB_BAR_H } from '../../lib/theme';

/**
 * Home: your Mac and its state at the top, then what needs you (a stack of cards), what's running,
 * the newest outputs, and your allowance.
 */
export default function Home() {
  const insets = useSafeAreaInsets();
  const link = useLink();
  const home = useView<HomeView>('home');
  const plans = useView<PlansView>('plans');
  const h = home?.data;
  const needs = useVisibleNeeds(h?.needsYou);
  const running = plans?.data.plans.filter((p) => p.state === 'running') ?? [];
  const linked = link.phase === 'open';
  const asleep = link.phase === 'asleep';
  const hour = new Date().getHours();
  const greeting = hour < 5 ? 'Hi' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 12, paddingBottom: TAB_BAR_H + insets.bottom + 40 }} showsVerticalScrollIndicator={false}>
        <View style={{ paddingHorizontal: 20 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Mark size={40} intro={false} />
            <View style={{ flex: 1 }}>
              <T v="heading" numberOfLines={1}>
                {h?.mac.name ?? link.mac?.name ?? link.pairing?.macName ?? 'Your Mac'}
              </T>
            </View>
            <Pill label={linked ? 'Linked' : asleep ? 'Asleep' : link.phase === 'dialing' ? 'Linking' : 'Away'} tone={linked ? 'mint' : asleep ? 'sky' : 'plain'} />
            <Press onPress={() => router.push('/settings')} accessibilityLabel="Settings" hitSlop={8} style={{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: color.card }}>
              <Settings color={color.text2} size={19} />
            </Press>
          </View>
          <Animated.View entering={FadeInDown.delay(80).duration(400)} style={{ marginTop: 24 }}>
            <T v="hero">
              {greeting}
              {h?.me.name ? `, ${h.me.name}` : ''}
            </T>
            <T v="callout" style={{ marginTop: 4 }}>
              {needs.length ? `${needs.length} ${needs.length === 1 ? 'thing needs' : 'things need'} you` : 'Nothing needs you'}
              {h?.running.length ? ` · ${h.running.filter((r) => r.status === 'working').length} working` : ''}
            </T>
          </Animated.View>
          <AwayBand at={home?.at} />
        </View>

        {!h ? (
          <Card style={{ margin: 16, marginTop: 28, padding: 20 }}>
            <T v="heading">Reaching your Mac…</T>
            <T v="callout" style={{ marginTop: 4 }}>
              What it shows will appear here.
            </T>
          </Card>
        ) : (
          <>
            <Section
              title="Needs you"
              right={
                needs.length > 1 ? (
                  <Press onPress={() => router.push('/needs')} hitSlop={10}>
                    <T v="callout" c={color.info} style={{ fontWeight: '600' }}>
                      All {needs.length}
                    </T>
                  </Press>
                ) : null
              }
            >
              <NeedsStack items={needs} />
            </Section>

            {h.running.length || running.length ? (
              <Section title="Running">
                <Animated.View layout={LinearTransition.springify()} style={{ gap: 10 }}>
                  {running.map((p) => (
                    <Press key={p.id} scaleTo={0.985} onPress={() => router.push(`/plan/${p.id}`)} style={{ marginHorizontal: 16 }}>
                      <Card style={{ padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                        <IconBadge Icon={Workflow} tone="butter" />
                        <View style={{ flex: 1 }}>
                          <T v="heading" numberOfLines={1}>
                            {p.title}
                          </T>
                          <T v="caption">
                            Plan · {p.done} of {p.total} done
                          </T>
                        </View>
                        <ChevronRight color={color.text3} size={18} />
                      </Card>
                    </Press>
                  ))}
                  {h.running.map((c) => (
                    <ConvCard key={c.topic} c={c} />
                  ))}
                </Animated.View>
              </Section>
            ) : null}

            {h.outputs.length ? (
              <Section title="Outputs">
                <OutputStrip items={h.outputs} />
              </Section>
            ) : null}

            {h.usage.length ? (
              <Section title="Usage">
                <UsageCard usage={h.usage} />
              </Section>
            ) : null}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}
