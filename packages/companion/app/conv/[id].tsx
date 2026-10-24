import { useLocalSearchParams } from 'expo-router';
import { KeyboardLift } from '../../components/KeyboardLift';
import { Activity, Bot, Camera, CircleCheck, CircleX, Clock, Cpu, FolderTree, GitMerge, History, Images, Laptop, Monitor, OctagonX, Send, Sparkles, Square, SquareTerminal } from 'lucide-react-native';
import { AgentList, Breathe, LivePanel, StepList, StepsFold, ToolBadge, TypingDots } from '../../components/Live';
import { BranchBand, MergeBand, MergeSheet } from '../../components/Merge';
import { ProjectMark } from '../../components/ProjectMark';
import { openOnMac } from '../../lib/mac';
import { useRef, useState } from 'react';
import { Platform, ScrollView, useWindowDimensions, View } from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeInUp, LinearTransition } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Composer, QueueTray } from '../../components/Composer';
import { AgentChips, Prose, StepTicker } from '../../components/Conv';
import { answer, NeedButtons, NeedFace } from '../../components/Needs';
import { Options } from '../../components/Options';
import { OutputGrid, TurnOutputs } from '../../components/Outputs';
import { Header, Screen, useScrolled } from '../../components/Screen';
import { Sheet } from '../../components/Sheet';
import { Avatar, Card, IconBadge, More, Pill, Press, T, type Tone } from '../../components/ui';
import { ago, elapsed, useSince, useView, useVisibleNeeds } from '../../lib/hooks';
import { calls } from '../../lib/link/calls';
import { type ConvView, type OutputView, type SubAgentView, type Topic, type TurnView, isMacTopic } from '../../lib/link/protocol';
import { type Send as Pending, sends, useSends } from '../../lib/sends';
import { SendStatus } from '../../components/SendStatus';
import { store } from '../../lib/store';
import { color } from '../../lib/theme';
import { router } from 'expo-router';

/**
 * One conversation: your messages, Claude's answers as cards (code folded into chips), the live
 * step, sub-agents as chips (tap: a sheet with their steps and outputs), what it waits on you for,
 * and a composer with Send and Stop.
 */

/** An empty Your Mac: three first things to ask, one tap each (the composer is there too). */
function MacStarters({ topic }: { readonly topic: Topic }) {
  const starters = [
    { label: 'Send me a screenshot', Icon: Camera, tone: 'sky' as Tone, text: 'Take a screenshot of my screen and send it to me.' },
    { label: 'What’s using my CPU?', Icon: Cpu, tone: 'peach' as Tone, text: 'What’s using my CPU and memory right now?' },
    { label: 'What’s running?', Icon: Activity, tone: 'mint' as Tone, text: 'What’s running in Beluga right now, across my projects?' },
  ];
  return (
    <Animated.View entering={FadeIn.duration(260)} style={{ alignItems: 'center', gap: 14, marginTop: 40 }}>
      <IconBadge Icon={Laptop} tone="sky" size={56} />
      <T v="heading">Ask your Mac</T>
      <T v="callout" style={{ textAlign: 'center', paddingHorizontal: 24 }}>
        Your Claude for the whole Mac, not one project. The same conversation as on your Mac.
      </T>
      <View style={{ gap: 8, alignSelf: 'stretch', marginTop: 6 }}>
        {starters.map((s) => (
          <Press key={s.label} scaleTo={0.985} onPress={() => sends.message(topic, s.text, calls.send(topic, s.text))}>
            <Card style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11, paddingHorizontal: 14 }}>
              <IconBadge Icon={s.Icon} tone={s.tone} size={30} />
              <T v="body">{s.label}</T>
            </Card>
          </Press>
        ))}
      </View>
    </Animated.View>
  );
}

