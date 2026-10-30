import { Check } from 'lucide-react-native';
import { ScrollView, View } from 'react-native';
import { calls } from '../lib/link/calls';
import type { AgentPickerView, Topic } from '../lib/link/protocol';
import { store } from '../lib/store';
import { color } from '../lib/theme';
import { AgentMarkIcon, modelMark, runtimeMark } from './AgentMark';
import { Sheet } from './Sheet';
import { haptic, Press, T } from './ui';

type Group = AgentPickerView['groups'][number];

/**
 * The agent picker (BLG-446), as the Mac's composer has it: runtimes as groups with their models,
 * your default agent's first; one your Mac doesn't run is greyed with what's missing. A model of
 * the same runtime is a model change; another runtime is this worktree's new agent. Each group
 * leads with its runtime's mark (BLG-497); a model leads with its maker's only when that isn't the
 * runtime's own (a local runtime running an OpenAI model).
 */
export function AgentPickerSheet({ topic, picker, visible, onClose }: { readonly topic: Topic; readonly picker: AgentPickerView | undefined; readonly visible: boolean; readonly onClose: () => void }) {
  const pick = (g: Group, value: string, label: string): void => {
    if (!picker) return;
    haptic.commit();
    const call =
      g.runtime === picker.runtime
        ? calls.setModel(topic, value, label)
        : calls.setAgent(topic, g.isDefault && !value ? null : { runtime: g.runtime, label: g.label, ...(value ? { model: value } : {}) }, `${g.label} ${label}`);
    void store.call(call).catch((e: Error) => store.toast({ text: e.message, tone: 'error' }));
    onClose();
  };
  return (
    <Sheet
      visible={visible && Boolean(picker)}
      onDismiss={onClose}
      header={
        <View style={{ paddingHorizontal: 20, paddingBottom: 10 }}>
          <T v="title" style={{ fontSize: 20 }}>
            Agent
          </T>
          <T v="caption">For this conversation, from your next message</T>
        </View>
      }
    >
      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 24, gap: 18 }}>
        {picker?.groups.map((g) => (
          <View key={g.runtime} style={{ gap: 4, opacity: g.available ? 1 : 0.55 }} accessibilityState={{ disabled: !g.available }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <AgentMarkIcon mark={runtimeMark(g.runtime)} size={18} color={color.text2} />
              <T v="heading" style={{ flexShrink: 1 }}>
                {g.isDefault ? `${g.label} · your default` : g.label}
              </T>
            </View>
            {g.available ? (
              g.models.map((m) => {
                const maker = m.value ? modelMark(m.value, g.runtime) : undefined;
                const other = maker && maker !== modelMark(undefined, g.runtime) ? maker : undefined;
                return (
                  <Press key={m.value || 'default'} scaleTo={0.985} onPress={() => pick(g, m.value, m.label)} accessibilityRole="radio" accessibilityState={{ checked: m.on }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 14, backgroundColor: m.on ? color.card : 'transparent' }}>
                      {other ? <AgentMarkIcon mark={other} size={16} color={color.text2} /> : null}
                      <View style={{ flex: 1 }}>
                        <T v="body">{m.label}</T>
                        {m.description ? <T v="caption">{m.description}</T> : null}
                      </View>
                      {m.on ? <Check size={18} color={color.text} /> : null}
                    </View>
                  </Press>
                );
              })
            ) : (
              <T v="caption">{g.why}</T>
            )}
          </View>
        ))}
      </ScrollView>
    </Sheet>
  );
}
