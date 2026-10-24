import { useLocalSearchParams } from 'expo-router';
import { KeyboardLift } from '../../components/KeyboardLift';
import { ImagePlus, Sparkles, X } from 'lucide-react-native';
import { AskClaudePicker, type AskTarget, askTargets } from '../../components/AskClaudePicker';
import { useEffect, useRef, useState } from 'react';
import { Platform, ScrollView, View } from 'react-native';
import Animated, { FadeInUp, LinearTransition } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Composer } from '../../components/Composer';
import { SendStatus } from '../../components/SendStatus';
import { Thumb } from '../../components/Outputs';
import { TaskWords } from '../../components/render/TaskChip';
import { Header, Screen, useScrolled } from '../../components/Screen';
import { Avatar, Press, T } from '../../components/ui';
import { ago, useView } from '../../lib/hooks';
import { calls } from '../../lib/link/calls';
import type { ChatMessageView, ChatView, OutputView, Topic } from '../../lib/link/protocol';
import { pickPhoto, upload } from '../../lib/pick';
import { sends, useSends } from '../../lib/sends';
import { store } from '../../lib/store';
import { color, ink, tint } from '../../lib/theme';

/** A chat with friends: messages, photos and files both ways, and Ask Claude. */
export default function Chat() {
  const { scrolled, onScroll } = useScrolled();
  const { id } = useLocalSearchParams<{ id: string }>();
  const topic = `chat:${decodeURIComponent(id ?? '')}` as Topic;
  const view = useView<ChatView>(topic);
  const c = view?.data;
  const insets = useSafeAreaInsets();
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const [ask, setAsk] = useState<AskTarget | undefined>();
  const [picking, setPicking] = useState(false);
  /** What you sent that the Mac's view doesn't show yet. */
  const pending = useSends(topic);
  const targets = askTargets(c?.members, c?.kind ?? 'dm', c?.name ?? '');
  const pics: OutputView[] = c?.messages.flatMap((m) => (m.files ?? []).filter((f) => f.kind === 'image')) ?? [];

  useEffect(() => {
    if (c) void store.call(calls.read(topic), { queue: false }).catch(() => undefined);
  }, [c?.messages.length]);

  const sendPhoto = async () => {
    const photo = await pickPhoto().catch(() => undefined);
    if (!photo) return;
    // Shown at once as yours; it goes up, then the message names it (lib/sends.ts).
    sends.message(topic, '', async () => calls.chat(topic, '', { files: [await upload(photo)] }), { photo: true });
  };

  return (
    <Screen>
      <Header scrolled={scrolled} back title={c?.name ?? 'Chat'} eyebrow={c?.kind === 'group' ? 'Channel' : c?.live.length ? 'Here now' : 'Direct message'} at={view?.at} />
      <KeyboardLift>
        <ScrollView onScroll={onScroll} scrollEventThrottle={32} ref={scroll} onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })} contentContainerStyle={{ padding: 14, gap: 6 }}>
          {c?.messages.map((m, i) => {
            const prev = c.messages[i - 1];
            const firstOfRun = !prev || prev.from !== m.from || m.ts - prev.ts > 10 * 60_000;
            return (
              <Animated.View key={m.id} entering={i > c.messages.length - 3 ? FadeInUp.springify().stiffness(220).damping(22) : undefined} layout={LinearTransition.springify()}>
                <Bubble m={m} first={firstOfRun} group={c.kind === 'group'} pics={pics} />
              </Animated.View>
            );
          })}
          {pending.map((p) => (
            <Animated.View key={p.id} entering={FadeInUp.springify().stiffness(220).damping(22)} layout={LinearTransition.springify()} style={{ alignItems: 'flex-end', marginTop: 6 }}>
              <View style={{ maxWidth: '78%', paddingVertical: 9, paddingHorizontal: 13, borderRadius: 19, borderBottomRightRadius: 6, backgroundColor: tint.sky, opacity: p.state === 'failed' ? 1 : 0.6, borderWidth: p.state === 'failed' ? 1 : 0, borderColor: color.error }}>
                <T v="body" c={ink.sky} style={{ fontSize: 15.5 }}>
                  {p.text || 'Photo'}
                </T>
              </View>
              <SendStatus s={p} />
            </Animated.View>
          ))}
        </ScrollView>
        {ask ? (
          <Animated.View entering={FadeInUp.duration(180)} style={{ flexDirection: 'row', paddingHorizontal: 16, paddingBottom: 2 }}>
            <Press onPress={() => setPicking(true)} accessibilityLabel={`Ask: ${ask.label}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 30, paddingLeft: 10, paddingRight: 4, borderRadius: 15, backgroundColor: tint.peach }}>
              <Sparkles color={ink.peach} size={14} />
              <T v="caption" c={ink.peach} style={{ fontWeight: '700' }}>
                Ask: {ask.label}
              </T>
              <Press onPress={() => setAsk(undefined)} accessibilityLabel="Don't ask Claude" hitSlop={8} style={{ width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center' }}>
                <X color={ink.peach} size={14} />
              </Press>
            </Press>
          </Animated.View>
        ) : null}
        <Composer
          placeholder={ask ? `Ask ${ask.label}…` : `Message ${c?.name ?? ''}`}
          bottom={insets.bottom}
          onSend={(text) => {
            sends.message(topic, text, calls.chat(topic, text, ask ? { ask: ask.ask } : {}));
            setAsk(undefined);
          }}
          left={
            <View style={{ flexDirection: 'row', gap: 2 }}>
              <Press onPress={() => void sendPhoto()} accessibilityLabel="Send a photo" style={{ width: 38, height: 40, alignItems: 'center', justifyContent: 'center' }}>
                <ImagePlus color={color.text2} size={21} />
              </Press>
              <Press onPress={() => setPicking(true)} accessibilityLabel="Ask Claude" style={{ width: 38, height: 40, alignItems: 'center', justifyContent: 'center' }}>
                <View style={{ width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: ask ? tint.peach : 'transparent' }}>
                  <Sparkles color={ask ? ink.peach : color.text2} size={20} />
                </View>
              </Press>
            </View>
          }
        />
      </KeyboardLift>
      <AskClaudePicker visible={picking} onClose={() => setPicking(false)} targets={targets} chosen={ask} onPick={setAsk} members={c?.members} />
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
              {/* Task keys as chips in your own messages only: a friend's key may be on their board (BLG-109). */}
              {mine ? <TaskWords text={m.text} /> : m.text}
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