export default function Conversation() {
  const { scrolled, onScroll } = useScrolled();
  const { id } = useLocalSearchParams<{ id: string }>();
  const topic = `conv:${decodeURIComponent(id ?? '')}` as Topic;
  const conv = useView<ConvView>(topic);
  const c = conv?.data;
  const needs = useVisibleNeeds(c?.needsYou);
  /** What you sent that the Mac's view doesn't show yet (lib/sends.ts). */
  const pending = useSends(topic);
  const insets = useSafeAreaInsets();
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const atEnd = useRef(true);
  const [agent, setAgent] = useState<SubAgentView | undefined>();
  const [olderBusy, setOlderBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  /** A steered message of yours Claude hasn't read yet, long-pressed: its sheet offers Send now. */
  const [unread, setUnread] = useState<TurnView | undefined>();
  const older = async () => {
    if (!c) return;
    setOlderBusy(true);
    await store.call(calls.older(topic, c.turns[0]?.id ?? '')).catch(() => undefined);
    setOlderBusy(false);
  };

  // Keep the newest in view while you're at the end; leave you be when you've scrolled up.
  const follow = () => {
    if (atEnd.current) scroll.current?.scrollToEnd({ animated: true });
  };
  const liveAgent = agent && c ? c.turns.flatMap((t) => t.subagents ?? []).find((a) => a.id === agent.id) ?? agent : agent;
  // The viewer swipes through this worktree's outputs (all of them, since 1.3; else the turns').
  const all: OutputView[] = c ? (c.outputs ?? c.turns.flatMap((t) => [...(t.outputs ?? []), ...(t.subagents ?? []).flatMap((a) => a.outputs)])) : [];
  const [outputsOpen, setOutputsOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  // What waits its turn is in the queue above the composer, not a turn of its own.
  const turns = c ? c.turns.filter((t) => !(c.queue && t.who === 'claude' && t.status === 'queued')) : [];
  // A worktree (or chat folder) of yours has files to read and terminals to share with the Mac (1.7).
  const hasFolder = topic.startsWith('conv:ws:') || Boolean(c?.mergeable);

  return (
    <Screen>
      <Header scrolled={scrolled} back eyebrow={c?.project} title={c?.title ?? 'Conversation'} at={conv?.at} lead={isMacTopic(topic) ? <IconBadge Icon={Laptop} tone="sky" size={30} /> : c?.project ? <ProjectMark name={c.project} icon={c.icon} size={30} /> : undefined} right={
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {c?.working && !all.length ? <Pill label="Working" tone="peach" /> : null}
            {all.length ? (
              <Press onPress={() => setOutputsOpen(true)} accessibilityLabel={`Outputs, ${all.length}`} hitSlop={6} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, height: 34, paddingHorizontal: 10, borderRadius: 17, backgroundColor: color.sunken }}>
                <Images color={color.text2} size={16} />
                <T v="caption" c={color.text2} style={{ fontWeight: '700' }}>
                  {all.length}
                </T>
              </Press>
            ) : null}
            <More onPress={() => setMenu(true)} label="Conversation options" />
          </View>
        }
      />
      <KeyboardLift>
        {/* Where a merge stands stays in view while the conversation scrolls under it. */}
        {c?.merge ? (
          <View style={{ paddingHorizontal: 14, paddingBottom: 8 }}>
            <MergeBand topic={topic} merge={c.merge} onCheck={() => setMergeOpen(true)} />
          </View>
        ) : c?.branch ? (
          // Where its branch stands (the Mac toolbar's state), unless a merge from here is under way.
          <View style={{ paddingHorizontal: 14, paddingBottom: 8 }}>
            <BranchBand topic={topic} branch={c.branch} canMerge={Boolean(c.mergeable) && store.supports('merge')} onMerge={() => setMergeOpen(true)} />
          </View>
        ) : null}
        <ScrollView
          ref={scroll}
          onContentSizeChange={follow}
          onScroll={(e) => {
            onScroll(e);
            const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
            atEnd.current = contentOffset.y + layoutMeasurement.height > contentSize.height - 80;
          }}
          scrollEventThrottle={64}
          contentContainerStyle={{ paddingHorizontal: 14, paddingTop: 8, paddingBottom: 18, gap: 14 }}
          keyboardDismissMode="interactive"
        >
          {c?.more ? (
            <Press
              onPress={() => void older()}
              style={{ alignSelf: 'center', paddingHorizontal: 14, height: 30, borderRadius: 15, justifyContent: 'center', backgroundColor: color.sunken }}
            >
              <T v="caption" c={color.text2}>
                {olderBusy ? 'Loading…' : 'Earlier messages'}
              </T>
            </Press>
          ) : null}
          {!c ? <T v="callout" style={{ textAlign: 'center', marginTop: 40 }}>Opening the conversation…</T> : null}
          {c && isMacTopic(topic) && !turns.length && !pending.length ? <MacStarters topic={topic} /> : null}
          {turns.map((t, i) => (
            <Animated.View key={t.id} entering={i > turns.length - 3 ? FadeInUp.springify().stiffness(200).damping(22) : undefined} layout={LinearTransition.springify().stiffness(220).damping(26)}>
              {t.who === 'you' ? <YourTurn t={t} onLongPress={t.steer?.waiting === 'next_step' ? () => setUnread(t) : undefined} /> : <ClaudeTurn t={t} all={all} onAgent={setAgent} topic={topic} />}
            </Animated.View>
          ))}
          {pending.map((p) => (
            <Animated.View key={p.id} entering={FadeInUp.springify().stiffness(220).damping(22)} layout={LinearTransition.springify().stiffness(220).damping(26)}>
              <PendingTurn s={p} />
            </Animated.View>
          ))}
          {needs.map((n) => (
            <Animated.View key={n.id} entering={FadeInDown.springify()} layout={LinearTransition.springify()}>
              <Card style={{ padding: 16, gap: 14 }}>
                <NeedFace item={n} more  />
                <NeedButtons item={n} onAnswer={(t) => answer(n, t)} />
              </Card>
            </Animated.View>
          ))}
        </ScrollView>
        <Composer
          placeholder={c?.working ? 'Steer Claude, or queue what’s next…' : 'Reply to Claude…'}
          working={c?.working}
          disabled={c && !c.canSend ? 'You can read this conversation, not write in it.' : undefined}
          onSend={(text) => {
            atEnd.current = true;
            // While Claude works, Send queues (after), as on the Mac; Steer is beside it.
            const call = c?.working && !topic.startsWith('conv:task:') ? calls.queue(topic, text) : calls.send(topic, text);
            sends.message(topic, text, call);
          }}
          onSteer={
            topic.startsWith('conv:task:')
              ? undefined
              : (text) => {
                  atEnd.current = true;
                  sends.message(topic, text, calls.steer(topic, text));
                }
          }
          onStop={() => void store.call(calls.stop(topic))}
          bottom={insets.bottom}
          above={
            c?.queue?.length ? (
              <QueueTray
                queue={c.queue}
                onSteer={(qid) => void store.call(calls.steerQueued(qid)).catch((e: Error) => store.toast({ text: e.message, tone: 'error' }))}
                onRemove={(qid) => void store.call(calls.unqueue(qid)).catch((e: Error) => store.toast({ text: e.message, tone: 'error' }))}
              />
            ) : null
          }
        />
      </KeyboardLift>
      <AgentSheet agent={liveAgent} onClose={() => setAgent(undefined)} />
      <Sheet
        visible={outputsOpen}
        onDismiss={() => setOutputsOpen(false)}
        header={
          <View style={{ paddingHorizontal: 20, paddingBottom: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <IconBadge Icon={Images} tone="sky" size={32} />
            <View style={{ flex: 1 }}>
              <T v="title" style={{ fontSize: 20 }}>
                Outputs
              </T>
              <T v="caption">Screenshots, logs, reports and scratch files from this worktree</T>
            </View>
          </View>
        }
      >
        <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 20 }}>
          <OutputGrid items={all} cols={3} />
        </ScrollView>
      </Sheet>
      {c?.mergeable ? <MergeSheet topic={topic} visible={mergeOpen} onClose={() => setMergeOpen(false)} /> : null}
      <Options
        visible={Boolean(unread)}
        onClose={() => setUnread(undefined)}
        title="Claude hasn't read this yet"
        options={[
          {
            Icon: Send,
            label: 'Send now',
            sub: 'Stops Claude’s current step so it reads this next',
            tone: 'peach',
            onPress: () => {
              const request = unread?.steer?.request;
              if (request) void store.call(calls.steerNow(request)).catch((e: Error) => store.toast({ text: e.message, tone: 'error' }));
            },
          },
        ]}
      />
      <Options
        visible={menu}
        onClose={() => setMenu(false)}
        title={c?.title}
        options={[
          { Icon: Square, label: 'Stop Claude', tone: 'rose', hidden: !c?.working, onPress: () => void store.call(calls.stop(topic)) },
          { Icon: Images, label: 'Outputs', sub: all.length ? `${all.length} from this worktree` : 'Nothing yet', tone: 'sky', hidden: !all.length, onPress: () => setOutputsOpen(true) },
          { Icon: GitMerge, label: 'Merge…', sub: 'Into your main folder, checked first', tone: 'lavender', hidden: !c?.mergeable || !store.supports('merge') || Boolean(c?.branch), onPress: () => setMergeOpen(true) },
          { Icon: FolderTree, label: 'Files', sub: 'Browse and read this worktree, read only', tone: 'sky', hidden: !hasFolder || !store.supports('files'), onPress: () => router.push({ pathname: '/files', params: { topic, name: c?.title ?? 'Worktree' } }) },
          { Icon: SquareTerminal, label: 'Terminal', sub: 'The same terminal as on your Mac', tone: 'lavender', hidden: !hasFolder || !store.supports('terminal'), onPress: () => router.push({ pathname: '/terminal', params: { topic, title: c?.title ?? '' } }) },
          { Icon: Sparkles, label: 'Ask with a photo', sub: 'Opens Ask, aimed here', tone: 'peach', onPress: () => router.push({ pathname: '/ask', params: { topic } }) },
          { Icon: History, label: 'Earlier messages', tone: 'sky', hidden: !c?.more, onPress: () => void older() },
          { Icon: Monitor, label: 'Open on your Mac', sub: 'Code, changes and the full history', tone: 'plain', onPress: () => void openOnMac({ topic }) },
        ]}
      />
    </Screen>
  );
}

