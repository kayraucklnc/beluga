import { router } from 'expo-router';
import { useMemo } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Maximize2 } from 'lucide-react-native';
import { openFull } from '../../lib/fullscreen';
import { useView } from '../../lib/hooks';
import type { ProseView, TasksView } from '../../lib/link/protocol';
import { parseGraph, parseView, readTaskKeys, viewFenceType } from '../../lib/render';
import { store } from '../../lib/store';
import { color, type } from '../../lib/theme';
import { statusOf, taskHref } from '../Tasks';
import { Card, Press, T, toneBg, toneInk } from '../ui';
import type { BlockAt } from './data';
import { GraphCard } from './Graph';
import { ViewCard } from './ViewCard';

/**
 * What Claude drew in an answer, on the phone: a view, a graph or tasks, read by the Mac's own
 * parsers (src/shared). A block that's still being written, or can't be read, says so (as the
 * Mac's card does), never its JSON's code.
 */
export function Block({ entry, at }: { readonly entry: ProseView['code'][number]; readonly at?: BlockAt }) {
  const block = entry.block!;
  const graph = useMemo(() => (block.kind === 'graph' ? parseGraph(block.text) : undefined), [block.text, block.kind]);
  const view = useMemo(() => {
    if (block.kind !== 'view') return undefined;
    const t = viewFenceType(entry.lang);
    return parseView(block.text, t && t !== 'any' ? t : undefined);
  }, [block.text, block.kind, entry.lang]);
  if (graph) return graph.ok ? <GraphCard graph={graph.graph} /> : <Problem incomplete={graph.incomplete} error={graph.error} what="graph" />;
  if (view) return view.ok ? <ViewCard view={view.view} {...(at ? { at } : {})} warnings={view.warnings.length} /> : <Problem incomplete={view.incomplete} error={view.error} what="view" />;
  if (block.kind === 'tasks') return <TaskCards keys={readTaskKeys(block.text)} />;
  if (block.kind === 'text') return <TextTable text={block.text} />;
  return null;
}

/**
 * A table Claude wrote as text that doesn't read as rows and columns (BLG-71): as it is,
 * monospaced, never wrapped; it scrolls sideways, and opens full screen.
 */
export function TextTable({ text, full }: { readonly text: string; readonly full?: boolean }) {
  return (
    <View style={{ borderRadius: 14, backgroundColor: color.code, overflow: 'hidden' }}>
      {full ? null : (
        <Press onPress={() => openFull({ kind: 'text', text })} accessibilityLabel="Full screen" hitSlop={6} style={{ position: 'absolute', right: 6, top: 6, zIndex: 1, width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: color.card }}>
          <Maximize2 color={color.text2} size={13} />
        </Press>
      )}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ padding: 12, paddingRight: full ? 12 : 40 }}>
        <Text style={[type.mono, { color: color.text, fontSize: 12.5, lineHeight: 17 }]}>{text}</Text>
      </ScrollView>
    </View>
  );
}

function Problem({ incomplete, error, what }: { readonly incomplete: boolean; readonly error: string; readonly what: string }) {
  return (
    <Card style={{ padding: 12 }}>
      <T v="callout">{incomplete ? `Showing a ${what}…` : `This ${what} can’t be shown: ${error}`}</T>
    </Card>
  );
}

/** A `beluga-tasks` block: each task's key, title and status, read live from the board. */
function TaskCards({ keys }: { readonly keys: readonly string[] }) {
  const tasks = useView<TasksView>(store.supports('tasks') ? 'tasks' : undefined);
  const all = tasks?.data.projects.flatMap((p) => p.groups.flatMap((g) => g.tasks)) ?? [];
  return (
    <View style={{ gap: 6 }}>
      {keys.map((k) => {
        const t = all.find((x) => x.key.toUpperCase() === k);
        const st = statusOf(t?.status ?? 'todo');
        return (
          <Press key={k} scaleTo={0.985} onPress={() => (t ? router.push(taskHref(t)) : undefined)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: 14, backgroundColor: color.sunken }}>
            <View style={{ width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: toneBg(st.tone) }}>
              <st.Icon color={toneInk(st.tone)} size={14} />
            </View>
            <T v="caption" style={{ fontWeight: '800' }}>
              {k}
            </T>
            <T v="callout" c={color.text} numberOfLines={1} style={{ flex: 1 }}>
              {t?.title ?? 'Not on the board here'}
            </T>
          </Press>
        );
      })}
    </View>
  );
}
