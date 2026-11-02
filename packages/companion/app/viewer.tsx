import { Image } from 'expo-image';
import { StatusBar } from 'expo-status-bar';
import { router, useFocusEffect } from 'expo-router';
import { ArrowUpRight, Download, FileJson, FileText, FileType, Film, Monitor, RotateCw, ScrollText, X } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { GestureDetector, usePanGesture, usePinchGesture, useSimultaneousGestures, useTapGesture } from 'react-native-gesture-handler';
import Animated, { Easing, interpolate, type SharedValue, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';
import { isText, sizeOf } from '../components/Outputs';
import { VideoPage } from '../components/VideoPage';
import { haptic, Press, T } from '../components/ui';
import { useFile, useSaving } from '../lib/hooks';
import { progressOf, progressText } from '../lib/pieces';
import { saveOutput } from '../lib/saved';
import type { OutputView } from '../lib/link/protocol';
import { store } from '../lib/store';
import { color, type } from '../lib/theme';

/**
 * Outputs, full screen, one page each: everything in the list you opened it from (Home's strip,
 * a conversation, a sub-agent's grid), starting at the one you tapped. Pictures pinch to zoom and
 * double-tap for 2× (GIFs animate); videos show their first frame and stream when you tap play
 * (components/VideoPage.tsx); text files show their first lines with Open (the reader). Swipe sideways
 * between pages, swipe down to put it back.
 *
 * One pan does all three moves, so they never fight: at scale 1 it decides on its first movement
 * (sideways pages, down dismisses); zoomed, it pans the picture, and only what goes past the
 * picture's edge moves the pages. The taps fail as soon as a finger moves, so they never hold
 * the pan back. All of it runs on the UI thread.
 *
 * Save (top right, BLG-123) puts the page's picture, video or file on the phone (lib/saved.ts).
 */
const SPRING = { stiffness: 260, damping: 28, mass: 0.9 };
/** Pages kept rendered either side of the one shown (full images load only for these). */
const NEAR = 1;
const MAX_DOTS = 9;

export default function Viewer() {
  const { width: W, height: H } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { items, index: start, origin, topic } = store.gallery;
  const n = items.length;
  const [index, setIndex] = useState(start);
  const [chrome, setChrome] = useState(true);
  // On top: light status bar over the stage, and the controls back (the tap on Open hid them).
  // Under the reader, the status bar is the reader's again.
  const [focused, setFocused] = useState(true);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      setChrome(true);
      return () => setFocused(false);
    }, []),
  );

  const open = useSharedValue(0); // 0: at the thumbnail, 1: full screen
  const page = useSharedValue(-start * W);
  const at = useSharedValue(start); // the page shown, for the worklets
  const dragY = useSharedValue(0);
  const scale = useSharedValue(1);
  const baseScale = useSharedValue(1);
  const panX = useSharedValue(0);
  const panY = useSharedValue(0);
  const baseX = useSharedValue(0);
  const baseY = useSharedValue(0);
  const startPage = useSharedValue(0);
  const spill = useSharedValue(0); // a zoomed pan that went past the picture's edge, in px
  const fitW = useSharedValue(W); // the shown picture's size at scale 1
  const fitH = useSharedValue(H);
  const zoomable = useSharedValue(items[start]?.kind === 'image' ? 1 : 0);
  const mode = useSharedValue<0 | 1 | 2 | 3>(0); // 0 undecided, 1 paging, 2 dismissing, 3 panning a zoomed picture
  // A video playing: the swipes and taps stand aside so its controls get every touch.
  const free = useSharedValue(true);
  const engage = (on: boolean) => {
    free.value = !on;
    if (on) setChrome(true);
  };

  useEffect(() => {
    // Timed, not sprung: a spring can come to rest a hair short of 1, and the stage would let the
    // screen behind show through faintly.
    open.value = withTiming(1, { duration: 320, easing: Easing.out(Easing.cubic) });
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
  const edge = () => haptic.commit();

  /** Spring to page `next` (or back to the current one), from the pan's release. */
  const settle = (cur: number, dx: number, vx: number) => {
    'worklet';
    let next = cur;
    if (dx < -W * 0.2 || vx < -600) next = cur + 1;
    else if (dx > W * 0.2 || vx > 600) next = cur - 1;
    if (next < 0 || next > n - 1) {
      // Past the first or the last: it springs back, and you feel the end.
      next = cur;
      if (Math.abs(dx) > W * 0.12) scheduleOnRN(edge);
    }
    page.value = withSpring(-next * W, { ...SPRING, velocity: vx, overshootClamping: true });
    if (next !== cur) {
      at.value = next;
      scheduleOnRN(go, next);
    }
  };

  const pinch = usePinchGesture({
    enabled: free,
    onUpdate: (e) => {
      'worklet';
      if (!zoomable.value || mode.value === 1 || mode.value === 2) return;
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
    enabled: free,
    minDistance: 8,
    onActivate: () => {
      'worklet';
      startPage.value = -at.value * W;
      baseX.value = panX.value;
      baseY.value = panY.value;
      spill.value = 0;
      mode.value = 0;
    },
    onUpdate: (e) => {
      'worklet';
      // Two fingers: a pinch, never a page turn or a dismiss.
      if (mode.value === 0 && e.numberOfPointers > 1) mode.value = 3;
      if (mode.value === 0) {
        // The first update can come before the finger has moved at all (0, 0): decide on real movement,
        // or a sideways swipe is taken for a dismiss (the bug that kept the pages from turning).
        if (scale.value <= 1.01 && Math.max(Math.abs(e.translationX), Math.abs(e.translationY)) < 6) return;
        if (scale.value > 1.01) mode.value = 3;
        else if (Math.abs(e.translationX) > Math.abs(e.translationY)) mode.value = 1;
        else mode.value = 2;
      }
      if (mode.value === 3) {
        // Pan the picture inside its edges; what goes past an edge sideways moves the pages.
        const maxX = Math.max(0, (fitW.value * scale.value - W) / 2);
        const maxY = Math.max(0, (fitH.value * scale.value - H) / 2);
        const wantX = baseX.value + e.translationX;
        const x = Math.max(-maxX, Math.min(maxX, wantX));
        panX.value = x;
        panY.value = Math.max(-maxY - 40, Math.min(maxY + 40, baseY.value + e.translationY));
        spill.value = e.numberOfPointers > 1 ? 0 : wantX - x;
        const end = (at.value === 0 && spill.value > 0) || (at.value === n - 1 && spill.value < 0);
        if (e.numberOfPointers > 1) {
          // Pinching at scale 1: the picture stays put.
          panX.value = scale.value > 1.01 ? x : 0;
          panY.value = scale.value > 1.01 ? panY.value : 0;
        }
        page.value = startPage.value + spill.value * (end ? 0.3 : 1);
      } else if (mode.value === 1) {
        const end = (at.value === 0 && e.translationX > 0) || (at.value === n - 1 && e.translationX < 0);
        page.value = startPage.value + e.translationX * (end ? 0.3 : 1);
      } else {
        dragY.value = e.translationY;
      }
    },
    onDeactivate: (e) => {
      'worklet';
      if (mode.value === 1) {
        settle(at.value, e.translationX, e.velocityX);
      } else if (mode.value === 2) {
        if (dragY.value > 110 || e.velocityY > 900) dismiss();
        else dragY.value = withSpring(0, SPRING);
      } else if (mode.value === 3) {
        if (spill.value !== 0) settle(at.value, spill.value, Math.sign(spill.value) === Math.sign(e.velocityX) ? e.velocityX : 0);
        const maxY = Math.max(0, (fitH.value * scale.value - H) / 2);
        panY.value = withSpring(Math.max(-maxY, Math.min(maxY, panY.value)), SPRING);
      }
      spill.value = 0;
      mode.value = 0;
    },
  });

  const shown = items[index];
  const saving = useSaving(shown?.ref);
  const busy = saving?.status === 'loading';
  const save = () => {
    if (!shown || busy) return;
    haptic.tap();
    void saveOutput(shown, topic);
  };

  const toggle = () => setChrome((c) => !c);
  const doubleTap = useTapGesture({
    enabled: free,
    numberOfTaps: 2,
    maxDistance: 20,
    onActivate: (e) => {
      'worklet';
      if (!zoomable.value) return;
      if (scale.value > 1.01) {
        scale.value = withSpring(1, SPRING);
        panX.value = withSpring(0, SPRING);
        panY.value = withSpring(0, SPRING);
        baseScale.value = 1;
      } else {
        const s = 2.2;
        scale.value = withSpring(s, SPRING);
        baseScale.value = s;
        const maxX = Math.max(0, (fitW.value * s - W) / 2);
        const maxY = Math.max(0, (fitH.value * s - H) / 2);
        // Zoom in on the spot you tapped (on the screen: the event's x is in the whole strip).
        const cy = insets.top + 64 + (H - insets.top - 64 - insets.bottom - 44) / 2;
        panX.value = withSpring(Math.max(-maxX, Math.min(maxX, (W / 2 - e.absoluteX) * (s - 1))), SPRING);
        panY.value = withSpring(Math.max(-maxY, Math.min(maxY, (cy - e.absoluteY) * (s - 1))), SPRING);
      }
    },
  });
  const singleTap = useTapGesture({
    enabled: free,
    maxDistance: 10,
    requireToFail: doubleTap,
    onActivate: () => {
      'worklet';
      scheduleOnRN(toggle);
    },
  });
  // Flat: the taps fail the moment a finger moves, so the pan is never held back by them.
  const gesture = useSimultaneousGestures(pinch, pan, doubleTap, singleTap);

  // Each page resets its zoom when you leave it.
  useEffect(() => {
    scale.value = withTiming(1);
    baseScale.value = 1;
    panX.value = withTiming(0);
    panY.value = withTiming(0);
    zoomable.value = items[index]?.kind === 'image' ? 1 : 0;
  }, [index]);

  const bg = useAnimatedStyle(() => ({ opacity: open.value * interpolate(dragY.value, [0, H * 0.5], [1, 0.2], 'clamp') }));
  const strip = useAnimatedStyle(() => ({ transform: [{ translateX: page.value }] }));
  const top = useAnimatedStyle(() => ({ opacity: open.value * interpolate(dragY.value, [0, 120], [1, 0], 'clamp') }));

  if (!n) {
    return (
      <View style={{ flex: 1, backgroundColor: color.stage, alignItems: 'center', justifyContent: 'center' }}>
        <Press onPress={() => router.back()}>
          <T v="callout" c={color.onStage}>
            Nothing to show
          </T>
        </Press>
      </View>
    );
  }

  const room = { top: insets.top + 64, bottom: insets.bottom + 44 };
  return (
    <View style={StyleSheet.absoluteFill}>
      {/* The stage is dark in both themes: light status bar content over it. */}
      {focused ? <StatusBar style="light" /> : null}
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: color.stage }, bg]} />
      <GestureDetector gesture={gesture}>
        <Animated.View style={[{ flexDirection: 'row', width: W * n, height: H }, strip]}>
          {items.map((o, i) =>
            Math.abs(i - index) <= NEAR + 1 ? (
              <Page key={o.ref} o={o} onEngage={engage} active={i === index} near={Math.abs(i - index) <= NEAR} first={i === start} W={W} H={H} top={room.top} bottom={room.bottom} origin={i === start ? origin : undefined} open={open} dragY={dragY} scale={scale} panX={panX} panY={panY} fitW={fitW} fitH={fitH} />
            ) : (
              <View key={o.ref} style={{ width: W, height: H }} />
            ),
          )}
        </Animated.View>
      </GestureDetector>
      {chrome ? (
        <Animated.View pointerEvents="box-none" style={[{ position: 'absolute', top: 0, left: 0, right: 0, paddingTop: insets.top + 12, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 12 }, top]}>
          <Press onPress={close} accessibilityLabel="Close" style={{ width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: color.onStageChip }}>
            <X color={color.onStage} size={20} />
          </Press>
          <View style={{ flexShrink: 1, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 14, backgroundColor: color.onStageChip }}>
            <T v="callout" c={color.onStage} numberOfLines={1} ellipsizeMode="middle" style={{ fontWeight: '600', flexShrink: 1 }}>
              {items[index]?.name}
            </T>
            {n > 1 ? (
              <T v="caption" c={color.onStageDim} style={{ fontVariant: ['tabular-nums'] }}>
                {index + 1} / {n}
              </T>
            ) : null}
          </View>
          <View style={{ flex: 1 }} />
          <Press onPress={save} disabled={busy} accessibilityLabel={`Save ${shown?.name ?? ''} to the phone`} style={{ width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: color.onStageChip }}>
            {busy ? <ActivityIndicator color={color.onStage} size="small" /> : <Download color={color.onStage} size={19} />}
          </Press>
        </Animated.View>
      ) : null}
      {busy && (saving?.size ?? 0) > 1024 * 1024 ? (
        <View pointerEvents="none" style={{ position: 'absolute', top: insets.top + 60, alignSelf: 'center', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, backgroundColor: color.onStageChip }}>
          <T v="caption" c={color.onStage} style={{ fontVariant: ['tabular-nums'] }}>
            {progressOf('Saving', saving?.got ?? 0, saving?.size)}
          </T>
        </View>
      ) : null}
      {n > 1 && n <= MAX_DOTS && chrome ? (
        <Animated.View pointerEvents="none" style={[{ position: 'absolute', bottom: insets.bottom + 22, left: 0, right: 0, flexDirection: 'row', justifyContent: 'center', gap: 6 }, top]}>
          {items.map((o, i) => (
            <View key={o.ref} style={{ width: i === index ? 18 : 6, height: 6, borderRadius: 3, backgroundColor: i === index ? color.onStage : color.onStageDim }} />
          ))}
        </Animated.View>
      ) : null}
    </View>
  );
}

