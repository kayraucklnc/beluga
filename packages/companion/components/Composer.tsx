import { ArrowUp, Square } from 'lucide-react-native';
import { useState } from 'react';
import { Platform, TextInput, View } from 'react-native';
import Animated, { useAnimatedStyle, withSpring, ZoomIn, ZoomOut } from 'react-native-reanimated';
import { color, spring, tint } from '../lib/theme';
import { Card, haptic, Press, T } from './ui';

/**
 * Write to your Mac: a field that grows with what you write, and one button that is Send (when
 * there's something to send) or Stop (rose, while Claude works and the field is empty).
 */
export function Composer({ placeholder, onSend, onStop, working, disabled, bottom = 0, left }: { readonly placeholder: string; readonly onSend: (text: string) => void; readonly onStop?: () => void; readonly working?: boolean; readonly disabled?: string; readonly bottom?: number; readonly left?: React.ReactNode }) {
  const [text, setText] = useState('');
  const [h, setH] = useState(22);
  const can = text.trim().length > 0;
  const stop = working && !can && onStop;
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
  const send = () => {
    if (!can) return;
    haptic.commit();
    onSend(text.trim());
    setText('');
    setH(22);
  };
  return (
    <View style={{ paddingHorizontal: 12, paddingBottom: bottom + 10, paddingTop: 8 }}>
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
              send();
            }
          }}
        />
        <Animated.View style={btn}>
          {stop ? (
            <Animated.View key="stop" entering={ZoomIn.springify()} exiting={ZoomOut.duration(120)}>
              <Press onPress={() => (haptic.commit(), onStop?.())} accessibilityLabel="Stop" style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: tint.rose }}>
                <Square color={color.error} fill={color.error} size={13} />
              </Press>
            </Animated.View>
          ) : (
            <Animated.View key="send" entering={ZoomIn.springify()} exiting={ZoomOut.duration(120)}>
              <Press onPress={send} disabled={!can} accessibilityLabel="Send" style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: can ? color.primary : color.sunken }}>
                <ArrowUp color={can ? color.onPrimary : color.text3} size={20} strokeWidth={2.6} />
              </Press>
            </Animated.View>
          )}
        </Animated.View>
      </Card>
    </View>
  );
}
