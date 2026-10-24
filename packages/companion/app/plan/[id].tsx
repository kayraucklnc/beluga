import { router, useLocalSearchParams } from 'expo-router';
import { Check, ChevronDown, ChevronRight, Gauge, Hand, Monitor, Rocket, User } from 'lucide-react-native';
import { Options } from '../../components/Options';
import { openOnMac } from '../../lib/mac';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import Animated, { FadeInDown, LinearTransition } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { convHref } from '../../components/Conv';
import { answer, NeedButtons, NeedFace } from '../../components/Needs';
import { Header, Screen, useScrolled } from '../../components/Screen';
import { Card, More, Pill, Press, T, toneBg, toneInk, toneOf } from '../../components/ui';
import { useView, useVisibleNeeds } from '../../lib/hooks';
import type { PlanView, Topic } from '../../lib/link/protocol';
import { color } from '../../lib/theme';
import { calls } from '../../lib/link/calls';
import { store } from '../../lib/store';

/** How a plan runs (src/core/plans/model.ts AUTONOMY_INFO), as the Mac says it. */
const AUTONOMY = {
  step: { label: 'Step by Step', sub: 'You start each task', Icon: Hand },
  gated: { label: 'Check-ins', sub: 'Runs, then waits for you at each milestone', Icon: Gauge },
  autopilot: { label: 'Autopilot', sub: 'Runs to the end, stops only if something fails', Icon: Rocket },
} as const;
type Autonomy = keyof typeof AUTONOMY;