/** Your message. Steered into Claude's turn and not read yet: dimmed, with a clock (long-press: Send now). */
function YourTurn({ t, onLongPress }: { t: TurnView; onLongPress?: (() => void) | undefined }) {
  const waiting = t.steer?.waiting;
  return (
    <Press onLongPress={onLongPress} disabled={!onLongPress} scaleTo={0.99} style={{ alignItems: 'flex-end', paddingLeft: 48 }}>
      <View style={{ backgroundColor: color.card, borderRadius: 20, borderBottomRightRadius: 6, paddingVertical: 10, paddingHorizontal: 14, opacity: waiting ? 0.6 : 1 }}>
        <Prose prose={t.prose} size={15} />
      </View>
      {waiting ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 4, marginRight: 4 }}>
          <Clock color={color.text2} size={12} />
          <T v="caption">{waiting === 'stopping' ? 'Sent · Claude is stopping its step to read it' : 'Sent · waiting for Claude to read it'}</T>
        </View>
      ) : (
        <T v="caption" style={{ marginTop: 4, marginRight: 4 }}>
          {ago(t.ts)}
        </T>
      )}
    </Press>
  );
}

/** Yours, before the Mac's view has it: sending, waiting for the Mac, or not sent (Retry, Remove). */
function PendingTurn({ s }: { s: Pending }) {
  return (
    <View style={{ alignItems: 'flex-end', paddingLeft: 48 }}>
      <View style={{ backgroundColor: color.card, borderRadius: 20, borderBottomRightRadius: 6, paddingVertical: 10, paddingHorizontal: 14, opacity: s.state === 'failed' ? 1 : 0.6, borderWidth: s.state === 'failed' ? 1 : 0, borderColor: color.error }}>
        <T v="body" style={{ fontSize: 15 }}>
          {s.text}
        </T>
      </View>
      <SendStatus s={s} />
    </View>
  );
}

