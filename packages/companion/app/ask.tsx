import { Image } from 'expo-image';
import { ProjectMark } from '../components/ProjectMark';
import { router, useLocalSearchParams } from 'expo-router';
import { ArrowUp, ChevronDown, Folder, GitBranch, ImagePlus, Laptop, ListChecks, MessageCircleQuestion, MessageSquare, Mic, Sparkles, Square, Workflow, X } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, TextInput, View } from 'react-native';
import Animated, { FadeIn, FadeOut, useAnimatedStyle, withSpring, ZoomIn, ZoomOut } from 'react-native-reanimated';
import { convHref } from '../components/Conv';
import { Sheet } from '../components/Sheet';
import { Avatar, haptic, IconBadge, Press, T, type Tone, toneBg, toneInk } from '../components/ui';
import { useView } from '../lib/hooks';
import { type Call, calls } from '../lib/link/calls';
import { type HomeView, type PeopleView, type Topic, type WorkView, isMacTopic } from '../lib/link/protocol';
import { pickPhoto, upload } from '../lib/pick';
import { sends } from '../lib/sends';
import { store } from '../lib/store';
import { appendSpoken } from '../lib/dictate';
import { color, spring } from '../lib/theme';
import { MODEL_MB, useVoice, type VoiceState, voiceAvailable } from '../lib/voice';

/**
 * The Ask button's sheet: write, (attach a photo), send. Where it goes is one pill: tap it to
 * pick Your Mac (first, and the default: your Claude for the whole Mac), a project, an open
 * conversation, or a friend's Claude. The answer comes back into that conversation, which opens.
 *
 * In a project (1.5) it's what the Mac's project home offers, as three icon chips: a new worktree
 * with Claude on your words (the default; Plan first beside it is Claude Code's plan mode: it
 * proposes a plan before it acts), an Advanced plan (Beluga's Plans: milestones, tasks and what
 * waits on what, drafted for you to approve, then run on the board), or a question (read-only).
 *
 * The microphone beside Send writes down what you say, on the phone (lib/voice.ts): tap, speak,
 * tap again, and the words go into the field to read over before you send.
 */
type Target = { kind: 'mac'; topic: Topic; label: string } | { kind: 'project'; id: string; label: string; icon?: string } | { kind: 'conv'; topic: Topic; label: string; project?: string; icon?: string } | { kind: 'friend'; id: string; name: string; label: string };
const ICON: Record<Target['kind'], { Icon: typeof Folder; tone: Tone }> = { mac: { Icon: Laptop, tone: 'sky' }, project: { Icon: Folder, tone: 'butter' }, conv: { Icon: MessageSquare, tone: 'sky' }, friend: { Icon: Sparkles, tone: 'lavender' } };
const ASSISTANT: Topic = 'conv:mac:assistant';

/** How a project takes your words (BLG-69). */
type Mode = 'worktree' | 'plan' | 'question';
const MODES: ReadonlyArray<{ mode: Mode; label: string; Icon: typeof Folder; tone: Tone; hint: string }> = [
  { mode: 'worktree', label: 'Worktree', Icon: GitBranch, tone: 'mint', hint: 'Fix the login redirect and add a test' },
  { mode: 'plan', label: 'Advanced plan', Icon: Workflow, tone: 'butter', hint: 'Add sign-in with passkeys: milestones and tasks to approve' },
  { mode: 'question', label: 'Question', Icon: MessageCircleQuestion, tone: 'sky', hint: 'How does the payment flow work?' },
];

