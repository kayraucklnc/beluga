import * as Haptics from 'expo-haptics';
import { ChevronRight, Ellipsis, type LucideIcon } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { Platform, Pressable, type PressableProps, type StyleProp, StyleSheet, Text, type TextProps, type TextStyle, View, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { color, ink, radius, scheme, spring, tint, type, typeColor } from '../lib/theme';

/**
 * The app's small parts. One pattern everywhere: an icon in a pastel circle, one or two words,
 * the primary action on the surface, and everything else one tap away behind "•••".
 */

export const haptic = {
  tap: (): void => void (Platform.OS !== 'web' && Haptics.selectionAsync().catch(() => {})),
  commit: (): void => void (Platform.OS !== 'web' && Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {})),
  success: (): void => void (Platform.OS !== 'web' && Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {})),
  warn: (): void => void (Platform.OS !== 'web' && Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {})),
};

type Variant = keyof typeof type;
export function T({ v = 'body', c, style, ...rest }: TextProps & { readonly v?: Variant; readonly c?: string }) {
  return <Text {...rest} style={[type[v] as TextStyle, { color: c ?? typeColor(v) }, style]} />;
}

/** The pastel a meaning is drawn in. */
export type Tone = 'sky' | 'mint' | 'peach' | 'lavender' | 'butter' | 'rose' | 'plain';
export const toneBg = (t: Tone): string => (t === 'plain' ? color.sunken : tint[t]);
export const toneInk = (t: Tone): string => (t === 'plain' ? color.text2 : ink[t]);

/** A card: white (or slate) on the warm background, rounded, with a whisper of shadow in light. */
export function Card({ children, style, tone, r = radius.l }: { readonly children?: ReactNode; readonly style?: StyleProp<ViewStyle>; readonly tone?: Tone; readonly r?: number }) {
  return (
    <View
      style={[
        {
          borderRadius: r,
          backgroundColor: tone && tone !== 'plain' ? tint[tone] : color.card,
          borderWidth: scheme === 'dark' || tone ? 0 : StyleSheet.hairlineWidth,
          borderColor: color.hairline,
          ...(scheme === 'light' && !tone ? shadow() : {}),
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}
const shadow = (): ViewStyle =>
  Platform.select({
    web: { boxShadow: color.shadowCss } as ViewStyle,
    default: { shadowColor: color.shadowInk, shadowOpacity: 0.06, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 1 },
  })!;

/** A press that springs a little (on the UI thread), with a selection tick. */
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
export function Press({ children, style, scaleTo = 0.97, onPress, haptics = true, ...rest }: Omit<PressableProps, 'style' | 'children'> & { readonly style?: StyleProp<ViewStyle>; readonly scaleTo?: number; readonly haptics?: boolean; readonly children?: ReactNode }) {
  const s = useSharedValue(1);
  const anim = useAnimatedStyle(() => ({ transform: [{ scale: s.value }] }));
  return (
    <AnimatedPressable
      {...rest}
      style={[style, anim]}
      onPressIn={(e) => {
        s.value = withSpring(scaleTo, spring.snappy);
        rest.onPressIn?.(e);
      }}
      onPressOut={(e) => {
        s.value = withSpring(1, spring.snappy);
        rest.onPressOut?.(e);
      }}
      onPress={(e) => {
        if (haptics) haptic.tap();
        onPress?.(e);
      }}
    >
      {children}
    </AnimatedPressable>
  );
}

/** An icon in a pastel circle (or rounded square): the app's main visual unit. */
export function IconBadge({ Icon, tone, size = 36, square }: { readonly Icon: LucideIcon; readonly tone: Tone; readonly size?: number; readonly square?: boolean }) {
  return (
    <View style={{ width: size, height: size, borderRadius: square ? size * 0.32 : size / 2, backgroundColor: toneBg(tone), alignItems: 'center', justifyContent: 'center' }}>
      <Icon color={toneInk(tone)} size={size * 0.5} strokeWidth={2.1} />
    </View>
  );
}

/** A small tinted label: an optional icon and a word or two. */
export function Pill({ label, tone = 'plain', Icon, style }: { readonly label: string; readonly tone?: Tone; readonly Icon?: LucideIcon; readonly style?: ViewStyle }) {
  return (
    <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 5, height: 26, paddingHorizontal: 10, borderRadius: 13, backgroundColor: toneBg(tone) }, style]}>
      {Icon ? <Icon color={toneInk(tone)} size={13} strokeWidth={2.3} /> : null}
      <Text style={{ ...type.caption, color: toneInk(tone), fontWeight: '600' }} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

/** The "•••" button: where the advanced options of anything live. */
export function More({ onPress, label = 'More', size = 34 }: { readonly onPress: () => void; readonly label?: string; readonly size?: number }) {
  return (
    <Press onPress={onPress} accessibilityLabel={label} hitSlop={8} style={{ width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: color.sunken }}>
      <Ellipsis color={color.text2} size={18} strokeWidth={2.4} />
    </Press>
  );
}

/** A list row: icon badge, a label (and a quiet line under it), something on the right, a chevron. */
export function Row({ Icon, tone = 'plain', label, sub, right, onPress, chevron = true, first }: { readonly Icon?: LucideIcon; readonly tone?: Tone; readonly label: string; readonly sub?: string; readonly right?: ReactNode; readonly onPress?: () => void; readonly chevron?: boolean; readonly first?: boolean }) {
  const body = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 14 }}>
      {Icon ? <IconBadge Icon={Icon} tone={tone} size={34} /> : null}
      <View style={{ flex: 1, gap: 1 }}>
        <T v="body" numberOfLines={1} style={{ fontWeight: '500' }}>
          {label}
        </T>
        {sub ? (
          <T v="caption" numberOfLines={1}>
            {sub}
          </T>
        ) : null}
      </View>
      {right}
      {onPress && chevron ? <ChevronRight color={color.text3} size={18} /> : null}
    </View>
  );
  return (
    <View>
      {!first ? <Hairline style={{ marginLeft: Icon ? 60 : 14 }} /> : null}
      {onPress ? (
        <Press scaleTo={0.985} onPress={onPress}>
          {body}
        </Press>
      ) : (
        body
      )}
    </View>
  );
}

