import { Image } from 'expo-image';
import { StatusBar } from 'expo-status-bar';
import { router } from 'expo-router';
import { X } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, useWindowDimensions, View } from 'react-native';
import { GestureDetector, usePanGesture, usePinchGesture, useSimultaneousGestures, useTapGesture, useExclusiveGestures } from 'react-native-gesture-handler';
import Animated, { interpolate, type SharedValue, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';
import { haptic, Press, T } from '../components/ui';
import { useFile } from '../lib/hooks';
import type { OutputView } from '../lib/link/protocol';
import { store } from '../lib/store';
import { color } from '../lib/theme';

/**
 * Pictures, full screen: they open from where they were (the thumbnail grows into place), pinch
 * to zoom, double-tap for 2×, swipe sideways between them, swipe down to put back. The thumbnail
 * shows at once; the full image replaces it when it has come. All gestures run on the UI thread.
 */
const SPRING = { stiffness: 260, damping: 28, mass: 0.9 };

export default function Viewer() {
  const { width: W, height: H } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { items, index: start, origin } = store.gallery;
  const [index, setIndex] = useState(start);
  const [chrome, setChrome] = useState(true);

  const open = useSharedValue(0); // 0: at the thumbnail, 1: full screen
  const page = useSharedValue(-start * W);
  const dragY = useSharedValue(0);
  const scale = useSharedValue(1);
  const baseScale = useSharedValue(1);
  const panX = useSharedValue(0);
  const panY = useSharedValue(0);
  const baseX = useSharedValue(0);
  const baseY = useSharedValue(0);
  const startPage = useSharedValue(0);
  const mode = useSharedValue<0 | 1 | 2 | 3>(0); // 0 none, 1 paging, 2 dismissing, 3 panning a zoomed image

  useEffect(() => {
    open.value = withSpring(1, SPRING);
  }, []);

  const close = () => {
    haptic.tap();
    router.back();
  };
  const dismiss = () => {
    'worklet';
    dragY.value = withTiming(0, { duration: 260 });
    open.value = withTiming(0, { duration: 260 }, () => scheduleOnRN(close));
  };
  const go = (i: number) => {
    setIndex(i);
    haptic.tap();
  };

  const pinch = usePinchGesture({
    onUpdate: (e) => {
      'worklet';
      scale.value = Math.max(0.8, Math.min(5, baseScale.value * e.scale));
    },
    onDeactivate: () => {
      'worklet';
      if (scale.value < 1) {
        scale.value = withSpring(1, SPRING);
        panX.value = withSpring(0, SPRING);
        panY.value = withSpring(0, SPRING);
      }
      baseScale.value = Math.max(1, scale.value);
    },
  });

  const pan = usePanGesture({
    onActivate: () => {
      'worklet';
      startPage.value = page.value;
      baseX.value = panX.value;
      baseY.value = panY.value;
      mode.value = 0;
    },
    onUpdate: (e) => {
      'worklet';
      if (mode.value === 0) {
        if (scale.value > 1.01) mode.value = 3;
        else if (Math.abs(e.translationX) > Math.abs(e.translationY)) mode.value = 1;
        else mode.value = 2;
      }
      if (mode.value === 3) {
        panX.value = baseX.value + e.translationX;
        panY.value = baseY.value + e.translationY;
      } else if (mode.value === 1) {
        const edge = (startPage.value === 0 && e.translationX > 0) || (startPage.value === -(items.length - 1) * W && e.translationX < 0);
        page.value = startPage.value + e.translationX * (edge ? 0.3 : 1);
      } else {
        dragY.value = e.translationY;
      }
    },
    onDeactivate: (e) => {
      'worklet';
      if (mode.value === 1) {
        const cur = -startPage.value / W;
        let next = cur;
        if (e.translationX < -W * 0.22 || e.velocityX < -600) next = Math.min(items.length - 1, cur + 1);
        else if (e.translationX > W * 0.22 || e.velocityX > 600) next = Math.max(0, cur - 1);
        page.value = withSpring(-next * W, { ...SPRING, velocity: e.velocityX });
        if (next !== cur) scheduleOnRN(go, next);
      } else if (mode.value === 2) {
        if (dragY.value > 110 || e.velocityY > 900) dismiss();
        else dragY.value = withSpring(0, SPRING);
      } else if (mode.value === 3) {
        // Keep the zoomed picture from leaving the screen entirely.
        const maxX = (W * (scale.value - 1)) / 2;
        const maxY = (H * (scale.value - 1)) / 2;
        panX.value = withSpring(Math.max(-maxX, Math.min(maxX, panX.value)), SPRING);
        panY.value = withSpring(Math.max(-maxY, Math.min(maxY, panY.value)), SPRING);
      }
      mode.value = 0;
    },
  });

  const toggle = () => setChrome((c) => !c);
  const doubleTap = useTapGesture({
    numberOfTaps: 2,
    onActivate: (e) => {
      'worklet';
      if (scale.value > 1.01) {
        scale.value = withSpring(1, SPRING);
        panX.value = withSpring(0, SPRING);
        panY.value = withSpring(0, SPRING);
        baseScale.value = 1;
      } else {
        scale.value = withSpring(2.2, SPRING);
        baseScale.value = 2.2;
        panX.value = withSpring((W / 2 - e.x) * 1.2, SPRING);
        panY.value = withSpring((H / 2 - e.y) * 1.2, SPRING);
      }
    },
  });
  const singleTap = useTapGesture({
    onActivate: () => {
      'worklet';
      scheduleOnRN(toggle);
    },
  });
  const taps = useExclusiveGestures(doubleTap, singleTap);
  const gesture = useSimultaneousGestures(pinch, pan, taps);

  // Each page resets its zoom when you leave it.
  useEffect(() => {
    scale.value = withTiming(1);
    baseScale.value = 1;
    panX.value = withTiming(0);
    panY.value = withTiming(0);
  }, [index]);

  const bg = useAnimatedStyle(() => ({ opacity: open.value * interpolate(dragY.value, [0, H * 0.5], [1, 0.2], 'clamp') }));
  const strip = useAnimatedStyle(() => ({ transform: [{ translateX: page.value }] }));
  const top = useAnimatedStyle(() => ({ opacity: open.value * interpolate(dragY.value, [0, 120], [1, 0], 'clamp') }));

  if (!items.length) {
    return (
      <View style={{ flex: 1, backgroundColor: color.stage, alignItems: 'center', justifyContent: 'center' }}>
        <Press onPress={() => router.back()}>
          <T v="callout">Nothing to show</T>
        </Press>
      </View>
    );
  }

  return (
    <View style={StyleSheet.absoluteFill}>
      {/* The stage is dark in both themes: light status bar content over it. */}
      <StatusBar style="light" />
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: color.stage }, bg]} />
      <GestureDetector gesture={gesture}>
        <Animated.View style={[{ flexDirection: 'row', width: W * items.length, height: H }, strip]}>
          {items.map((o, i) => (
            <Page key={o.ref} o={o} i={i} active={i === index} first={i === start} W={W} H={H} top={insets.top + 64} bottom={insets.bottom + 44} origin={i === start ? origin : undefined} open={open} dragY={dragY} scale={scale} panX={panX} panY={panY} />
          ))}
        </Animated.View>
      </GestureDetector>
      {chrome ? (
        <Animated.View pointerEvents="box-none" style={[{ position: 'absolute', top: 0, left: 0, right: 0, paddingTop: insets.top + 12, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 12 }, top]}>
          <Press onPress={close} accessibilityLabel="Close" style={{ width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: color.onStageChip }}>
            <X color={color.onStage} size={20} />
          </Press>
          <View style={{ flexShrink: 1, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 14, backgroundColor: color.onStageChip }}>
            <T v="callout" c={color.onStage} numberOfLines={1} style={{ fontWeight: '600' }}>
              {items[index]?.name}
            </T>
            {items.length > 1 ? <T v="caption" c={color.onStageDim}>{index + 1} of {items.length}</T> : null}
          </View>
        </Animated.View>
      ) : null}
      {items.length > 1 && chrome ? (
        <Animated.View pointerEvents="none" style={[{ position: 'absolute', bottom: insets.bottom + 22, left: 0, right: 0, flexDirection: 'row', justifyContent: 'center', gap: 6 }, top]}>
          {items.map((o, i) => (
            <View key={o.ref} style={{ width: i === index ? 18 : 6, height: 6, borderRadius: 3, backgroundColor: i === index ? color.onStage : color.onStageDim }} />
          ))}
        </Animated.View>
      ) : null}
    </View>
  );
}

