import { ArrowUp, Clock, ListPlus, Navigation, Square, X } from 'lucide-react-native';
import { useState } from 'react';
import { Platform, TextInput, View } from 'react-native';
import Animated, { FadeInDown, FadeOutUp, LinearTransition, useAnimatedStyle, withSpring, ZoomIn, ZoomOut } from 'react-native-reanimated';
import { color, ink, spring, tint } from '../lib/theme';
import { Card, haptic, Press, T } from './ui';

/**
 * Write to your Mac: a field that grows with what you write, and one button that is Send (when
 * there's something to send) or Stop (rose, while Claude works and the field is empty). While
 * Claude works, what you write can Steer it now or Queue for after (the Mac's composer: ⌥↩
 * steers), and what's queued shows above the field.
 */

/** Your messages waiting for Claude here: steer with one now, or take it out. */
export function QueueTray({ queue, onSteer, onRemove }: { readonly queue: readonly { id: string; text: string }[]; readonly onSteer: (id: string) => void; readonly onRemove: (id: string) => void }) {
  if (!queue.length) return null;
  return (
    <Animated.View entering={FadeInDown.duration(240)} exiting={FadeOutUp.duration(160)} layout={LinearTransition.springify()}>
      <Card r={20} style={{ paddingVertical: 6, paddingHorizontal: 6, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, paddingTop: 4, paddingBottom: 2 }}>
          <Clock color={color.text3} size={13} />
          <T v="caption" style={{ fontWeight: '600', flex: 1 }}>
            Queued · {queue.length}
          </T>
          <T v="caption">after what Claude is doing</T>
        </View>
        {queue.map((q, i) => (
          <Animated.View key={q.id} entering={FadeInDown.duration(220)} exiting={FadeOutUp.duration(140)} layout={LinearTransition.springify()} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 8, paddingVertical: 2 }}>
            <View style={{ width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: color.sunken }}>
              <T v="caption" style={{ fontSize: 11, fontWeight: '700' }}>
                {i + 1}
              </T>
            </View>
            <T v="callout" c={color.text} numberOfLines={1} style={{ flex: 1 }}>
              {q.text}
            </T>
            <Press onPress={() => (haptic.commit(), onSteer(q.id))} accessibilityLabel="Steer with it now" style={{ height: 30, paddingHorizontal: 10, borderRadius: 15, justifyContent: 'center', backgroundColor: tint.sky }}>
              <T v="caption" c={ink.sky} style={{ fontWeight: '700' }}>
                Steer
              </T>
            </Press>
            <Press onPress={() => onRemove(q.id)} accessibilityLabel="Remove from the queue" hitSlop={6} style={{ width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: color.sunken }}>
              <X color={color.text2} size={14} />
            </Press>
          </Animated.View>
        ))}
      </Card>
    </Animated.View>
  );
}
export function Composer({ placeholder, onSend, onStop, onSteer, working, disabled, bottom = 0, left, above }: { readonly placeholder: string; readonly onSend: (text: string) => void; readonly onStop?: () => void; /** While Claude works: Steer (now) beside Send, which then queues (after), as the Mac's composer. */ readonly onSteer?: (text: string) => void; readonly working?: boolean; readonly disabled?: string; readonly bottom?: number; readonly left?: React.ReactNode; /** Above the field: what's queued. */ readonly above?: React.ReactNode }) {
  const [text, setText] = useState('');
  const [h, setH] = useState(22);
  const can = text.trim().length > 0;
  const stop = working && !can && onStop;
  const split = Boolean(working && can && onSteer);
  const btn = useAnimatedStyle(() => ({ transform: [{ scale: withSpring(can || stop ? 1 : 0.86, spring.bouncy) }], opacity: withSpring(can || stop ? 1 : 0.45) }));
  if (disabled) {
    return (
      <View style={{ paddingHorizontal: 16, paddingBottom: bottom + 10, paddingTop: 8 }}>
        <Card r={22} style={{ padding: 14, alignItems: 'center' }}>
          <T v="callout">{disabled}</T>
        </Card>
      </View>
    );
  }
  const send = (steer = false) => {
    if (!can) return;
    haptic.commit();
    if (steer && onSteer) onSteer(text.trim());
    else onSend(text.trim());
    setText('');
    setH(22);
  };
  return (
    <View style={{ paddingHorizontal: 12, paddingBottom: bottom + 10, paddingTop: 8, gap: 8 }}>
      {above}
      <Card r={26} style={{ flexDirection: 'row', alignItems: 'flex-end', paddingLeft: left ? 6 : 16, paddingRight: 6, paddingVertical: 6, gap: 6 }}>
        {left}
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={placeholder}
          placeholderTextColor={color.text3}
          multiline
          onContentSizeChange={(e) => setH(Math.min(120, Math.max(22, e.nativeEvent.contentSize.height)))}
          style={{ flex: 1, color: color.text, fontSize: 16, lineHeight: 21, minHeight: 22, height: Platform.OS === 'web' ? h : undefined, maxHeight: 120, paddingVertical: 9, ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}) }}
          onKeyPress={(e) => {
            // On the web, Enter sends (Shift+Enter is a new line).
            const ne = e.nativeEvent as unknown as { key: string; shiftKey?: boolean };
            if (Platform.OS === 'web' && ne.key === 'Enter' && !ne.shiftKey) {
              (e as unknown as { preventDefault(): void }).preventDefault();
              // ⌥↩ steers, as on the Mac.
              send((ne as { altKey?: boolean }).altKey === true);
            }
          }}
        />
        {split ? (
          <Animated.View key="split" entering={ZoomIn.springify()} exiting={ZoomOut.duration(120)} style={{ flexDirection: 'row', gap: 6 }}>
            <Press onPress={() => send(true)} accessibilityLabel="Steer: Claude reads this now" style={{ flexDirection: 'row', alignItems: 'center', gap: 5, height: 40, paddingHorizontal: 12, borderRadius: 20, backgroundColor: tint.sky }}>
              <Navigation color={ink.sky} size={14} strokeWidth={2.4} />
              <T v="callout" c={ink.sky} style={{ fontWeight: '700' }}>
                Steer
              </T>
            </Press>
            <Press onPress={() => send(false)} accessibilityLabel="Queue: after what Claude is doing" style={{ flexDirection: 'row', alignItems: 'center', gap: 5, height: 40, paddingHorizontal: 12, borderRadius: 20, backgroundColor: color.primary }}>
              <ListPlus color={color.onPrimary} size={15} strokeWidth={2.4} />
              <T v="callout" c={color.onPrimary} style={{ fontWeight: '700' }}>
                Queue
              </T>
            </Press>
          </Animated.View>
        ) : (
        <Animated.View style={btn}>
          {stop ? (
            <Animated.View key="stop" entering={ZoomIn.springify()} exiting={ZoomOut.duration(120)}>
              <Press onPress={() => (haptic.commit(), onStop?.())} accessibilityLabel="Stop" style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: tint.rose }}>
                <Square color={color.error} fill={color.error} size={13} />
              </Press>
            </Animated.View>
          ) : (
            <Animated.View key="send" entering={ZoomIn.springify()} exiting={ZoomOut.duration(120)}>
              <Press onPress={() => send(false)} disabled={!can} accessibilityLabel="Send" style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: can ? color.primary : color.sunken }}>
                <ArrowUp color={can ? color.onPrimary : color.text3} size={20} strokeWidth={2.6} />
              </Press>
            </Animated.View>
          )}
        </Animated.View>
        )}
      </Card>
    </View>
  );
}