function ClaudeTurn({ t, all, onAgent, topic }: { t: TurnView; all: OutputView[]; onAgent: (a: SubAgentView) => void; topic: Topic }) {
  const working = t.status === 'working';
  const outs = t.outputs ?? [];
  const mins = t.endTs ? Math.max(1, Math.round((t.endTs - t.ts) / 60000)) : undefined;
  // No card around Claude's answer: it takes the screen's full width, your bubbles sit on the right.
  return (
    <View style={{ gap: 12, paddingTop: 2 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
        <Avatar name={t.name} size={26} claude={t.who === 'claude'} />
        <T v="callout" c={color.text} style={{ fontWeight: '700' }}>
          {t.name}
        </T>
        <T v="caption" style={{ flex: 1 }} numberOfLines={1}>
          {t.steps ? `${t.steps} ${t.steps === 1 ? 'step' : 'steps'}` : ''}
          {mins ? ` · ${mins} min` : ''}
        </T>
        <T v="caption">{ago(t.ts)}</T>
      </View>
      {t.prose.text ? <Prose prose={t.prose} at={{ topic, turn: t.id }} /> : null}
      {working ? <LivePanel t={t} /> : <StepsFold t={t} />}
      {t.subagents?.length ? (
        working || t.subagents.length <= 3 ? (
          <AgentList agents={t.subagents} onOpen={onAgent} />
        ) : (
          <View style={{ gap: 8 }}>
            <T v="caption" style={{ fontWeight: '600' }}>
              {t.subagents.length} sub-agents
            </T>
            <AgentChips agents={t.subagents} onOpen={onAgent} />
          </View>
        )
      ) : null}
      {outs.length ? (
        <Animated.View entering={FadeIn}>
          <TurnOutputs items={outs} />
        </Animated.View>
      ) : null}
      {t.status === 'failed' || t.status === 'stopped' ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {t.status === 'failed' ? <CircleX color={color.error} size={14} /> : <OctagonX color={color.text2} size={14} />}
          <T v="caption" c={t.status === 'failed' ? color.error : color.text2}>
            {t.status === 'failed' ? 'Failed' : 'Stopped'}
          </T>
        </View>
      ) : null}
    </View>
  );
}

/** What a sub-agent is doing now, breathing, with how long it has been at work. */
function AgentNow({ a }: { a: SubAgentView }) {
  const secs = useSince(a.startedAt);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 }}>
      <Breathe>
        <ToolBadge kind={a.tool ?? 'agent'} size={22} />
      </Breathe>
      <T v="callout" c={color.subagent} numberOfLines={1} style={{ flex: 1, fontWeight: '600' }}>
        {a.step ?? 'Working'}
      </T>
      <TypingDots tone="lavender" />
      {secs !== undefined ? <T v="caption">{elapsed(secs)}</T> : null}
    </View>
  );
}