export default function Ask() {
  const params = useLocalSearchParams<{ friend?: string; topic?: string; text?: string; to?: string; how?: string }>();
  // A start that didn't go gives its words back (and where they were going): from its screen, or left for here.
  const [back] = useState(() => (params.text !== undefined ? { text: params.text, target: params.to, how: params.how } : sends.draft));
  const [visible, setVisible] = useState(true);
  const work = useView<WorkView>('work');
  const home = useView<HomeView>('home');
  const people = useView<PeopleView>('people');
  const [text, setText] = useState(back?.text ?? '');
  useEffect(() => void (sends.draft = undefined), []);
  const [photo, setPhoto] = useState<{ name: string; mime: string; b64: string; uri: string } | undefined>();
  const [picking, setPicking] = useState(false);
  const [mode, setMode] = useState<Mode>(() => MODES.find((m) => m.mode === back?.how)?.mode ?? 'worktree');
  const [planFirst, setPlanFirst] = useState(false);
  // An older Mac (before 1.5) has neither Your Mac nor worktrees and plans from here.
  const modes = store.supports('askModes');
  const voice = useVoice((words) => setText((t) => appendSpoken(t, words)));

  const targets = useMemo<Target[]>(() => {
    const t: Target[] = [];
    // Your Mac: the chat open on the Mac (it has tabs since BLG-102); its other chats working now are below, by their names.
    const mac = home?.data.assistant?.topic && isMacTopic(home.data.assistant.topic) ? home.data.assistant.topic : ASSISTANT;
    if (store.supports('assistant')) t.push({ kind: 'mac', topic: mac, label: 'Your Mac' });
    // Only your own projects take a new chat: not the room, a friend's shared project or "Asked of
    // friends" (views.ts groups those under 'room', 'shared:…' and 'asked').
    for (const p of work?.data.projects ?? []) if (p.id !== 'room' && p.id !== 'asked' && !p.id.startsWith('shared:')) t.push({ kind: 'project', id: p.id, label: p.name, ...(p.icon ? { icon: p.icon } : {}) });
    for (const c of home?.data.running ?? []) if (c.topic !== mac) t.push({ kind: 'conv', topic: c.topic, label: c.title, ...(c.project ? { project: c.project } : {}), ...(c.icon ? { icon: c.icon } : {}) });
    for (const p of people?.data.people ?? []) if (p.presence !== 'offline') t.push({ kind: 'friend', id: p.peerId, name: p.name, label: `${p.name}'s Claude` });
    return t;
  }, [work, home, people]);
  const [sel, setSel] = useState<string | undefined>();
  const keyOf = (t: Target): string => (t.kind === 'conv' || t.kind === 'mac' ? t.topic : `${t.kind}:${t.id}`);
  useEffect(() => {
    // Wait for the list the default comes from (projects, unless aimed at a friend or a conversation).
    if (sel || !targets.length || (!params.friend && !params.topic && !work)) return;
    const again = back?.target ? targets.find((t) => keyOf(t) === back.target) : undefined;
    const want =
      again ??
      (params.friend
        ? targets.find((t) => t.kind === 'friend' && t.id === params.friend)
        : params.topic
          ? targets.find((t) => (t.kind === 'conv' || t.kind === 'mac') && t.topic === params.topic)
          : (targets.find((t) => t.kind === 'mac') ?? targets.find((t) => t.kind === 'project')));
    setSel(keyOf(want ?? targets[0]!));
  }, [targets]);
  const target = targets.find((t) => keyOf(t) === sel);
  /** What a project does with your words: a worktree, a plan, a question (only a question before 1.5). */
  const how: Mode = target?.kind === 'project' && modes ? mode : 'question';
  // Photos go with a question, a message or (1.12) a new worktree; a plan starts from your words.
  const photos = target?.kind !== 'friend' && !(target?.kind === 'project' && (how === 'plan' || (how === 'worktree' && !store.supports('worktreePhotos'))));

  const close = () => {
    setVisible(false);
    setTimeout(() => (router.canGoBack() ? router.back() : router.replace('/')), 230);
  };

  const send = () => {
    if (!text.trim() || !target) return;
    haptic.commit();
    const words = text.trim();
    const pic = photo && photos ? photo : undefined;
    // The photo goes first (`put`), then the message names it: both after the sheet has closed.
    const make = (c: (files: string[]) => Call): Call | (() => Promise<Call>) => (pic ? async () => c([await upload(pic)]) : c([]));
    const opts = pic ? { photo: true } : {};
    // Shown at once, confirmed by the Mac (lib/sends.ts): a message in its conversation, a start on its own screen.
    let href: string;
    if (target.kind === 'conv' || target.kind === 'mac') {
      sends.message(target.topic, words, make((files) => calls.send(target.topic, words, files)), opts);
      href = convHref(target.topic);
    } else {
      const kind = target.kind === 'friend' ? 'friend' : how;
      const call =
        target.kind === 'friend'
          ? make(() => calls.askPerson(target.id, target.name, words))
          : how === 'worktree'
            ? make((files) => (files.length ? calls.startWorktreeWith(target.id, words, planFirst, files) : calls.startWorktree(target.id, words, planFirst)))
            : how === 'plan'
              ? make(() => calls.createPlan(target.id, words))
              : make((files) => calls.ask(target.id, words, files));
      const id = sends.start({ kind, label: target.label, target: keyOf(target), ...(target.kind === 'project' ? { project: target.label, ...(target.icon ? { icon: target.icon } : {}) } : {}), ...(kind === 'worktree' && planFirst ? { plan: true } : {}) }, words, call, opts);
      href = `/starting/${id}`;
    }
    setVisible(false);
    setTimeout(() => {
      (router.canGoBack() ? router.back() : router.replace('/'));
      setTimeout(() => router.push(href as never), 60);
    }, 200);
  };

  const mark = (t: Target, size: number) => (t.kind === 'friend' ? <Avatar name={t.name} size={size} /> : t.kind === 'project' ? <ProjectMark name={t.label} icon={t.icon} size={size} /> : t.kind === 'conv' && t.project ? <ProjectMark name={t.project} icon={t.icon} size={size} /> : <IconBadge Icon={ICON[t.kind].Icon} tone={ICON[t.kind].tone} size={size} />);
  const groups: { title: string; kind: Target['kind'] }[] = [
    // Your Mac is its own row, first: no heading over it.
    { title: '', kind: 'mac' },
    { title: 'New in a project', kind: 'project' },
    { title: 'Add to a conversation', kind: 'conv' },
    { title: "A friend's Claude", kind: 'friend' },
  ];

  return (
    <>
      <Sheet visible={visible} onDismiss={close}>
        <View style={{ paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <T v="title" style={{ flex: 1, fontSize: 22 }}>
            Ask your Mac
          </T>
          <Press onPress={close} accessibilityLabel="Close" hitSlop={10} style={{ width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: color.sunken }}>
            <X color={color.text2} size={17} />
          </Press>
        </View>

        {picking ? (
          <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(120)}>
            <ScrollView style={{ maxHeight: 380 }} contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 8 }}>
              {groups.map((g) => {
                const list = targets.filter((t) => t.kind === g.kind);
                if (!list.length) return null;
                return (
                  <View key={g.kind} style={{ marginTop: 8 }}>
                    {g.title ? (
                      <T v="eyebrow" style={{ paddingHorizontal: 10, marginBottom: 4 }}>
                        {g.title}
                      </T>
                    ) : null}
                    {list.map((t) => (
                      <Press
                        key={keyOf(t)}
                        scaleTo={0.98}
                        onPress={() => {
                          setSel(keyOf(t));
                          setPicking(false);
                        }}
                        style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 9, paddingHorizontal: 10, borderRadius: 14, backgroundColor: keyOf(t) === sel ? color.sunken : 'transparent' }}
                      >
                        {mark(t, 32)}
                        <T v="body" numberOfLines={1} style={{ flex: 1 }}>
                          {t.label}
                        </T>
                      </Press>
                    ))}
                  </View>
                );
              })}
            </ScrollView>
          </Animated.View>
        ) : (
          <View>
            <View style={{ paddingHorizontal: 20, paddingTop: 10 }}>
              <TextInput
                autoFocus
                value={text}
                onChangeText={setText}
                multiline
                placeholder={target?.kind === 'friend' ? `What should ${target.name}'s Claude do?` : target?.kind === 'project' && modes ? MODES.find((m) => m.mode === how)!.hint : target?.kind === 'mac' ? 'Take a screenshot and send it to me' : 'Run the tests and send me a screenshot'}
                placeholderTextColor={color.text3}
                style={{ color: color.text, fontSize: 19, lineHeight: 26, minHeight: 92, maxHeight: 200, textAlignVertical: 'top', ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}) }}
              />
              {photo ? (
                <Animated.View entering={ZoomIn.duration(220)} exiting={ZoomOut.duration(150)} style={{ width: 80, height: 80, borderRadius: 16, overflow: 'hidden', marginTop: 6 }}>
                  <Image source={{ uri: photo.uri }} style={{ flex: 1 }} contentFit="cover" />
                  <Press onPress={() => setPhoto(undefined)} accessibilityLabel="Remove photo" style={{ position: 'absolute', top: 4, right: 4, width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: color.card }}>
                    <X color={color.text2} size={13} />
                  </Press>
                </Animated.View>
              ) : null}
              <VoiceLine state={voice.state} error={voice.error} />
            </View>
            {target?.kind === 'project' && modes ? <ModeChips mode={mode} onMode={setMode} /> : null}
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4, gap: 10 }}>
              <Press onPress={() => setPicking(true)} accessibilityLabel="Where it goes" style={{ flexShrink: 1, flexDirection: 'row', alignItems: 'center', gap: 8, height: 44, paddingLeft: 6, paddingRight: 12, borderRadius: 22, backgroundColor: color.sunken }}>
                {target ? mark(target, 32) : null}
                <T v="callout" c={color.text} numberOfLines={1} style={{ fontWeight: '600', flexShrink: 1 }}>
                  {target?.label ?? 'Where'}
                </T>
                <ChevronDown color={color.text2} size={16} />
              </Press>
              {target?.kind === 'project' && modes && how === 'worktree' ? <PlanFirst on={planFirst} onChange={setPlanFirst} /> : null}
              {!photos ? null : (
              <Press onPress={async () => setPhoto((await pickPhoto().catch(() => undefined)) ?? photo)} accessibilityLabel="Add a photo" style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: color.sunken }}>
                <ImagePlus color={color.text2} size={20} />
              </Press>
              )}
              <View style={{ flex: 1 }} />
              {voiceAvailable() ? <MicButton state={voice.state} onStart={() => (haptic.tap(), void voice.start())} onStop={() => (haptic.commit(), voice.stop())} /> : null}
              <Press disabled={!text.trim()} onPress={send} accessibilityLabel="Send" style={{ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: text.trim() ? color.primary : color.sunken }}>
                <ArrowUp color={text.trim() ? color.onPrimary : color.text3} size={22} strokeWidth={2.6} />
              </Press>
            </View>
          </View>
        )}
      </Sheet>
    </>
  );
}

