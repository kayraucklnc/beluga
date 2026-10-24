import { Image } from 'expo-image';
import { ProjectMark } from '../components/ProjectMark';
import { router, useLocalSearchParams } from 'expo-router';
import { ArrowUp, ChevronDown, Folder, GitBranch, ImagePlus, Laptop, ListChecks, MessageCircleQuestion, MessageSquare, Sparkles, Workflow, X } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { Platform, ScrollView, TextInput, View } from 'react-native';
import Animated, { FadeIn, FadeOut, ZoomIn, ZoomOut } from 'react-native-reanimated';
import { convHref } from '../components/Conv';
import { Sheet } from '../components/Sheet';
import { Avatar, haptic, IconBadge, Press, T, type Tone, toneBg, toneInk } from '../components/ui';
import { useView } from '../lib/hooks';
import { type Call, calls } from '../lib/link/calls';
import type { HomeView, PeopleView, Topic, WorkView } from '../lib/link/protocol';
import { pickPhoto, upload } from '../lib/pick';
import { store } from '../lib/store';
import { color } from '../lib/theme';

/**
 * The Ask button's sheet: write, (attach a photo), send. Where it goes is one pill: tap it to
 * pick Your Mac (first, and the default: your Claude for the whole Mac), a project, an open
 * conversation, or a friend's Claude. The answer comes back into that conversation, which opens.
 *
 * In a project (1.5) it's what the Mac's project home offers, as three icon chips: a new worktree
 * with Claude on your words (the default; Plan mode beside it makes Claude plan first), a plan
 * Claude drafts for you to approve, or a question (a read-only chat in its main folder).
 */
type Target = { kind: 'mac'; topic: Topic; label: string } | { kind: 'project'; id: string; label: string; icon?: string } | { kind: 'conv'; topic: Topic; label: string; project?: string; icon?: string } | { kind: 'friend'; id: string; name: string; label: string };
const ICON: Record<Target['kind'], { Icon: typeof Folder; tone: Tone }> = { mac: { Icon: Laptop, tone: 'sky' }, project: { Icon: Folder, tone: 'butter' }, conv: { Icon: MessageSquare, tone: 'sky' }, friend: { Icon: Sparkles, tone: 'lavender' } };
const ASSISTANT: Topic = 'conv:mac:assistant';

/** How a project takes your words (BLG-69). */
type Mode = 'worktree' | 'plan' | 'question';
const MODES: ReadonlyArray<{ mode: Mode; label: string; Icon: typeof Folder; tone: Tone; hint: string }> = [
  { mode: 'worktree', label: 'Worktree', Icon: GitBranch, tone: 'mint', hint: 'Fix the login redirect and add a test' },
  { mode: 'plan', label: 'Plan', Icon: Workflow, tone: 'butter', hint: 'Add sign-in with passkeys, in milestones' },
  { mode: 'question', label: 'Question', Icon: MessageCircleQuestion, tone: 'sky', hint: 'How does the payment flow work?' },
];