const HUES: Tone[] = ['peach', 'sky', 'mint', 'lavender', 'butter', 'rose'];
export const hueOf = (name: string): Tone => HUES[[...name].reduce((n, ch) => n + ch.charCodeAt(0), 0) % HUES.length]!;
const PRESENCE: Record<string, () => string> = { online: () => color.ok, away: () => color.warn, dnd: () => color.error, offline: () => color.text3 };

export function Avatar({ name, size = 40, presence, claude }: { readonly name: string; readonly size?: number; readonly presence?: string; readonly claude?: boolean }) {
  const t: Tone = claude ? 'peach' : hueOf(name);
  return (
    <View style={{ width: size, height: size }}>
      <View style={{ width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: toneBg(t) }}>
        <Text style={{ color: toneInk(t), fontSize: size * 0.4, fontWeight: '700' }}>{claude ? '✳' : (name[0] ?? '?').toUpperCase()}</Text>
      </View>
      {presence ? <View style={{ position: 'absolute', right: -1, bottom: -1, width: size * 0.3, height: size * 0.3, borderRadius: size, backgroundColor: PRESENCE[presence]?.() ?? color.text3, borderWidth: 2.5, borderColor: color.bg }} /> : null}
    </View>
  );
}

export function Section({ title, right, children, style }: { readonly title: string; readonly right?: ReactNode; readonly children?: ReactNode; readonly style?: ViewStyle }) {
  return (
    <View style={[{ marginTop: 28 }, style]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, marginBottom: 10 }}>
        <T v="eyebrow">{title}</T>
        {right}
      </View>
      {children}
    </View>
  );
}

export function StatusDot({ c, size = 8 }: { readonly c: string; readonly size?: number }) {
  return <View style={{ width: size, height: size, borderRadius: size, backgroundColor: c }} />;
}

/** The pastel for a state word (conversations, plans, tasks). */
export const toneOf = (s: string | undefined): Tone =>
  s === 'working' || s === 'running' ? 'peach' : s === 'waiting' || s === 'review' || s === 'blocked' ? 'butter' : s === 'failed' ? 'rose' : s === 'done' ? 'mint' : s === 'draft' ? 'lavender' : 'plain';

export const Hairline = ({ style }: { readonly style?: ViewStyle }) => <View style={[{ height: StyleSheet.hairlineWidth, backgroundColor: color.hairline }, style]} />;

/** The main button: ink on light, light on dark. `quiet` for the second choice. */
export function Button({ label, onPress, Icon, quiet, disabled, style, flex }: { readonly label: string; readonly onPress: () => void; readonly Icon?: LucideIcon; readonly quiet?: boolean; readonly disabled?: boolean; readonly style?: ViewStyle; readonly flex?: number }) {
  return (
    <Press disabled={disabled} onPress={onPress} style={[{ flex, height: 48, borderRadius: 24, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: quiet ? color.sunken : color.primary, opacity: disabled ? 0.4 : 1 }, style]}>
      {Icon ? <Icon color={quiet ? color.text : color.onPrimary} size={18} strokeWidth={2.2} /> : null}
      <T v="body" c={quiet ? color.text : color.onPrimary} numberOfLines={1} style={{ fontWeight: '600', flexShrink: 1 }}>
        {label}
      </T>
    </Press>
  );
}