/** The microphone: tap to listen, tap again to write it down; it swells with your voice. */
function MicButton({ state, onStart, onStop }: { readonly state: VoiceState; readonly onStart: () => void; readonly onStop: () => void }) {
  const level = state.kind === 'listening' ? state.level : 0;
  const pulse = useAnimatedStyle(() => ({ transform: [{ scale: withSpring(1 + level * 0.18, spring.bouncy) }] }));
  const listening = state.kind === 'listening';
  const busy = state.kind === 'getting' || state.kind === 'writing';
  return (
    <Animated.View style={pulse}>
      <Press
        onPress={listening ? onStop : onStart}
        disabled={busy}
        accessibilityLabel={listening ? 'Stop and write it down' : 'Speak instead of typing'}
        accessibilityHint={listening ? undefined : 'Written down on this phone; nothing you say leaves it'}
        style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: listening ? toneBg('rose') : busy ? toneBg('sky') : color.sunken }}
      >
        {busy ? <ActivityIndicator size="small" color={toneInk('sky')} /> : listening ? <Square color={toneInk('rose')} fill={toneInk('rose')} size={13} /> : <Mic color={color.text2} size={20} />}
      </Press>
    </Animated.View>
  );
}

/** One quiet line under the field while the microphone does something (or couldn't). */
function VoiceLine({ state, error }: { readonly state: VoiceState; readonly error?: string }) {
  const line =
    state.kind === 'getting'
      ? `Getting the voice model · ${Math.round(state.progress * 100)}% of ${MODEL_MB} MB, once`
      : state.kind === 'listening'
        ? 'Listening… tap ■ to write it down'
        : state.kind === 'writing'
          ? 'Writing it down on this phone…'
          : error;
  if (!line) return null;
  return (
    <Animated.View entering={FadeIn.duration(160)} exiting={FadeOut.duration(120)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: 6 }}>
      <Mic color={error && state.kind === 'off' ? toneInk('rose') : color.text3} size={12} />
      <T v="caption" numberOfLines={2} style={{ flex: 1 }}>
        {line}
      </T>
    </Animated.View>
  );
}

