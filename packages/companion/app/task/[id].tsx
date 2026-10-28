import { router, useLocalSearchParams } from 'expo-router';
import { ArrowRightLeft, Check, CircleSlash, GitBranch, Clock, GitPullRequest, MessageSquare, Monitor, Play, User } from 'lucide-react-native';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import Animated, { FadeIn, LinearTransition } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Composer } from '../../components/Composer';
import { convHref, Prose } from '../../components/Conv';
import { KeyboardLift } from '../../components/KeyboardLift';
import { Options } from '../../components/Options';
import { ProjectMark } from '../../components/ProjectMark';
import { Header, Screen, useScrolled } from '../../components/Screen';
import { PRIORITY, statusOf } from '../../components/Tasks';
import { TaskWords } from '../../components/render/TaskChip';
import { Avatar, Button, Card, haptic, IconBadge, More, Pill, Press, T, toneBg, toneInk } from '../../components/ui';
import { ago, useSupports, useView } from '../../lib/hooks';
import { calls } from '../../lib/link/calls';
import type { TaskPageView, Topic } from '../../lib/link/protocol';
import { openOnMac } from '../../lib/mac';
import { store } from '../../lib/store';
import { color } from '../../lib/theme';

/**
 * One task (BLG-48): its goal (code folded), the acceptance criteria with their ticks, the
 * worktree and pull request doing it, and its activity, live. Comment below; start it in a new
 * worktree with Claude, or move it along, from here. Editing the brief stays on the Mac.
 */
