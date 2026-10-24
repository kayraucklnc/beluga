import { useEffect, useRef } from 'react';
import { Platform, Pressable, TextInput, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withSequence, withSpring, withTiming } from 'react-native-reanimated';
import { color, spring, tint, type } from '../lib/theme';
import { haptic } from './ui';

/**
 * The pairing code as twelve boxes in three groups (K7QM-4XPA-R2TD). One hidden field takes the
 * typing, so the caret moves on by itself, Backspace steps back, and a pasted code (with or
 * without dashes) fills every box at once. `onDone` fires when all twelve are in.
 */
export const CODE_LENGTH = 12;
export const cleanCode = (raw: string): string => raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH);

export function CodeBoxes({ value, onChange, onDone, autoFocus = true, error }: { readonly value: string; readonly onChange: (v: string) => void; readonly onDone: (v: string) => void; readonly autoFocus?: boolean; readonly error?: boolean }) {
  const input = useRef<React.ComponentRef<typeof TextInput>>(null);
  const shake = useSharedValue(0);
  useEffect(() => {
    if (error) shake.value = withSequence(withTiming(-8, { duration: 50 }), withRepeat(withTiming(8, { duration: 80 }), 3, true), withSpring(0, spring.snappy));
  }, [error]);
  const row = useAnimatedStyle(() => ({ transform: [{ translateX: shake.value }] }));
  return (
    <Pressable onPress={() => input.current?.focus()} accessibilityLabel="Pairing code">
      <Animated.View style={[{ flexDirection: 'row', justifyContent: 'center', gap: 10 }, row]}>
        {[0, 1, 2].map((g) => (
          <View key={g} style={{ flexDirection: 'row', gap: 4 }}>
            {[0, 1, 2, 3].map((k) => {
              const i = g * 4 + k;
              return <Box key={k} ch={value[i]} active={i === Math.min(value.length, CODE_LENGTH - 1) && value.length < CODE_LENGTH} filled={i < value.length} />;
            })}
          </View>
        ))}
      </Animated.View>
      <TextInput
        ref={input}
        value={value}
        autoFocus={autoFocus}
        autoCapitalize="characters"
        autoCorrect={false}
        autoComplete="one-time-code"
        textContentType="oneTimeCode"
        keyboardType={Platform.OS === 'android' ? 'visible-password' : 'default'}
        maxLength={CODE_LENGTH + 2}
        caretHidden
        onChangeText={(t) => {
          const v = cleanCode(t);
          if (v.length > value.length) haptic.tap();
          onChange(v);
          if (v.length === CODE_LENGTH) onDone(v);
        }}
        style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, opacity: 0.01, color: 'transparent' }}
      />
    </Pressable>
  );
}

function Box({ ch, active, filled }: { ch?: string; active: boolean; filled: boolean }) {
  const p = useSharedValue(filled ? 1 : 0);
  useEffect(() => {
    p.value = withSpring(filled ? 1 : 0, spring.bouncy);
  }, [filled]);
  const letter = useAnimatedStyle(() => ({ opacity: p.value, transform: [{ scale: 0.6 + 0.4 * p.value }] }));
  return (
    <View style={{ width: 24, height: 36, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: active ? tint.sky : filled ? color.card : color.sunken, borderWidth: active ? 1.5 : 0, borderColor: color.info }}>
      <Animated.Text style={[{ ...type.heading, fontSize: 17, color: color.text, fontVariant: ['tabular-nums'] }, letter]}>{ch ?? ''}</Animated.Text>
    </View>
  );
}
