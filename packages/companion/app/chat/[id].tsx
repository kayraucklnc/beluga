import { useLocalSearchParams } from 'expo-router';
import { ImagePlus, Sparkles } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import Animated, { FadeInUp, LinearTransition } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Composer } from '../../components/Composer';
import { Thumb } from '../../components/Outputs';
import { Header, Screen } from '../../components/Screen';
import { Avatar, Press, T } from '../../components/ui';
import { ago, useView } from '../../lib/hooks';
import { calls } from '../../lib/link/calls';
import type { ChatMessageView, ChatView, OutputView, Topic } from '../../lib/link/protocol';
import { pickPhoto, upload } from '../../lib/pick';
import { store } from '../../lib/store';
import { color, ink, tint } from '../../lib/theme';

/** A chat with friends: messages, photos and files both ways, and Ask Claude. */
export default function Chat() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const topic = `chat:${decodeURIComponent(id ?? '')}` as Topic;
  const view = useView<ChatView>(topic);
  const c = view?.data;
  const insets = useSafeAreaInsets();
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const [askClaude, setAskClaude] = useState(false);
  const pics: OutputView[] = c?.messages.flatMap((m) => (m.files ?? []).filter((f) => f.kind === 'image')) ?? [];

  useEffect(() => {
    if (c) void store.call(calls.read(topic), { queue: false }).catch(() => undefined);
  }, [c?.messages.length]);

  const sendPhoto = async () => {
    const photo = await pickPhoto().catch(() => undefined);
    if (!photo) return;
    store.toast({ text: `Sending ${photo.name}…`, tone: 'info' });
    try {
      const ref = await upload(photo);
      await store.call(calls.chat(topic, '', { files: [ref] }));
    } catch (e) {
      store.toast({ text: `Couldn't send the photo: ${(e as Error).message}`, tone: 'error' });
    }
  };

  return (
    <Screen>
      <Header back title={c?.name ?? 'Chat'} eyebrow={c?.kind === 'group' ? 'Channel' : c?.live.length ? 'Here now' : 'Direct message'} at={view?.at} />
      <KeyboardAvoidingView behavior={Platform.OS === 'web' ? undefined : 'padding'} style={{ flex: 1 }}>
        <ScrollView ref={scroll} onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })} contentContainerStyle={{ padding: 14, gap: 6 }}>
          {c?.messages.map((m, i) => {
            const prev = c.messages[i - 1];
            const firstOfRun = !prev || prev.from !== m.from || m.ts - prev.ts > 10 * 60_000;
            return (
              <Animated.View key={m.id} entering={i > c.messages.length - 3 ? FadeInUp.springify().stiffness(220).damping(22) : undefined} layout={LinearTransition.springify()}>
                <Bubble m={m} first={firstOfRun} group={c.kind === 'group'} pics={pics} />
              </Animated.View>
            );
          })}
        </ScrollView>
        {askClaude ? (
          <View style={{ paddingHorizontal: 20, paddingBottom: 2 }}>
            <T v="caption" c={color.claude}>
              Asking {c?.kind === 'dm' ? `${c.name}'s` : "everyone's"} Claude
            </T>
          </View>
        ) : null}
        <Composer
          placeholder={askClaude ? 'Ask Claude…' : `Message ${c?.name ?? ''}`}
          bottom={insets.bottom}
          onSend={(text) => {
            void store.call(calls.chat(topic, text, { askClaude }));
            setAskClaude(false);
          }}
          left={
            <View style={{ flexDirection: 'row', gap: 2 }}>
              <Press onPress={() => void sendPhoto()} accessibilityLabel="Send a photo" style={{ width: 38, height: 40, alignItems: 'center', justifyContent: 'center' }}>
                <ImagePlus color={color.text2} size={21} />
              </Press>
              <Press onPress={() => setAskClaude((a) => !a)} accessibilityLabel="Ask Claude" style={{ width: 38, height: 40, alignItems: 'center', justifyContent: 'center' }}>
                <View style={{ width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: askClaude ? tint.peach : 'transparent' }}>
                  <Sparkles color={askClaude ? ink.peach : color.text2} size={20} />
                </View>
              </Press>
            </View>
          }
        />
      </KeyboardAvoidingView>
    </Screen>
  );
}

function Bubble({ m, first, group, pics }: { m: ChatMessageView; first: boolean; group: boolean; pics: OutputView[] }) {
  const mine = m.mine;
  const files = m.files ?? [];
  return (
    <View style={{ flexDirection: 'row', justifyContent: mine ? 'flex-end' : 'flex-start', gap: 8, marginTop: first ? 10 : 0 }}>
      {!mine ? <View style={{ width: 30 }}>{first ? <Avatar name={m.from} size={30} claude={m.claude} /> : null}</View> : null}
      <View style={{ maxWidth: '78%', alignItems: mine ? 'flex-end' : 'flex-start', gap: 4 }}>
        {!mine && first && (group || m.claude) ? (
          <T v="caption" c={m.claude ? color.claude : color.text2} style={{ fontWeight: '700', marginLeft: 4 }}>
            {m.from}
          </T>
        ) : null}
        {files.map((f) => (
          <Thumb key={f.ref} o={f} group={pics} w={f.kind === 'image' ? 220 : 200} h={f.kind === 'image' ? 170 : 92} style={{ borderRadius: 18 }} />
        ))}
        {m.text ? (
          <View
            style={{
              paddingVertical: 9,
              paddingHorizontal: 13,
              borderRadius: 19,
              borderBottomRightRadius: mine ? 6 : 19,
              borderBottomLeftRadius: mine ? 19 : 6,
              backgroundColor: mine ? tint.sky : m.claude ? tint.peach : color.card,
              borderWidth: mine || m.claude ? 0 : 0.5,
              borderColor: color.hairline,
            }}
          >
            <T v="body" c={mine ? ink.sky : m.claude ? ink.peach : color.text} style={{ fontSize: 15.5 }}>
              {m.text}
            </T>
          </View>
        ) : null}
        {first ? (
          <T v="caption" style={{ marginHorizontal: 4, fontSize: 11 }}>
            {ago(m.ts)}
          </T>
        ) : null}
      </View>
    </View>
  );
}