export default function Task() {
  const { scrolled, onScroll } = useScrolled();
  const { id } = useLocalSearchParams<{ id: string }>();
  const topic = `task:${decodeURIComponent(id ?? '')}` as Topic;
  const tasksOn = useSupports('tasks');
  const view = useView<TaskPageView>(tasksOn ? topic : undefined);
  const t = view?.data;
  const insets = useSafeAreaInsets();
  const [menu, setMenu] = useState(false);
  const [moving, setMoving] = useState(false);
  const [starting, setStarting] = useState(false);
  const st = t ? statusOf(t.status) : undefined;
  const pr = t ? PRIORITY[t.priority] : undefined;
  const canStart = t && !t.conv && (t.status === 'todo' || t.status === 'backlog' || t.status === 'in_progress');

  const start = async () => {
    if (!t || starting) return;
    haptic.commit();
    setStarting(true);
    const ws = await store.call<string>(calls.start(t.key), { queue: false }).catch((e: Error) => (store.toast({ text: e.message, tone: 'error' }), undefined));
    setStarting(false);
    if (typeof ws === 'string') {
      store.toast({ text: `${t.key} started: Claude is on it`, tone: 'ok' });
      router.push(convHref(`conv:ws:${ws}`));
    }
  };

  return (
    <Screen>
      <Header
        scrolled={scrolled}
        back
        eyebrow={t ? `${t.key} · ${t.project}` : 'Task'}
        title={t?.title ?? 'Task'}
        at={view?.at}
        lead={t ? <ProjectMark name={t.project} icon={t.icon} size={30} /> : undefined}
        right={
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {st ? <Pill label={st.label} tone={st.tone} Icon={st.Icon} /> : null}
            <More onPress={() => setMenu(true)} label="Task options" />
          </View>
        }
      />
      <KeyboardLift>
        <ScrollView onScroll={onScroll} scrollEventThrottle={32} contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 6, paddingBottom: 20, gap: 14 }} keyboardDismissMode="interactive">
          {!t ? <T v="callout" style={{ textAlign: 'center', marginTop: 40 }}>{tasksOn ? 'Opening the task…' : 'Update Beluga on your Mac to see tasks here.'}</T> : null}
          {t ? (
            <Animated.View entering={FadeIn.duration(220)} style={{ gap: 14 }}>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {pr && t.priority !== 'none' ? <Pill label={pr.label} tone={pr.tone} /> : null}
                <Pill label={t.assignee ?? 'No one'} Icon={User} tone={t.assignee ? 'lavender' : 'plain'} />
                {t.working ? <Pill label={t.working} Icon={User} tone="mint" /> : null}
                {t.waiting ? <Pill label={t.waiting} Icon={Clock} tone="butter" /> : null}
                {t.checks ? <Pill label={`${t.checks.done} of ${t.checks.total} checked`} Icon={Check} tone={t.checks.done === t.checks.total ? 'mint' : 'plain'} /> : null}
              </View>

              {canStart ? <Button label={starting ? 'Starting…' : 'Start with Claude'} Icon={Play} disabled={starting} onPress={() => void start()} /> : null}
              {t.conv ? <Button label="Open its conversation" Icon={MessageSquare} quiet onPress={() => router.push(convHref(t.conv!))} /> : null}

              {t.goal?.text.trim() ? (
                <Card style={{ padding: 16, gap: 8 }}>
                  <T v="eyebrow">Goal</T>
                  <Prose prose={t.goal} size={15} tasks />
                </Card>
              ) : null}

              {t.acceptance.length ? (
                <Card style={{ padding: 16, gap: 10 }}>
                  <T v="eyebrow">Acceptance</T>
                  {t.acceptance.map((a, i) => {
                    const done = a.state === 'done';
                    const why = a.state === 'deferred' || a.state === 'not_done';
                    return (
                      <View key={i} style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
                        <View style={{ width: 20, height: 20, borderRadius: 6, marginTop: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: done ? toneBg('mint') : why ? toneBg('butter') : 'transparent', borderWidth: done || why ? 0 : 1.5, borderColor: color.hairlineStrong }}>
                          {done ? <Check color={toneInk('mint')} size={13} strokeWidth={2.2} /> : why ? <CircleSlash color={toneInk('butter')} size={12} /> : null}
                        </View>
                        <View style={{ flex: 1 }}>
                          <T v="callout" c={done ? color.text2 : color.text}>
                            {a.text}
                          </T>
                          {a.reason ? (
                            <T v="caption" style={{ marginTop: 2 }}>
                              {a.state === 'deferred' ? 'Deferred' : 'Not done'}: {a.reason}
                            </T>
                          ) : null}
                        </View>
                      </View>
                    );
                  })}
                </Card>
              ) : null}

              {t.worktree || t.pr ? (
                <Card style={{ padding: 6 }}>
                  {t.worktree ? (
                    <Press onPress={() => (t.conv ? router.push(convHref(t.conv)) : undefined)} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 10 }}>
                      <IconBadge Icon={GitBranch} tone="lavender" size={32} />
                      <View style={{ flex: 1 }}>
                        <T v="body" style={{ fontWeight: '500' }} numberOfLines={1}>
                          {t.worktree}
                        </T>
                        <T v="caption">The worktree doing it</T>
                      </View>
                    </Press>
                  ) : null}
                  {t.pr ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 10 }}>
                      <IconBadge Icon={GitPullRequest} tone={t.pr.state === 'MERGED' ? 'mint' : t.pr.state === 'CLOSED' ? 'plain' : 'sky'} size={32} />
                      <View style={{ flex: 1 }}>
                        <T v="body" style={{ fontWeight: '500' }} numberOfLines={1}>
                          #{t.pr.number} {t.pr.title}
                        </T>
                        <T v="caption">
                          {t.pr.state.toLowerCase()}
                          {t.pr.checks && t.pr.checks !== 'none' ? ` · checks ${t.pr.checks}` : ''}
                        </T>
                      </View>
                    </View>
                  ) : null}
                </Card>
              ) : null}

              {t.activity.length ? (
                <View style={{ gap: 10 }}>
                  <T v="eyebrow" style={{ paddingHorizontal: 4 }}>
                    Activity
                  </T>
                  {t.activity.map((a) => (
                    <Animated.View key={a.id} entering={FadeIn.duration(220)} layout={LinearTransition.duration(180)} style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
                      <Avatar name={a.who} size={26} claude={/Claude/.test(a.who)} />
                      <View style={{ flex: 1, gap: 4 }}>
                        <T v="callout">
                          <T v="callout" c={color.text} style={{ fontWeight: '600' }}>
                            {a.who}
                          </T>{' '}
                          {a.text} · {ago(a.at)}
                        </T>
                        {a.body ? (
                          <Card r={16} style={{ padding: 12 }}>
                            <T v="callout" c={color.text}>
                              <TaskWords text={a.body} />
                            </T>
                          </Card>
                        ) : null}
                      </View>
                    </Animated.View>
                  ))}
                </View>
              ) : null}
            </Animated.View>
          ) : null}
        </ScrollView>
        {t ? (
          <Composer
            placeholder={`Comment on ${t.key}…`}
            onSend={(text) => void store.call(calls.comment(t.key, text)).then(() => store.toast({ text: 'Commented', tone: 'ok' }), (e: Error) => store.toast({ text: e.message, tone: 'error' }))}
            bottom={insets.bottom}
          />
        ) : null}
      </KeyboardLift>
      <Options
        visible={menu}
        onClose={() => setMenu(false)}
        title={t ? `${t.key} ${t.title}` : undefined}
        options={[
          { Icon: Play, label: 'Start with Claude', sub: 'A new worktree, Claude working on it', tone: 'peach', hidden: !canStart, onPress: () => void start() },
          { Icon: ArrowRightLeft, label: 'Move to…', sub: st ? `Now ${st.label}` : undefined, tone: 'sky', hidden: !t?.moves.length, onPress: () => setMoving(true) },
          { Icon: Monitor, label: 'Open on your Mac', sub: 'Its brief, proof and history', tone: 'plain', onPress: () => void openOnMac({ topic }) },
        ]}
      />
      <Options
        visible={moving}
        onClose={() => setMoving(false)}
        title={t ? `Move ${t.key} to` : undefined}
        options={(t?.moves ?? []).map((m) => {
          const s = statusOf(m.status);
          return { Icon: s.Icon, label: m.label, tone: s.tone, onPress: () => void store.call(calls.move(t!.key, m.status, m.label)).then(() => store.toast({ text: `${t!.key} is ${m.label}`, tone: 'ok' }), (e: Error) => store.toast({ text: e.message, tone: 'error' })) };
        })}
      />
    </Screen>
  );
}
