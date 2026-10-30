import { Check, Sparkles, Users } from 'lucide-react-native';
import { View } from 'react-native';
import type { ChatMemberView } from '../lib/link/protocol';
import { color, ink, tint } from '../lib/theme';
import { Sheet } from './Sheet';
import { Avatar, haptic, IconBadge, Press, T } from './ui';

/**
 * Whose Claude a chat message asks: yours, everyone's, or one person's (companion.post `ask`, as
 * the Mac's Ask Claude menu). In a DM: yours, theirs, or both.
 */
export interface AskTarget {
  /** 'all' or the peer ids whose Claude answers. */
  readonly ask: 'all' | readonly string[];
  /** As the chip says it ("Mia's Claude"). */
  readonly label: string;
}

export function askTargets(members: readonly ChatMemberView[] | undefined, kind: 'dm' | 'group', chatName: string): AskTarget[] {
  const me = members?.find((m) => m.me);
  const others = (members ?? []).filter((m) => !m.me);
  const mine: AskTarget[] = me ? [{ ask: [me.peerId], label: 'My agent' }] : [];
  if (kind === 'dm') {
    const them = others[0];
    if (!them) return [...mine, { ask: 'all', label: `${chatName}'s agent` }];
    return [...mine, { ask: [them.peerId], label: `${them.name}'s agent` }, ...(me ? [{ ask: [me.peerId, them.peerId], label: 'Both agents' }] : [])];
  }
  return [...mine, { ask: 'all', label: "Everyone's agent" }, ...others.map((m) => ({ ask: [m.peerId], label: `${m.name}'s agent` }))];
}

export function AskClaudePicker({ visible, onClose, targets, chosen, onPick, members }: { readonly visible: boolean; readonly onClose: () => void; readonly targets: readonly AskTarget[]; readonly chosen?: AskTarget; readonly onPick: (t: AskTarget) => void; readonly members?: readonly ChatMemberView[] }) {
  const nameOf = (id: string): string => members?.find((m) => m.peerId === id)?.name ?? '?';
  return (
    <Sheet visible={visible} onDismiss={onClose}>
      <View style={{ paddingHorizontal: 12, paddingBottom: 8 }}>
        <T v="eyebrow" style={{ paddingHorizontal: 10, paddingBottom: 8 }}>
          Ask an agent
        </T>
        {targets.map((t) => {
          const on = chosen?.label === t.label;
          const single = t.ask !== 'all' && t.ask.length === 1 ? t.ask[0]! : undefined;
          const mine = single && members?.find((m) => m.peerId === single)?.me;
          return (
            <Press
              key={t.label}
              scaleTo={0.98}
              haptics={false}
              onPress={() => {
                haptic.tap();
                onPick(t);
                onClose();
              }}
              accessibilityLabel={t.label}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 10, paddingHorizontal: 10, borderRadius: 16, backgroundColor: on ? tint.peach : 'transparent' }}
            >
              {mine ? <IconBadge Icon={Sparkles} tone="peach" size={38} /> : single ? <Avatar name={nameOf(single)} size={38} /> : <IconBadge Icon={Users} tone="lavender" size={38} />}
              <T v="body" style={{ flex: 1, fontWeight: '500' }} c={on ? ink.peach : color.text}>
                {t.label}
              </T>
              {on ? <Check color={ink.peach} size={18} /> : null}
            </Press>
          );
        })}
      </View>
    </Sheet>
  );
}
