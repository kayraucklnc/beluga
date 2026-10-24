import { Gauge } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { until } from '../lib/hooks';
import type { UsageView } from '../lib/link/protocol';
import { color, ink } from '../lib/theme';
import { Sheet } from './Sheet';
import { Card, IconBadge, Press, T } from './ui';

/**
 * Your allowance: one pastel bar per window (5 hours, week) with its percent and when it resets.
 * The view is a list of providers (Claude Code today, other agents later): the card shows the
 * first; tap it for all of them.
 */
const toneOf = (pct: number): 'mint' | 'butter' | 'rose' => (pct >= 90 ? 'rose' : pct >= 70 ? 'butter' : 'mint');

function Bar({ pct }: { pct: number }) {
  const p = useSharedValue(0);
  useEffect(() => {
    p.value = withTiming(pct / 100, { duration: 700, easing: Easing.bezier(0.22, 1, 0.36, 1) });
  }, [pct]);
  const fill = useAnimatedStyle(() => ({ width: `${p.value * 100}%` }));
  const t = toneOf(pct);
  return (
    <View style={{ height: 8, borderRadius: 4, backgroundColor: color.sunken, overflow: 'hidden' }}>
      <Animated.View style={[{ height: 8, borderRadius: 4, backgroundColor: ink[t], opacity: 0.5 }, fill]} />
    </View>
  );
}

export function UsageBars({ usage }: { readonly usage: UsageView }) {
  return (
    <View style={{ gap: 12 }}>
      {usage.windows.map((w) => (
        <View key={w.label} style={{ gap: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
            <T v="callout" c={color.text} style={{ fontWeight: '500' }}>
              {w.label}
            </T>
            <T v="caption" style={{ flex: 1 }}>
              {w.resetsAt ? `resets in ${until(w.resetsAt)}` : ''}
            </T>
            <T v="callout" c={color.text} style={{ fontWeight: '700', fontVariant: ['tabular-nums'] }}>
              {Math.round(w.pct)}%
            </T>
          </View>
          <Bar pct={w.pct} />
        </View>
      ))}
    </View>
  );
}

/** The allowance at a glance; tapping it opens every provider (`onOpen`: the screen shows the `UsageSheet`, at its own level). */
export function UsageCard({ usage, title = 'Allowance', onOpen }: { readonly usage: readonly UsageView[]; readonly title?: string; readonly onOpen: () => void }) {
  const main = usage[0];
  if (!main) return null;
  return (
    <>
      <Press scaleTo={0.985} onPress={onOpen} accessibilityLabel={`${title}: all providers`} style={{ marginHorizontal: 16 }}>
        <Card style={{ padding: 16, gap: 14 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <IconBadge Icon={Gauge} tone="mint" size={30} />
            <T v="heading" style={{ flex: 1 }}>
              {title}
            </T>
            <T v="caption">
              {main.provider}
              {usage.length > 1 ? ` +${usage.length - 1}` : ''}
            </T>
          </View>
          <UsageBars usage={main} />
        </Card>
      </Press>
    </>
  );
}

export function UsageSheet({ usage, visible, onClose }: { readonly usage: readonly UsageView[]; readonly visible: boolean; readonly onClose: () => void }) {
  return (
    <Sheet window visible={visible} onDismiss={onClose}>
      <View style={{ paddingHorizontal: 20, paddingBottom: 12, gap: 22 }}>
        {usage.map((u) => (
          <View key={u.provider} style={{ gap: 12 }}>
            <T v="heading">
              {u.provider}
              {u.plan ? <T v="callout"> · {u.plan}</T> : null}
            </T>
            <UsageBars usage={u} />
          </View>
        ))}
      </View>
    </Sheet>
  );
}