function Page({ o, active, first, W, H, top, bottom, origin, open, dragY, scale, panX, panY }: { o: OutputView; i: number; active: boolean; first: boolean; W: number; H: number; /** Kept clear for the status bar and the controls. */ top: number; bottom: number; origin?: { x: number; y: number; w: number; h: number }; open: SharedValue<number>; dragY: SharedValue<number>; scale: SharedValue<number>; panX: SharedValue<number>; panY: SharedValue<number> }) {
  const thumb = useFile(o.ref, 'thumb');
  const full = useFile(active ? o.ref : undefined, 'full');
  const [ratio, setRatio] = useState(origin ? origin.w / origin.h : 0.75);
  // The picture fitted to the screen.
  // Fitted between the top controls (under the status bar) and the page dots: never under either.
  const room = H - top - bottom;
  const fitW = Math.min(W, room * ratio);
  const fitH = fitW / ratio;
  const fx = (W - fitW) / 2;
  const fy = top + (room - fitH) / 2;
  const from = first && origin ? origin : { x: fx + fitW * 0.1, y: fy + fitH * 0.1, w: fitW * 0.8, h: fitH * 0.8 };

  const frame = useAnimatedStyle(() => {
    const p = open.value;
    const d = active ? dragY.value : 0;
    const shrink = interpolate(d, [0, H], [1, 0.55], 'clamp');
    const w = from.w + (fitW - from.w) * p;
    const h = from.h + (fitH - from.h) * p;
    const x = from.x + (fx - from.x) * p;
    const y = from.y + (fy - from.y) * p;
    const s = active ? scale.value : 1;
    return {
      position: 'absolute',
      left: x,
      top: y,
      width: w,
      height: h,
      borderRadius: (1 - p) * 14 + interpolate(d, [0, 200], [0, 18], 'clamp'),
      overflow: 'hidden',
      transform: [{ translateX: active ? panX.value : 0 }, { translateY: (active ? panY.value : 0) + d * 0.9 }, { scale: s * shrink }],
    };
  });
  const uri = full?.uri ?? thumb?.uri;
  return (
    <View style={{ width: W, height: H }}>
      <Animated.View style={frame}>
        {uri ? (
          <Image
            source={{ uri }}
            style={{ width: '100%', height: '100%' }}
            contentFit="contain"
            transition={full?.uri ? 220 : 0}
            onLoad={(e) => {
              const { width, height } = e.source;
              if (width && height && Math.abs(width / height - ratio) > 0.01) setRatio(width / height);
            }}
          />
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator color={color.onStageDim} />
          </View>
        )}
      </Animated.View>
      {active && !full?.uri && thumb?.uri ? (
        <View pointerEvents="none" style={{ position: 'absolute', bottom: 64, alignSelf: 'center', flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <ActivityIndicator color={color.onStageDim} size="small" />
          <T v="caption" c={color.onStageDim}>Getting the full picture</T>
        </View>
      ) : null}
    </View>
  );
}
