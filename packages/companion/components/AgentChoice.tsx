import { Check, ChevronDown, Sparkles } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { agentForChoice, agentPicks } from '../lib/agent-picks';
import { color } from '../lib/theme';
import { AgentMarkIcon, runtimeMark } from './AgentMark';
import { haptic, Press, T } from './ui';

/** Which agent it is (src/protocol.ts AgentRef, as the calls send it). */
export interface PickedAgent {
  readonly runtime: string;
  readonly label: string;
  readonly model?: string;
}

const valueOf = (a: PickedAgent | undefined): string => (a ? `${a.runtime}:${a.model ?? ''}` : '');

/**
 * Who works a new task or plan (BLG-498), as a quiet chip beside the sheet's other options: "Your
 * agent" (the default: none is sent), or one of your Mac's agents and models, each with its mark.
 * Tapping it opens the list in place, under the chip; a pick closes it.
 */
export function AgentChoice({ value, onChange }: { readonly value: PickedAgent | undefined; readonly onChange: (a: PickedAgent | undefined) => void }) {
  const [open, setOpen] = useState(false);
  // Read when the list opens: the newest picker the Mac sent (lib/agent-picks.ts).
  const picks = useMemo(() => agentPicks(), [open]);
  const on = valueOf(value);
  const pick = (v: string): void => {
    haptic.tap();
    onChange(v ? agentForChoice(v, picks.runtimes) : undefined);
    setOpen(false);
  };
  const chipMark = value ? runtimeMark(value.runtime) : picks.defaultRuntime ? runtimeMark(picks.defaultRuntime) : undefined;
  const chipLabel = value ? (picks.options.find((o) => o.value === on)?.label ?? (value.model ? `${value.label} · ${value.model}` : value.label)) : 'Your agent';
  return (
    <>
      <Press
        onPress={() => (haptic.tap(), setOpen((o) => !o))}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`Agent: ${chipLabel}`}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 34, paddingHorizontal: 10, borderRadius: 17, backgroundColor: color.sunken }}
      >
        {chipMark ? <AgentMarkIcon mark={chipMark} size={14} color={color.text2} /> : <Sparkles color={color.text2} size={15} strokeWidth={1.9} />}
        <T v="caption" c={value ? color.text : color.text2} numberOfLines={1} style={{ fontWeight: '700', flexShrink: 1 }}>
          {chipLabel}
        </T>
        <ChevronDown color={color.text2} size={14} />
      </Press>
      {open ? (
        <Animated.View entering={FadeIn.duration(160)} exiting={FadeOut.duration(120)} style={{ width: '100%' }}>
          <ScrollView style={{ maxHeight: 260 }} contentContainerStyle={{ paddingVertical: 4 }} nestedScrollEnabled>
            <Row label="Your agent" sub="Your default, as on your Mac" mark={picks.defaultRuntime} on={!on} onPress={() => pick('')} />
            {picks.options.map((o) => (
              <Row key={o.value} label={o.label} mark={o.runtime} on={o.value === on} disabled={o.disabled} {...(o.why ? { sub: o.why } : {})} onPress={() => pick(o.value)} />
            ))}
            {!picks.options.length ? (
              <T v="caption" style={{ paddingHorizontal: 10, paddingTop: 4 }}>
                Your Mac’s other agents show here once it has said which it runs.
              </T>
            ) : null}
          </ScrollView>
        </Animated.View>
      ) : null}
    </>
  );
}

function Row({ label, sub, mark, on, disabled, onPress }: { readonly label: string; readonly sub?: string; readonly mark?: string; readonly on: boolean; readonly disabled?: boolean; readonly onPress: () => void }) {
  return (
    <Press
      disabled={disabled}
      scaleTo={0.985}
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ checked: on, disabled: Boolean(disabled) }}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 9, paddingHorizontal: 10, borderRadius: 14, backgroundColor: on ? color.sunken : 'transparent', opacity: disabled ? 0.5 : 1 }}
    >
      {mark ? <AgentMarkIcon mark={runtimeMark(mark)} size={18} color={color.text2} /> : <Sparkles color={color.text2} size={18} strokeWidth={1.9} />}
      <View style={{ flex: 1 }}>
        <T v="body">{label}</T>
        {sub ? <T v="caption">{sub}</T> : null}
      </View>
      {on ? <Check size={18} color={color.text} /> : null}
    </Press>
  );
}
