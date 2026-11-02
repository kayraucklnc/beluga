import { router } from 'expo-router';
import { useMemo } from 'react';
import { Text, type TextStyle } from 'react-native';
import { useView } from '../../lib/hooks';
import type { TasksView } from '../../lib/link/protocol';
import { splitTaskKeys } from '../../lib/render';
import { store } from '../../lib/store';
import { color, type } from '../../lib/theme';
import { statusOf, taskHref } from '../Tasks';
import { Press, toneBg, toneInk } from '../ui';

/**
 * Task keys in words (BLG-109), as on the Mac (src/shared/task-refs.ts): `task:BLG-12`, a bare
 * "BLG-12" the board has, "@BLG-12" in your messages, each a small chip with the task's key, title
 * and status colour, read live from the board (the Tasks view: its lists and `others`). A tap opens
 * the task's page. A key the board doesn't have stays words.
 */

export interface TaskRef {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly status: string;
}

/** The board's tasks by key (upper-case), live; empty on a Mac without tasks (before 1.4). */
export function useTaskIndex(on = true): ReadonlyMap<string, TaskRef> {
  const tasks = useView<TasksView>(on && store.supports('tasks') ? 'tasks' : undefined);
  const data = tasks?.data;
  return useMemo(() => {
    const map = new Map<string, TaskRef>();
    if (!data) return map;
    for (const p of data.projects) for (const g of p.groups) for (const t of g.tasks) map.set(t.key.toUpperCase(), t);
    for (const t of data.others ?? []) if (!map.has(t.key.toUpperCase())) map.set(t.key.toUpperCase(), t);
    return map;
  }, [data]);
}

const pill = { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 4, paddingHorizontal: 6, borderRadius: 7, height: 22, alignSelf: 'center' as const };

/** One task by its key: its status icon and pastel, key and title. Not on the board: the key, muted. */
export function TaskChip({ k, task }: { readonly k: string; readonly task?: TaskRef | undefined }) {
  const index = useTaskIndex(!task);
  const t = task ?? index.get(k.toUpperCase());
  const st = statusOf(t?.status ?? 'backlog');
  const bg = t ? toneBg(st.tone) : color.sunken;
  const fg = t ? toneInk(st.tone) : color.text2;
  return (
    <Press
      haptics={false}
      accessibilityLabel={t ? `${t.key} ${t.title}, ${st.label}` : `${k}, not on the board here`}
      onPress={() => (t ? router.push(taskHref(t)) : store.toast({ text: `${k}: not on the board here`, tone: 'info' }))}
      style={[pill, { backgroundColor: bg }]}
    >
      {t ? <st.Icon color={fg} size={11} strokeWidth={2} /> : null}
      <Text style={{ ...type.caption, color: fg, fontWeight: '800' }}>{t?.key ?? k}</Text>
      {t ? (
        <Text numberOfLines={1} style={{ ...type.caption, color: fg, maxWidth: 160 }}>
          {t.title}
        </Text>
      ) : null}
    </Press>
  );
}

/**
 * Plain words (a chat message) with the task keys in them as chips: only where a key is surely
 * yours (your own messages), as the Mac does.
 */
export function TaskWords({ text, style }: { readonly text: string; readonly style?: TextStyle }) {
  const index = useTaskIndex();
  const pieces = useMemo(() => (index.size ? splitTaskKeys(text, (k) => index.has(k), { mentions: true }) : [{ text }]), [text, index]);
  return <Text style={style}>{pieces.map((p, i) => ('key' in p ? <TaskChip key={i} k={p.key} task={index.get(p.key)} /> : p.text))}</Text>;
}
