import { type ReactNode, useEffect, useState } from 'react';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Animated, { interpolate, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';
import { color, spring } from '../lib/theme';


/**
 * A bottom sheet: springs up, dims what's behind, drags down to put away (a flick is enough).
 * Rendered over everything in its screen; the gesture runs on the UI thread.
 */
export function Sheet({ visible, onDismiss, children, header, maxHeight = 0.86 }: { readonly visible: boolean; readonly onDismiss: () => void; readonly children: ReactNode; /** The top part, which drags the sheet. */ readonly header?: ReactNode; readonly maxHeight?: number }) {
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [mounted, setMounted] = useState(visible);
  const y = useSharedValue(height);
  const drag = useSharedValue(0);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      drag.value = 0;
      y.value = withSpring(0, { stiffness: 300, damping: 32, mass: 0.9 });
    } else if (mounted) {
      y.value = withTiming(height, { duration: 240 }, () => scheduleOnRN(setMounted, false));
    }
  }, [visible]);

  const close = () => onDismiss();
  const pan = usePanGesture({
    activeOffsetY: 8,
    failOffsetX: [-20, 20],
    onUpdate: (e) => {
      'worklet';
      drag.value = Math.max(0, e.translationY) + Math.min(0, e.translationY) * 0.15;
    },
    onDeactivate: (e) => {
      'worklet';
      if (drag.value > 120 || e.velocityY > 900) {
        y.value = withTiming(height, { duration: 220 });
        scheduleOnRN(close);
      } else drag.value = withSpring(0, spring.bouncy);
    },
  });

  const sheet = useAnimatedStyle(() => ({ transform: [{ translateY: y.value + drag.value }] }));
  const dim = useAnimatedStyle(() => ({ opacity: interpolate(y.value + drag.value, [0, height * 0.6], [1, 0], 'clamp') }));
  if (!mounted) return null;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: color.scrim }, dim]}>
        <Pressable style={{ flex: 1 }} onPress={close} accessibilityLabel="Close" />
      </Animated.View>
      <Animated.View style={[{ position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: height * maxHeight }, sheet]}>
        <View style={{ borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingBottom: insets.bottom + 8, backgroundColor: color.card, maxHeight: height * maxHeight, overflow: 'hidden' }}>
          <GestureDetector gesture={pan}>
            <View>
              <View style={{ alignItems: 'center', paddingTop: 10, paddingBottom: 6 }}>
                <View style={{ width: 40, height: 5, borderRadius: 3, backgroundColor: color.hairlineStrong }} />
              </View>
              {header}
            </View>
          </GestureDetector>
          {children}
        </View>
      </Animated.View>
    </View>
  );
}
