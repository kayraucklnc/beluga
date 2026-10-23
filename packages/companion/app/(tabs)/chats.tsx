import { router } from 'expo-router';
import { Hash } from 'lucide-react-native';
import { ScrollView, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { chatHref } from '../../components/Conv';
import { Header, Screen } from '../../components/Screen';
import { Avatar, Card, Hairline, IconBadge, Press, T } from '../../components/ui';
import { ago, useView } from '../../lib/hooks';
import type { ChatsView } from '../../lib/link/protocol';
import { color, ink, TAB_BAR_H, tint } from '../../lib/theme';

/** Chats: your friends' DMs and channels, as on the Mac. */
export default function Chats() {
  const insets = useSafeAreaInsets();
  const view = useView<ChatsView>('chats');
  const chats = view?.data.chats ?? [];
  return (
    <Screen>
      <Header title="Chats" at={view?.at} />
      <ScrollView contentContainerStyle={{ paddingTop: 8, paddingBottom: TAB_BAR_H + insets.bottom + 40 }}>
        {!chats.length ? (
          <T v="callout" style={{ paddingHorizontal: 20 }}>
            {view ? 'No chats yet. Friends you add on your Mac show up here.' : 'Loading chats…'}
          </T>
        ) : (
          <Card style={{ marginHorizontal: 16 }}>
            {chats.map((c, i) => (
              <Animated.View key={c.topic} entering={FadeInDown.delay(i * 40).duration(280)}>
                {i ? <Hairline style={{ marginLeft: 72 }} /> : null}
                <Press scaleTo={0.985} onPress={() => router.push(chatHref(c.topic))} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 }}>
                  {c.kind === 'group' ? <IconBadge Icon={Hash} tone="sky" size={44} square /> : <Avatar name={c.name} size={44} />}
                  <View style={{ flex: 1, gap: 2 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <T v="body" numberOfLines={1} style={{ flex: 1, fontWeight: c.unread ? '700' : '500' }}>
                        {c.name}
                      </T>
                      <T v="caption">{ago(c.lastAt)}</T>
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <T v="callout" numberOfLines={1} style={{ flex: 1 }} c={c.unread ? color.text : color.text2}>
                        {c.last}
                      </T>
                      {c.unread ? (
                        <View style={{ minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 6, backgroundColor: tint.sky, alignItems: 'center', justifyContent: 'center' }}>
                          <T v="caption" c={ink.sky} style={{ fontWeight: '800', fontSize: 11 }}>
                            {c.unread}
                          </T>
                        </View>
                      ) : null}
                    </View>
                  </View>
                </Press>
              </Animated.View>
            ))}
          </Card>
        )}
      </ScrollView>
    </Screen>
  );
}