type PageProps = {
  o: OutputView;
  onEngage: (on: boolean) => void;
  active: boolean;
  /** The page shown or a neighbour: full pictures load for these only. */
  near: boolean;
  first: boolean;
  W: number;
  H: number;
  /** Kept clear for the status bar and the controls. */
  top: number;
  bottom: number;
  origin?: { x: number; y: number; w: number; h: number };
  open: SharedValue<number>;
  dragY: SharedValue<number>;
  scale: SharedValue<number>;
  panX: SharedValue<number>;
  panY: SharedValue<number>;
  fitW: SharedValue<number>;
  fitH: SharedValue<number>;
};

function Page({ o, onEngage, active, near, first, W, H, top, bottom, origin, open, dragY, scale, panX, panY, fitW: shownW, fitH: shownH }: PageProps) {
  const image = o.kind === 'image';
  const video = o.kind === 'video';
  const thumb = useFile(image ? o.ref : undefined, 'thumb');
  // The full picture, in pieces (BLG-106); a GIF animates once it's all here.
  const full = useFile(image && near ? o.ref : undefined, 'full');
  const room = H - top - bottom;
  // A text page is a card of a fixed shape; a picture takes its own.
  const cardRatio = (W - 32) / Math.min(room, 620);
  const [ratio, setRatio] = useState(image || (video && origin) ? (origin ? origin.w / origin.h : 0.75) : video ? 16 / 9 : cardRatio);
  // Fitted between the top controls (under the status bar) and the page dots: never under either.
  const fitW = Math.min(image ? W : video ? W - 16 : W - 32, room * ratio);
  const fitH = fitW / ratio;
  const fx = (W - fitW) / 2;
  const fy = top + (room - fitH) / 2;
  const from = first && origin ? origin : { x: fx + fitW * 0.1, y: fy + fitH * 0.1, w: fitW * 0.8, h: fitH * 0.8 };

  useEffect(() => {
    if (!active) return;
    shownW.value = fitW;
    shownH.value = fitH;
  }, [active, fitW, fitH]);

  const frame = useAnimatedStyle(() => {
    const p = open.value;
    const d = active ? dragY.value : 0;
    const shrink = interpolate(d, [0, H], [1, 0.55], 'clamp');
    const s = active && image ? scale.value : 1;
    return {
      position: 'absolute',
      left: from.x + (fx - from.x) * p,
      top: from.y + (fy - from.y) * p,
      width: from.w + (fitW - from.w) * p,
      height: from.h + (fitH - from.h) * p,
      borderRadius: image ? (1 - p) * 14 + interpolate(d, [0, 200], [0, 18], 'clamp') : 22,
      overflow: 'hidden',
      transform: [{ translateX: active && image ? panX.value : 0 }, { translateY: (active && image ? panY.value : 0) + d * 0.9 }, { scale: s * shrink }],
    };
  });
  const uri = full?.uri ?? thumb?.uri;
  return (
    <View style={{ width: W, height: H }}>
      <Animated.View style={frame}>
        {video ? (
          <VideoPage o={o} active={active} onEngage={onEngage} onRatio={(r) => Math.abs(r - ratio) > 0.01 && setRatio(r)} />
        ) : !image ? (
          <FileCard o={o} active={active} />
        ) : uri ? (
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
      {active && image && !full?.uri && full?.status === 'error' ? (
        // Never an endless spinner (BLG-106): why, and Retry.
        <View style={{ position: 'absolute', bottom: bottom + 4, alignSelf: 'center', flexDirection: 'row', gap: 10, alignItems: 'center', paddingLeft: 14, paddingRight: 6, paddingVertical: 6, borderRadius: 20, backgroundColor: color.onStageChip }}>
          <T v="caption" c={color.onStage} numberOfLines={2} style={{ flexShrink: 1, maxWidth: W - 140 }}>
            {thumb?.uri ? 'This is the preview. ' : ''}
            {full.error ?? 'Couldn’t get the full picture.'}
          </T>
          <Press onPress={() => store.fetch(o.ref, 'full')} accessibilityLabel="Retry" style={{ height: 30, paddingHorizontal: 12, borderRadius: 15, flexDirection: 'row', gap: 6, alignItems: 'center', backgroundColor: color.onStage }}>
            <RotateCw color={color.stage} size={14} />
            <T v="caption" c={color.stage} style={{ fontWeight: '700' }}>
              Retry
            </T>
          </Press>
        </View>
      ) : active && image && !full?.uri && thumb?.uri ? (
        <View pointerEvents="none" style={{ position: 'absolute', bottom: bottom + 8, alignSelf: 'center', flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <ActivityIndicator color={color.onStageDim} size="small" />
          <T v="caption" c={color.onStageDim} style={{ fontVariant: ['tabular-nums'] }}>
            {progressText(full?.got ?? 0, full?.size)}
          </T>
        </View>
      ) : null}
    </View>
  );
}

const iconOf = (o: OutputView) => (o.kind === 'json' ? FileJson : o.kind === 'markdown' ? FileType : o.kind === 'video' ? Film : o.name.endsWith('.log') ? ScrollText : FileText);
const PREVIEW_LINES = 22;

/** A file that isn't a picture, as a page: its name, its first lines, and Open (the reader). */
function FileCard({ o, active }: { o: OutputView; active: boolean }) {
  const text = isText(o);
  // Only the page you're on fetches its text (the first piece is enough for a preview).
  const file = useFile(text && active ? o.ref : undefined, 'text');
  const lines = (file?.text ?? '').replace(/\n$/, '').split('\n');
  const shown = lines.slice(0, PREVIEW_LINES);
  const rest = lines.length - shown.length;
  const Icon = iconOf(o);
  const openIt = () => {
    haptic.tap();
    router.push({ pathname: '/reader', params: { ref: o.ref, name: o.name } });
  };
  return (
    <View style={{ flex: 1, backgroundColor: color.onStageCard, borderWidth: 1, borderColor: color.onStageLine, borderRadius: 22, padding: 18, gap: 14 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: color.onStageChip }}>
          <Icon color={color.onStage} size={20} />
        </View>
        <View style={{ flex: 1 }}>
          <T v="callout" c={color.onStage} numberOfLines={1} ellipsizeMode="middle" style={{ fontWeight: '600' }}>
            {o.name}
          </T>
          <T v="caption" c={color.onStageDim}>
            {[o.kind === 'markdown' ? 'Markdown' : o.kind === 'json' ? 'JSON' : text ? 'Text' : o.kind, sizeOf(o.size)].filter(Boolean).join(' · ')}
          </T>
        </View>
      </View>
      <View style={{ flex: 1, overflow: 'hidden' }}>
        {!text ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 }}>
            <Monitor color={color.onStageDim} size={28} />
            <T v="callout" c={color.onStageDim} style={{ textAlign: 'center' }}>
              Open this one on your Mac.
            </T>
          </View>
        ) : !file?.text ? (
          active && file?.status === 'error' ? (
            <T v="callout" c={color.onStageDim}>
              {file.error ?? "Couldn't get it."}
            </T>
          ) : (
            <ActivityIndicator color={color.onStageDim} style={{ marginTop: 24 }} />
          )
        ) : (
          <>
            {shown.map((l, i) => (
              <Text key={i} numberOfLines={1} style={[type.mono, { color: color.onStage, fontSize: 12, lineHeight: 18 }]}>
                {l || ' '}
              </Text>
            ))}
            {rest > 0 ? (
              <T v="caption" c={color.onStageDim} style={{ marginTop: 8 }}>
                {rest} more {rest === 1 ? 'line' : 'lines'}
              </T>
            ) : null}
          </>
        )}
      </View>
      {text ? (
        <Press onPress={openIt} accessibilityLabel={`Open ${o.name}`} style={{ height: 46, borderRadius: 23, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: color.onStage }}>
          <T v="callout" c={color.stage} style={{ fontWeight: '700' }}>
            Open
          </T>
          <ArrowUpRight color={color.stage} size={18} />
        </Press>
      ) : null}
    </View>
  );
}
