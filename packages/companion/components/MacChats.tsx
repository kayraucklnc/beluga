import { router } from 'expo-router';
import { Check, Laptop, Plus, Trash2 } from 'lucide-react-native';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useView } from '../lib/hooks';
import { calls } from '../lib/link/calls';
import type { ConvSummary, HomeView, Topic } from '../lib/link/protocol';
import { store } from '../lib/store';
import { color } from '../lib/theme';
import { convHref, StepTicker, statusIcon } from './Conv';
import { Options } from './Options';
import { Sheet } from './Sheet';
import { haptic, IconBadge, Pill, Press, T } from './ui';

/**
 * Your Mac's chats on the phone (1.14, BLG-102's tabs): every one in the Mac's tab order, New chat
 * on top, and a chat deleted for good after asking. Opening one here doesn't move the Mac's tab.
 */

/** A new empty chat on your Mac (its tab opens there too), opened here. */
export function newMacChat(open: (href: string) => void = (h) => router.push(h as never)): void {
  haptic.commit();
  void store.call<string>(calls.newMacChat(), { queue: false }).then(
    (id) => {
      if (id) open(convHref(calls.macChatTopic(id)));
    },
    (e: Error) => store.toast({ text: e.message, tone: 'error' }),
  );
}

/** Delete a chat for good (its run stops; its messages, files and Claude transcript go). */
export function deleteMacChat(topic: Topic, after?: () => void): void {
  haptic.commit();
  void store.call(calls.deleteMacChat(topic), { queue: false }).then(
    () => after?.(),
    (e: Error) => store.toast({ text: e.message, tone: 'error' }),
  );
}

/** "Delete this chat?": one rose row, as everything that can't be undone asks first. */
export function DeleteMacChat({ topic, title, onClose, after }: { readonly topic: Topic | undefined; readonly title?: string | undefined; readonly onClose: () => void; readonly after?: (() => void) | undefined }) {
  return (
    <Options
      visible={Boolean(topic)}
      onClose={onClose}
      title="This can’t be undone"
      options={topic ? [{ Icon: Trash2, label: title ? `Delete “${title}”` : 'Delete this chat', sub: 'Its messages and files go for good, here and on your Mac', tone: 'rose', onPress: () => deleteMacChat(topic, after) }] : []}
    />
  );
}

export function MacChatsSheet({ visible, onClose, current }: { readonly visible: boolean; readonly onClose: () => void; /** The chat on screen now: ticked, and another one replaces it rather than stacks. */ readonly current?: Topic }) {
  const home = useView<HomeView>('home');
  const chats = home?.data.macChats ?? [];
  const [deleting, setDeleting] = useState<ConvSummary | undefined>();
  const open = (href: string) => (current ? router.replace(href as never) : router.push(href as never));
  const pick = (c: ConvSummary) => {
    onClose();
    if (c.topic !== current) setTimeout(() => open(convHref(c.topic)), 180);
  };
  return (
    <>
      <Sheet
        visible={visible}
        onDismiss={onClose}
        header={
          <View style={{ paddingHorizontal: 20, paddingBottom: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <IconBadge Icon={Laptop} tone="sky" size={32} />
            <View style={{ flex: 1 }}>
              <T v="title" style={{ fontSize: 20 }}>
                Your Mac’s chats
              </T>
              <T v="caption">The same chats as the tabs on your Mac</T>
            </View>
          </View>
        }
      >
        <ScrollView contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 20 }}>
          <Press
            scaleTo={0.98}
            onPress={() => {
              onClose();
              setTimeout(() => newMacChat(open), 180);
            }}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 11, paddingHorizontal: 10, borderRadius: 16 }}
          >
            <IconBadge Icon={Plus} tone="sky" size={38} />
            <T v="body" style={{ flex: 1, fontWeight: '600' }}>
              New chat
            </T>
          </Press>
          {chats.map((c) => (
            <ChatRow key={c.topic} c={c} current={c.topic === current} onPress={() => pick(c)} onLongPress={() => setDeleting(c)} />
          ))}
          {chats.length ? (
            <T v="caption" style={{ paddingHorizontal: 10, paddingTop: 10 }}>
              Long-press a chat to delete it.
            </T>
          ) : null}
        </ScrollView>
      </Sheet>
      <DeleteMacChat topic={deleting?.topic} title={deleting?.title} onClose={() => setDeleting(undefined)} after={deleting && deleting.topic === current ? () => (router.canGoBack() ? router.back() : router.replace('/' as never)) : undefined} />
    </>
  );
}

function ChatRow({ c, current, onPress, onLongPress }: { readonly c: ConvSummary; readonly current: boolean; readonly onPress: () => void; readonly onLongPress: () => void }) {
  const st = statusIcon(c.needsYou ? 'waiting' : c.status);
  return (
    <Press scaleTo={0.98} onPress={onPress} onLongPress={onLongPress} delayLongPress={350} style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 10, paddingHorizontal: 10, borderRadius: 16, backgroundColor: current ? color.sunken : undefined }}>
      <IconBadge Icon={st.Icon} tone={st.tone} size={38} />
      <View style={{ flex: 1 }}>
        <T v="body" numberOfLines={1} style={{ fontWeight: '500' }}>
          {c.title}
        </T>
        {c.status === 'working' ? (
          <StepTicker step={c.last ?? 'Working'} size={12.5} />
        ) : (
          <T v="caption" numberOfLines={1}>
            {c.last ?? 'Nothing asked yet'}
          </T>
        )}
      </View>
      {c.unread ? <Pill label={String(c.unread)} tone="sky" /> : null}
      {current ? <Check color={color.text2} size={18} /> : null}
    </Press>
  );
}