export default function Ask() {
  const params = useLocalSearchParams<{ friend?: string; topic?: string }>();
  const [visible, setVisible] = useState(true);
  const work = useView<WorkView>('work');
  const home = useView<HomeView>('home');
  const people = useView<PeopleView>('people');
  const [text, setText] = useState('');
  const [photo, setPhoto] = useState<{ name: string; mime: string; b64: string; uri: string } | undefined>();
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [mode, setMode] = useState<Mode>('worktree');
  const [planFirst, setPlanFirst] = useState(false);
  // An older Mac (before 1.5) has neither Your Mac nor worktrees and plans from here.
  const modes = store.supports('askModes');

  const targets = useMemo<Target[]>(() => {
    const t: Target[] = [];
    if (store.supports('assistant')) t.push({ kind: 'mac', topic: ASSISTANT, label: 'Your Mac' });
    // Only your own projects take a new chat: not the room, a friend's shared project or "Asked of
    // friends" (views.ts groups those under 'room', 'shared:…' and 'asked').
    for (const p of work?.data.projects ?? []) if (p.id !== 'room' && p.id !== 'asked' && !p.id.startsWith('shared:')) t.push({ kind: 'project', id: p.id, label: p.name, ...(p.icon ? { icon: p.icon } : {}) });
    for (const c of home?.data.running ?? []) if (c.topic !== ASSISTANT) t.push({ kind: 'conv', topic: c.topic, label: c.title, ...(c.project ? { project: c.project } : {}), ...(c.icon ? { icon: c.icon } : {}) });
    for (const p of people?.data.people ?? []) if (p.presence !== 'offline') t.push({ kind: 'friend', id: p.peerId, name: p.name, label: `${p.name}'s Claude` });
    return t;
  }, [work, home, people]);
  const [sel, setSel] = useState<string | undefined>();
  const keyOf = (t: Target): string => (t.kind === 'conv' || t.kind === 'mac' ? t.topic : `${t.kind}:${t.id}`);
  useEffect(() => {
    // Wait for the list the default comes from (projects, unless aimed at a friend or a conversation).
    if (sel || !targets.length || (!params.friend && !params.topic && !work)) return;
    const want = params.friend
      ? targets.find((t) => t.kind === 'friend' && t.id === params.friend)
      : params.topic
        ? targets.find((t) => (t.kind === 'conv' || t.kind === 'mac') && t.topic === params.topic)
        : (targets.find((t) => t.kind === 'mac') ?? targets.find((t) => t.kind === 'project'));
    setSel(keyOf(want ?? targets[0]!));
  }, [targets]);
  const target = targets.find((t) => keyOf(t) === sel);
  /** What a project does with your words: a worktree, a plan, a question (only a question before 1.5). */
  const how: Mode = target?.kind === 'project' && modes ? mode : 'question';
  // Photos go with a question or a message; a new worktree or plan starts from your words.
  const photos = target?.kind !== 'friend' && !(target?.kind === 'project' && how !== 'question');

  const close = () => {
    setVisible(false);
    setTimeout(() => router.back(), 230);
  };

  const send = async () => {
    if (!text.trim() || !target || busy) return;
    haptic.commit();
    setBusy(true);
    const words = text.trim();
    let files: string[] = [];
    try {
      // The photo goes first (`put`), then the message names it.
      if (photo && photos) files = [await upload(photo)];
    } catch (e) {
      store.toast({ text: `The photo didn't go: ${(e as Error).message}`, tone: 'error' });
      setBusy(false);
      return;
    }
    const call: Call =
      target.kind === 'conv' || target.kind === 'mac'
        ? calls.send(target.topic, words, files)
        : target.kind === 'friend'
          ? calls.askPerson(target.id, target.name, words)
          : how === 'worktree'
            ? calls.startWorktree(target.id, words, planFirst)
            : how === 'plan'
              ? calls.createPlan(target.id, words)
              : calls.ask(target.id, words, files);
    const r = await store.call<unknown>(call).catch((e: Error) => (store.toast({ text: e.message, tone: 'error' }), undefined));
    setBusy(false);
    setVisible(false);
    // Where to go: the conversation (a new worktree's by its id), or the plan's page.
    const back = r as { topic?: Topic; id?: string } | string | undefined;
    const href =
      target.kind === 'project' && how === 'worktree'
        ? typeof back === 'string' ? convHref(`conv:ws:${back}`) : undefined
        : target.kind === 'project' && how === 'plan'
          ? typeof back === 'object' && back?.id ? `/plan/${encodeURIComponent(back.id)}` : undefined
          : (typeof back === 'object' && back?.topic) || target.kind === 'conv' || target.kind === 'mac'
            ? convHref((typeof back === 'object' && back?.topic) || (target as { topic: Topic }).topic)
            : undefined;
    setTimeout(() => {
      router.back();
      if (href) setTimeout(() => router.push(href as never), 60);
    }, 220);
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
              <Press disabled={!text.trim() || busy} onPress={() => void send()} accessibilityLabel="Send" style={{ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: text.trim() ? color.primary : color.sunken }}>
                <ArrowUp color={text.trim() ? color.onPrimary : color.text3} size={22} strokeWidth={2.6} />
              </Press>
            </View>
          </View>
        )}
      </Sheet>
    </>
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
            style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 34, paddingHorizontal: 12, borderRadius: 17, backgroundColor: on ? toneBg(m.tone) : color.sunken }}
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