/**
 * A plan (Advanced Planning) as it's designed and run: its goal, decisions waiting on you (Approve
 * or Discard a draft, pass a milestone), how it runs (Step by Step, Check-ins, Autopilot), and the
 * milestones as a vertical timeline: their criteria, what each waits on, their tasks with what
 * they wait on and what done means, and which run side by side now. The plan's shape is edited on
 * the Mac (or by asking its Claude in its conversation).
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
  const [howOpen, setHowOpen] = useState(false);
  const how = p?.autonomy && p.autonomy in AUTONOMY ? AUTONOMY[p.autonomy as Autonomy] : undefined;
  const titles = new Map(tasks.map((t) => [t.id, t.title]));
  const milestoneTitles = new Map((p?.milestones ?? []).map((m) => [m.id, m.title]));
  const blocked = tasks.filter((t) => t.state === 'blocked').length;

  return (
    <Screen>
      <Header scrolled={scrolled} back eyebrow="Plan" title={p?.title ?? 'Plan'} at={view?.at} right={
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {p ? <Pill label={p.state === 'running' ? 'Running' : p.state} tone={toneOf(p.state)} /> : null}
            <More onPress={() => setMenu(true)} label="Plan options" />
          </View>
        } />
      <Options visible={menu} onClose={() => setMenu(false)} title={p?.title} options={[{ Icon: Monitor, label: 'Open on your Mac', sub: 'Its graph, outline and conversation', tone: 'plain', onPress: () => void openOnMac({ topic }) }]} />
      <Options
        visible={howOpen}
        onClose={() => setHowOpen(false)}
        title="How it runs"
        options={(Object.keys(AUTONOMY) as Autonomy[]).map((a) => ({
          Icon: AUTONOMY[a].Icon,
          label: AUTONOMY[a].label,
          sub: AUTONOMY[a].sub,
          tone: a === p?.autonomy ? ('lavender' as const) : ('plain' as const),
          onPress: () => void store.call(calls.setAutonomy(id ?? '', a, AUTONOMY[a].label)).catch((e: Error) => store.toast({ text: e.message, tone: 'error' })),
        }))}
      />
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
              {p.running || blocked ? (
                <T v="caption" c={color.text2}>
                  {[p.running ? `${p.running} running side by side${p.parallel ? ` (up to ${p.parallel})` : ''}` : '', blocked ? `${blocked} waiting on others` : ''].filter(Boolean).join(' · ')}
                </T>
              ) : null}
              {how ? (
                <Press onPress={() => setHowOpen(true)} accessibilityLabel={`How it runs: ${how.label}`} style={{ alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 7, height: 34, paddingHorizontal: 12, borderRadius: 17, backgroundColor: toneBg('lavender') }}>
                  <how.Icon color={toneInk('lavender')} size={15} strokeWidth={2.3} />
                  <T v="caption" c={toneInk('lavender')} style={{ fontWeight: '700' }}>
                    {how.label}
                    {p.paused ? ' · paused' : ''}
                  </T>
                  <ChevronDown color={toneInk('lavender')} size={14} />
                </Press>
              ) : null}
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
                    <Card style={{ marginHorizontal: 16, padding: 16, gap: 14 }}>
                      <NeedFace item={n} more />
                      <NeedButtons item={n} onAnswer={(t) => answer(n, t)} />
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
                <Milestone key={m.id} m={m} last={i === p.milestones.length - 1} i={i} draft={p.state === 'draft'} titles={titles} after={(m.dependsOn ?? []).map((d) => milestoneTitles.get(d) ?? d)} />
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

function Milestone({ m, last, i, draft, titles, after }: { m: PlanView['milestones'][number]; last: boolean; i: number; draft: boolean; titles: ReadonlyMap<string, string>; after: readonly string[] }) {
  // A draft reads whole (you approve it from here); a running plan opens where the work is.
  const [open, setOpen] = useState(draft || m.state === 'running' || m.state === 'waiting' || m.state === 'gate');
  const [task, setTask] = useState<string | undefined>();
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
            {m.state === 'gate' ? 'Waiting for you to pass it' : m.state}
          </T>
          {after.length ? (
            <T v="caption" c={color.text3} numberOfLines={2} style={{ marginTop: 2 }}>
              After {after.join(', ')}
            </T>
          ) : m.dependsOn && i > 0 ? (
            <T v="caption" c={color.text3} style={{ marginTop: 2 }}>
              Runs alongside the others
            </T>
          ) : null}
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
                const waits = (t.blockedBy ?? []).map((b) => titles.get(b) ?? b);
                const shown = task === t.id;
                const row = (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11, paddingHorizontal: 12, borderTopWidth: ti ? 0.5 : 0, borderTopColor: color.hairline }}>
                    <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: tt === 'plain' ? color.hairlineStrong : toneInk(tt) }} />
                    <View style={{ flex: 1 }}>
                      <T v="callout" c={t.state === 'done' ? color.text2 : color.text} numberOfLines={shown ? undefined : 2}>
                        {t.title}
                      </T>
                      {waits.length ? (
                        <T v="caption" c={color.text3} numberOfLines={shown ? undefined : 1}>
                          Waits on {waits.join(', ')}
                        </T>
                      ) : null}
                      {shown && t.goal ? (
                        <T v="caption" c={color.text2} style={{ marginTop: 4 }}>
                          {t.goal}
                        </T>
                      ) : null}
                      {shown && t.acceptance?.length ? (
                        <View style={{ marginTop: 4, gap: 2 }}>
                          {t.acceptance.map((a) => (
                            <T key={a} v="caption" c={color.text2}>
                              ◦ {a}
                            </T>
                          ))}
                        </View>
                      ) : null}
                      {shown && t.why ? (
                        <T v="caption" c={color.text3} style={{ marginTop: 4 }}>
                          {t.why}
                        </T>
                      ) : null}
                    </View>
                    {t.mine ? <User color={color.info} size={13} /> : null}
                    <T v="caption" c={toneInk(tt)} style={{ fontWeight: "600" }}>
                      {t.state}
                    </T>
                    {t.topic ? <ChevronRight color={color.text3} size={15} /> : null}
                  </View>
                );
                // Its worktree's conversation once it has one; until then a tap shows what it's for.
                return (
                  <Press key={t.id} scaleTo={0.98} onPress={() => (t.topic ? router.push(convHref(t.topic)) : setTask(shown ? undefined : t.id))}>
                    {row}
                  </Press>
                );
              })}
            </Card>
          </Animated.View>
        ) : null}
      </View>
    </Animated.View>
  );
}
