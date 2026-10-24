import { router, useLocalSearchParams } from 'expo-router';
import { Check, ChevronRight, Monitor, User } from 'lucide-react-native';
import { Options } from '../../components/Options';
import { openOnMac } from '../../lib/mac';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import Animated, { FadeInDown, LinearTransition } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { convHref } from '../../components/Conv';
import { NeedFace } from '../../components/Needs';
import { Header, Screen, useScrolled } from '../../components/Screen';
import { Card, More, Pill, Press, T, toneBg, toneInk, toneOf } from '../../components/ui';
import { useView, useVisibleNeeds } from '../../lib/hooks';
import type { PlanView, Topic } from '../../lib/link/protocol';
import { color } from '../../lib/theme';

/**
 * A plan as it's designed and run: its goal, decisions waiting on you (as cards), and the
 * milestones as a vertical timeline with their tasks. You decide and approve here; the plan's
 * shape is edited on the Mac.
 */
export default function Plan() {
  const { scrolled, onScroll } = useScrolled();
  const { id } = useLocalSearchParams<{ id: string }>();
  const topic = `plan:${id}` as Topic;
  const view = useView<PlanView>(topic);
  const p = view?.data;
  const needs = useVisibleNeeds(p?.needsYou);
  const insets = useSafeAreaInsets();
  const tasks = p?.milestones.flatMap((m) => m.tasks) ?? [];
  const done = tasks.filter((t) => t.state === 'done').length;
  const [menu, setMenu] = useState(false);

  return (
    <Screen>
      <Header scrolled={scrolled} back eyebrow="Plan" title={p?.title ?? 'Plan'} at={view?.at} right={
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {p ? <Pill label={p.state === 'running' ? 'Running' : p.state} tone={toneOf(p.state)} /> : null}
            <More onPress={() => setMenu(true)} label="Plan options" />
          </View>
        } />
      <Options visible={menu} onClose={() => setMenu(false)} title={p?.title} options={[{ Icon: Monitor, label: 'Open on your Mac', sub: 'Its graph, outline and conversation', tone: 'plain', onPress: () => void openOnMac({ topic }) }]} />
      <ScrollView onScroll={onScroll} scrollEventThrottle={32} contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}>
        {p ? (
          <>
            <View style={{ paddingHorizontal: 20, paddingTop: 6, gap: 12 }}>
              {p.goal ? <T v="callout" style={{ fontSize: 15, lineHeight: 21 }}>{p.goal}</T> : null}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <View style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: color.sunken, overflow: 'hidden' }}>
                  <View style={{ width: `${tasks.length ? (done / tasks.length) * 100 : 0}%`, height: 6, borderRadius: 3, backgroundColor: color.ok, opacity: 0.5 }} />
                </View>
                <T v="caption" c={color.text2}>
                  {done} of {tasks.length} tasks
                </T>
              </View>
              {p.topic ? (
                <Press onPress={() => router.push(convHref(p.topic!))} style={{ alignSelf: 'flex-start' }}>
                  <T v="callout" c={color.info} style={{ fontWeight: '600' }}>
                    Open conversation
                  </T>
                </Press>
              ) : null}
            </View>

            {needs.length ? (
              <View style={{ marginTop: 20, gap: 10 }}>
                <T v="eyebrow" style={{ paddingHorizontal: 20 }}>
                  Waiting on you
                </T>
                {needs.map((n) => (
                  <Animated.View key={n.id} entering={FadeInDown.springify()} layout={LinearTransition.springify()}>
                    <Card style={{ marginHorizontal: 16, padding: 16 }}>
                      <NeedFace item={n} more  />
                    </Card>
                  </Animated.View>
                ))}
              </View>
            ) : null}

            <View style={{ marginTop: 26, paddingHorizontal: 16 }}>
              <T v="eyebrow" style={{ paddingHorizontal: 4, marginBottom: 14 }}>
                Milestones
              </T>
              {p.milestones.map((m, i) => (
                <Milestone key={m.id} m={m} last={i === p.milestones.length - 1} i={i} />
              ))}
            </View>
          </>
        ) : (
          <T v="callout" style={{ padding: 20 }}>
            Opening the plan…
          </T>
        )}
      </ScrollView>
    </Screen>
  );
}

function Milestone({ m, last, i }: { m: PlanView['milestones'][number]; last: boolean; i: number }) {
  const [open, setOpen] = useState(m.state === 'running' || m.state === 'waiting');
  const tone = toneOf(m.state);
  const running = m.state === 'running';
  const done = m.state === 'done';
  const n = m.tasks.filter((t) => t.state === 'done').length;
  return (
    <Animated.View entering={FadeInDown.delay(i * 70).springify()} style={{ flexDirection: 'row', gap: 14 }}>
      <View style={{ width: 26, alignItems: 'center' }}>
        <View style={{ width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: toneBg(tone) }}>
          {done ? <Check color={toneInk(tone)} size={15} strokeWidth={3} /> : <T v="caption" c={toneInk(tone)} style={{ fontWeight: '800' }}>{i + 1}</T>}
        </View>
        {!last ? <View style={{ width: 2, flex: 1, marginVertical: 4, borderRadius: 1, backgroundColor: done ? toneBg('mint') : color.hairlineStrong }} /> : null}
      </View>
      <View style={{ flex: 1, paddingBottom: last ? 0 : 18 }}>
        <Press scaleTo={0.985} onPress={() => setOpen((o) => !o)} haptics>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 26 }}>
            <T v="heading" style={{ flex: 1, color: done ? color.text2 : color.text }}>
              {m.title}
            </T>
            <T v="caption">
              {n}/{m.tasks.length}
            </T>
          </View>
          <T v="caption" c={toneInk(tone)} style={{ fontWeight: "600", marginTop: 2, textTransform: "capitalize" }}>
            {m.state}
          </T>
        </Press>
        {open ? (
          <Animated.View entering={FadeInDown.springify()} style={{ marginTop: 10, gap: 8 }}>
            {m.criteria.length ? (
              <View style={{ gap: 3, marginBottom: 2 }}>
                {m.criteria.map((c) => (
                  <T key={c} v="caption" c={color.text2}>
                    ◦ {c}
                  </T>
                ))}
              </View>
            ) : null}
            <Card r={16}>
              {m.tasks.map((t, ti) => {
                const tt = toneOf(t.state);
                const row = (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11, paddingHorizontal: 12, borderTopWidth: ti ? 0.5 : 0, borderTopColor: color.hairline }}>
                    <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: tt === 'plain' ? color.hairlineStrong : toneInk(tt) }} />
                    <T v="callout" c={t.state === 'done' ? color.text2 : color.text} numberOfLines={2} style={{ flex: 1 }}>
                      {t.title}
                    </T>
                    {t.mine ? <User color={color.info} size={13} /> : null}
                    <T v="caption" c={toneInk(tt)} style={{ fontWeight: "600" }}>
                      {t.state}
                    </T>
                    {t.topic ? <ChevronRight color={color.text3} size={15} /> : null}
                  </View>
                );
                return t.topic ? (
                  <Press key={t.id} scaleTo={0.98} onPress={() => router.push(convHref(t.topic!))}>
                    {row}
                  </Press>
                ) : (
                  <View key={t.id}>{row}</View>
                );
              })}
            </Card>
          </Animated.View>
        ) : null}
      </View>
    </Animated.View>
  );
}
