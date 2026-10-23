import { useLocalSearchParams } from 'expo-router';
import { Bot, CircleCheck, CircleX, History, Monitor, OctagonX, Sparkles, Square } from 'lucide-react-native';
import { useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, useWindowDimensions, View } from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeInUp, LinearTransition } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Composer } from '../../components/Composer';
import { AgentChips, Prose, StepTicker } from '../../components/Conv';
import { answer, NeedButtons, NeedFace } from '../../components/Needs';
import { Options } from '../../components/Options';
import { OutputGrid, Thumb } from '../../components/Outputs';
import { Header, Screen } from '../../components/Screen';
import { Sheet } from '../../components/Sheet';
import { Avatar, Card, IconBadge, More, Pill, Press, T, type Tone } from '../../components/ui';
import { ago, useView, useVisibleNeeds } from '../../lib/hooks';
import { calls } from '../../lib/link/calls';
import type { ConvView, OutputView, SubAgentView, Topic, TurnView } from '../../lib/link/protocol';
import { store } from '../../lib/store';
import { color } from '../../lib/theme';
import { router } from 'expo-router';

/**
 * One conversation: your messages, Claude's answers as cards (code folded into chips), the live
 * step, sub-agents as chips (tap: a sheet with their steps and outputs), what it waits on you for,
 * and a composer with Send and Stop.
 */
export default function Conversation() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const topic = `conv:${decodeURIComponent(id ?? '')}` as Topic;
  const conv = useView<ConvView>(topic);
  const c = conv?.data;
  const needs = useVisibleNeeds(c?.needsYou);
  const insets = useSafeAreaInsets();
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const atEnd = useRef(true);
  const [agent, setAgent] = useState<SubAgentView | undefined>();
  const [olderBusy, setOlderBusy] = useState(false);
  const [menu, setMenu] = useState(false);
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
  const all: OutputView[] = c ? c.turns.flatMap((t) => [...(t.outputs ?? []), ...(t.subagents ?? []).flatMap((a) => a.outputs)]) : [];

  return (
    <Screen>
      <Header back eyebrow={c?.project} title={c?.title ?? 'Conversation'} at={conv?.at} right={
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {c?.working ? <Pill label="Working" tone="peach" /> : null}
            <More onPress={() => setMenu(true)} label="Conversation options" />
          </View>
        }
      />
      <KeyboardAvoidingView behavior={Platform.OS === 'web' ? undefined : 'padding'} style={{ flex: 1 }}>
        <ScrollView
          ref={scroll}
          onContentSizeChange={follow}
          onScroll={(e) => {
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
          {c?.turns.map((t, i) => (
            <Animated.View key={t.id} entering={i > c.turns.length - 3 ? FadeInUp.springify().stiffness(200).damping(22) : undefined} layout={LinearTransition.springify().stiffness(220).damping(26)}>
              {t.who === 'you' ? <YourTurn t={t} /> : <ClaudeTurn t={t} all={all} onAgent={setAgent} />}
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
          placeholder={c?.working ? 'Add to what Claude is doing…' : 'Reply to Claude…'}
          working={c?.working}
          disabled={c && !c.canSend ? 'You can read this conversation, not write in it.' : undefined}
          onSend={(text) => {
            atEnd.current = true;
            void store.call(calls.send(topic, text)).catch((e: Error) => store.toast({ text: e.message, tone: 'error' }));
          }}
          onStop={() => void store.call(calls.stop(topic))}
          bottom={insets.bottom}
        />
      </KeyboardAvoidingView>
      <AgentSheet agent={liveAgent} onClose={() => setAgent(undefined)} />
      <Options
        visible={menu}
        onClose={() => setMenu(false)}
        title={c?.title}
        options={[
          { Icon: Square, label: 'Stop Claude', tone: 'rose', hidden: !c?.working, onPress: () => void store.call(calls.stop(topic)) },
          { Icon: Sparkles, label: 'Ask with a photo', sub: 'Opens Ask, aimed here', tone: 'peach', onPress: () => router.push({ pathname: '/ask', params: { topic } }) },
          { Icon: History, label: 'Earlier messages', tone: 'sky', hidden: !c?.more, onPress: () => void older() },
          { Icon: Monitor, label: 'Open on your Mac', sub: 'Code, changes and the full history', tone: 'plain', onPress: () => store.toast({ text: 'Open it in Beluga on your Mac.', tone: 'info' }) },
        ]}
      />
    </Screen>
  );
}

function YourTurn({ t }: { t: TurnView }) {
  return (
    <View style={{ alignItems: 'flex-end', paddingLeft: 48 }}>
      <View style={{ backgroundColor: color.card, borderRadius: 20, borderBottomRightRadius: 6, paddingVertical: 10, paddingHorizontal: 14 }}>
        <Prose prose={t.prose} size={15} />
      </View>
      <T v="caption" style={{ marginTop: 4, marginRight: 4 }}>
        {ago(t.ts)}
      </T>
    </View>
  );
}

function ClaudeTurn({ t, all, onAgent }: { t: TurnView; all: OutputView[]; onAgent: (a: SubAgentView) => void }) {
  const working = t.status === 'working';
  const { width } = useWindowDimensions();
  const outs = t.outputs ?? [];
  const thumbW = Math.min(width, 520) - 28 - 32;
  const mins = t.endTs ? Math.max(1, Math.round((t.endTs - t.ts) / 60000)) : undefined;
  return (
    <Card style={{ padding: 16, gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
        <Avatar name={t.name} size={26} claude={t.who === 'claude'} />
        <T v="callout" c={color.text} style={{ fontWeight: '700' }}>
          {t.name}
        </T>
        <T v="caption" style={{ flex: 1 }} numberOfLines={1}>
          {t.steps ? `${t.steps} steps` : ''}
          {mins ? ` · ${mins} min` : ''}
        </T>
        <T v="caption">{ago(t.ts)}</T>
      </View>
      {t.prose.text ? <Prose prose={t.prose} /> : null}
      {working ? <StepTicker step={t.step ?? 'Thinking'} /> : null}
      {t.subagents?.length ? (
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <T v="caption" style={{ fontWeight: '600' }}>
              {t.subagents.length} helpers{t.subagents.some((a) => a.status === 'running') ? ` · ${t.subagents.filter((a) => a.status === 'running').length} working` : ''}
            </T>
          </View>
          <AgentChips agents={t.subagents} onOpen={onAgent} />
        </View>
      ) : null}
      {outs.length ? (
        <Animated.View entering={FadeIn} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {outs.map((o) => (o.kind === 'image' ? <Thumb key={o.ref} o={o} group={all} w={outs.length === 1 ? thumbW : (thumbW - 8) / 2} h={outs.length === 1 ? thumbW * 0.6 : (thumbW - 8) / 2 * 0.75} /> : <Thumb key={o.ref} o={o} group={all} w={(thumbW - 8) / 2} h={96} />))}
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
    </Card>
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
                Helper
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
              Steps
            </T>
            {a.steps.map((s, i) => {
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