/** A project's three ways in, as icon chips (as the Mac's project home offers them). */
function ModeChips({ mode, onMode }: { readonly mode: Mode; readonly onMode: (m: Mode) => void }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 10 }}>
      {MODES.map((m) => {
        const on = m.mode === mode;
        return (
          <Press
            key={m.mode}
            onPress={() => (haptic.tap(), onMode(m.mode))}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            accessibilityLabel={m.label}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 34, paddingHorizontal: 10, borderRadius: 17, backgroundColor: on ? toneBg(m.tone) : color.sunken }}
          >
            <m.Icon color={on ? toneInk(m.tone) : color.text2} size={15} strokeWidth={2.3} />
            <T v="caption" c={on ? toneInk(m.tone) : color.text2} style={{ fontWeight: '700' }}>
              {m.label}
            </T>
          </Press>
        );
      })}
    </View>
  );
}

/** Plan mode for a new worktree: its Claude plans first and asks you to approve (the Mac's Plan chip). */
function PlanFirst({ on, onChange }: { readonly on: boolean; readonly onChange: (on: boolean) => void }) {
  return (
    <Press
      onPress={() => (haptic.tap(), onChange(!on))}
      accessibilityRole="switch"
      accessibilityState={{ checked: on }}
      accessibilityLabel="Plan mode: Claude plans first"
      style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 44, paddingHorizontal: 13, borderRadius: 22, backgroundColor: on ? toneBg('lavender') : color.sunken }}
    >
      <ListChecks color={on ? toneInk('lavender') : color.text2} size={17} strokeWidth={2.3} />
      <T v="caption" c={on ? toneInk('lavender') : color.text2} style={{ fontWeight: '700' }}>
        Plan first
      </T>
    </Press>
  );
}