function AgentSheet({ agent, onClose }: { agent?: SubAgentView; onClose: () => void }) {
  const { width } = useWindowDimensions();
  const [last, setLast] = useState<SubAgentView | undefined>(agent);
  if (agent && agent !== last) setLast(agent);
  const a = agent ?? last;
  const tone: Tone = a?.status === 'running' ? 'lavender' : a?.status === 'failed' ? 'rose' : 'mint';
  return (
    <Sheet
      visible={!!agent}
      onDismiss={onClose}
      header={
        a ? (
          <View style={{ paddingHorizontal: 20, paddingBottom: 12, gap: 6 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <IconBadge Icon={Bot} tone="lavender" size={30} />
              <T v="callout" style={{ flex: 1 }}>
                Sub-agent{a.type ? ` · ${a.type}` : ''}
              </T>
              <Pill label={a.status === 'running' ? 'Working' : a.status === 'failed' ? 'Failed' : 'Done'} tone={tone} />
            </View>
            <T v="title" style={{ fontSize: 20, lineHeight: 26 }}>
              {a.title}
            </T>
          </View>
        ) : null
      }
    >
      {a ? (
        <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 20, gap: 18 }}>
          <View>
            <T v="eyebrow" style={{ marginBottom: 10 }}>
              Steps{a.count ? ` · ${a.count}` : ''}
            </T>
            {a.trail ? (
              <View style={{ gap: 6 }}>
                {a.trail.length ? <StepList steps={a.trail} shown={10} /> : null}
                {a.status === 'running' ? <AgentNow a={a} /> : null}
              </View>
            ) : null}
            {a.trail ? null : a.steps.map((s, i) => {
              const lastStep = i === a.steps.length - 1;
              const live = lastStep && a.status === 'running';
              return (
                <View key={i} style={{ flexDirection: 'row', gap: 12 }}>
                  <View style={{ alignItems: 'center', width: 14 }}>
                    <View style={{ width: 9, height: 9, borderRadius: 5, marginTop: 6, backgroundColor: live ? color.subagent : color.ok }} />
                    {!lastStep ? <View style={{ width: 1.5, flex: 1, backgroundColor: color.hairlineStrong, marginVertical: 3 }} /> : null}
                  </View>
                  <View style={{ flex: 1, paddingBottom: 12 }}>
                    {live ? <StepTicker step={s} tone="lavender" size={14} /> : <T v="callout" c={color.text}>{s}</T>}
                  </View>
                </View>
              );
            })}
            {a.status === 'done' ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 }}>
                <CircleCheck color={color.ok} size={15} />
                <T v="caption" c={color.ok}>
                  Done
                </T>
              </View>
            ) : null}
          </View>
          {a.outputs.length ? (
            <View>
              <T v="eyebrow" style={{ marginBottom: 10 }}>
                Outputs · {a.outputs.length}
              </T>
              <OutputGrid items={a.outputs} cols={2} width={Math.min(width, 520) - 40} />
            </View>
          ) : null}
        </ScrollView>
      ) : null}
    </Sheet>
  );
}
