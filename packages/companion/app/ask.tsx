import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { ArrowUp, ChevronDown, Folder, ImagePlus, MessageSquare, Sparkles, X } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, TextInput, View } from 'react-native';
import Animated, { FadeIn, FadeOut, ZoomIn, ZoomOut } from 'react-native-reanimated';
import { convHref } from '../components/Conv';
import { Sheet } from '../components/Sheet';
import { Avatar, haptic, IconBadge, Press, T, type Tone } from '../components/ui';
import { useView } from '../lib/hooks';
import { type Call, calls } from '../lib/link/calls';
import type { HomeView, PeopleView, Topic, WorkView } from '../lib/link/protocol';
import { pickPhoto, upload } from '../lib/pick';
import { store } from '../lib/store';
import { color } from '../lib/theme';

/**
 * The Ask button's sheet: write, (attach a photo), send. Where it goes is one pill: tap it to
 * pick a project, an open conversation, or a friend's Claude. The answer comes back into that
 * conversation, which opens.
 */
type Target = { kind: 'project'; id: string; label: string } | { kind: 'conv'; topic: Topic; label: string } | { kind: 'friend'; id: string; name: string; label: string };
const ICON: Record<Target['kind'], { Icon: typeof Folder; tone: Tone }> = { project: { Icon: Folder, tone: 'butter' }, conv: { Icon: MessageSquare, tone: 'sky' }, friend: { Icon: Sparkles, tone: 'lavender' } };

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

  const targets = useMemo<Target[]>(() => {
    const t: Target[] = [];
    // Only your own projects take a new chat: not the room, a friend's shared project or "Asked of
    // friends" (views.ts groups those under 'room', 'shared:…' and 'asked').
    for (const p of work?.data.projects ?? []) if (p.id !== 'room' && p.id !== 'asked' && !p.id.startsWith('shared:')) t.push({ kind: 'project', id: p.id, label: p.name });
    for (const c of home?.data.running ?? []) t.push({ kind: 'conv', topic: c.topic, label: c.title });
    for (const p of people?.data.people ?? []) if (p.presence !== 'offline') t.push({ kind: 'friend', id: p.peerId, name: p.name, label: `${p.name}'s Claude` });
    return t;
  }, [work, home, people]);
  const [sel, setSel] = useState<string | undefined>();
  const keyOf = (t: Target): string => (t.kind === 'conv' ? t.topic : `${t.kind}:${t.id}`);
  useEffect(() => {
    // Wait for the list the default comes from (projects, unless aimed at a friend or a conversation).
    if (sel || !targets.length || (!params.friend && !params.topic && !work)) return;
    const want = params.friend ? targets.find((t) => t.kind === 'friend' && t.id === params.friend) : params.topic ? targets.find((t) => t.kind === 'conv' && t.topic === params.topic) : targets.find((t) => t.kind === 'project');
    setSel(keyOf(want ?? targets[0]!));
  }, [targets]);
  const target = targets.find((t) => keyOf(t) === sel);

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
      if (photo && target.kind !== 'friend') files = [await upload(photo)];
    } catch (e) {
      store.toast({ text: `The photo didn't go: ${(e as Error).message}`, tone: 'error' });
      setBusy(false);
      return;
    }
    const call: Call = target.kind === 'conv' ? calls.send(target.topic, words, files) : target.kind === 'project' ? calls.ask(target.id, words, files) : calls.askPerson(target.id, target.name, words);
    const r = await store.call<{ topic?: Topic }>(call).catch((e: Error) => (store.toast({ text: e.message, tone: 'error' }), undefined));
    setBusy(false);
    setVisible(false);
    const topic = r?.topic ?? (target.kind === 'conv' ? target.topic : undefined);
    setTimeout(() => {
      router.back();
      if (topic) setTimeout(() => router.push(convHref(topic)), 60);
    }, 220);
  };

  const mark = (t: Target, size: number) => (t.kind === 'friend' ? <Avatar name={t.name} size={size} /> : <IconBadge Icon={ICON[t.kind].Icon} tone={ICON[t.kind].tone} size={size} />);
  const groups: { title: string; kind: Target['kind'] }[] = [
    { title: 'New in a project', kind: 'project' },
    { title: 'Add to a conversation', kind: 'conv' },
    { title: "A friend's Claude", kind: 'friend' },
  ];

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
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
                    <T v="eyebrow" style={{ paddingHorizontal: 10, marginBottom: 4 }}>
                      {g.title}
                    </T>
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
                placeholder={target?.kind === 'friend' ? `What should ${target.name}'s Claude do?` : 'Run the tests and send me a screenshot'}
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
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4, gap: 10 }}>
              <Press onPress={() => setPicking(true)} accessibilityLabel="Where it goes" style={{ flexShrink: 1, flexDirection: 'row', alignItems: 'center', gap: 8, height: 44, paddingLeft: 6, paddingRight: 12, borderRadius: 22, backgroundColor: color.sunken }}>
                {target ? mark(target, 32) : null}
                <T v="callout" c={color.text} numberOfLines={1} style={{ fontWeight: '600', flexShrink: 1 }}>
                  {target?.label ?? 'Where'}
                </T>
                <ChevronDown color={color.text2} size={16} />
              </Press>
              {target?.kind === 'friend' ? null : (
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
    </KeyboardAvoidingView>
  );
}
