import { ChevronDown, ChevronRight, Ellipsis, FolderOpen } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { FileTree as Tree, TreeNode } from '../../lib/render';
import { color, radius, type } from '../../lib/theme';
import { fileIcon } from '../fileIcon';
import { haptic, Press, T, toneInk } from '../ui';
import { copy } from './parts';

/**
 * A file tree Claude wrote (BLG-87), read by the Mac's own reader (src/shared/render/file-tree.ts):
 * folders and files with their icons, notes muted, folders fold with a tap. Long-press copies the
 * tree as Claude wrote it.
 */

interface Flat {
  readonly node: TreeNode;
  readonly depth: number;
  readonly id: string;
}

const flatten = (nodes: readonly TreeNode[], folded: ReadonlySet<string>, depth = 0, prefix = ''): Flat[] =>
  nodes.flatMap((node, i) => {
    const id = `${prefix}${i}`;
    const self: Flat = { node, depth, id };
    return node.children.length && !folded.has(id) ? [self, ...flatten(node.children, folded, depth + 1, `${id}.`)] : [self];
  });

/** Folders past the first levels start folded when the tree is big. */
function initialFolds(tree: Tree): Set<string> {
  const out = new Set<string>();
  if (tree.dirs + tree.files <= 60) return out;
  const walk = (nodes: readonly TreeNode[], depth: number, prefix: string): void =>
    nodes.forEach((n, i) => {
      const id = `${prefix}${i}`;
      if (n.children.length && depth >= 1) out.add(id);
      walk(n.children, depth + 1, `${id}.`);
    });
  walk(tree.roots, 0, '');
  return out;
}

export function FileTreeView({ tree, text }: { readonly tree: Tree; readonly text: string }) {
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => initialFolds(tree));
  const rows = useMemo(() => flatten(tree.roots, folded), [tree, folded]);
  const toggle = (id: string) => {
    haptic.tap();
    setFolded((f) => {
      const n = new Set(f);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };
  const counts = [tree.dirs ? `${tree.dirs} ${tree.dirs === 1 ? 'folder' : 'folders'}` : '', tree.files ? `${tree.files} ${tree.files === 1 ? 'file' : 'files'}` : ''].filter(Boolean).join(', ');
  return (
    <Press haptics={false} scaleTo={1} onLongPress={() => copy(text, 'Copied the tree')} delayLongPress={380} style={{ borderRadius: radius.m - 2, backgroundColor: color.code, paddingVertical: 8 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 8, minWidth: '100%' }}>
        <View style={{ flexGrow: 1 }}>
          {rows.map(({ node, depth, id }) => {
            const folder = node.dir || node.children.length > 0;
            const open = folder && node.children.length > 0 && !folded.has(id);
            const { Icon, tone } = node.more ? { Icon: Ellipsis, tone: 'plain' as const } : folder && open ? { Icon: FolderOpen, tone: 'sky' as const } : fileIcon(node.name, folder);
            const body = (
              <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 26, paddingLeft: depth * 16, paddingRight: 8, gap: 6 }}>
                <View style={{ width: 14, alignItems: 'center' }}>
                  {folder && node.children.length ? open ? <ChevronDown color={color.text3} size={13} strokeWidth={2.4} /> : <ChevronRight color={color.text3} size={13} strokeWidth={2.4} /> : null}
                </View>
                <Icon color={tone === 'plain' ? color.text3 : toneInk(tone)} size={15} strokeWidth={2} />
                <Text numberOfLines={1} style={[type.mono, { fontSize: 13, color: node.more ? color.text3 : color.text, fontWeight: folder ? '600' : '400' }]}>
                  {node.name}
                  {folder && !node.more ? <Text style={{ color: color.text3 }}>/</Text> : null}
                </Text>
                {node.note ? (
                  <Text numberOfLines={1} style={{ ...type.caption, color: color.text3, flexShrink: 1 }}>
                    {node.note}
                  </Text>
                ) : null}
              </View>
            );
            return folder && node.children.length ? (
              <Press key={id} haptics={false} scaleTo={0.99} onPress={() => toggle(id)} onLongPress={() => copy(text, 'Copied the tree')} delayLongPress={380} accessibilityLabel={`${node.name}, ${open ? 'open' : 'folded'}`} style={{ borderRadius: 6 }}>
                {body}
              </Press>
            ) : (
              <View key={id}>{body}</View>
            );
          })}
        </View>
      </ScrollView>
      <T v="caption" style={{ paddingHorizontal: 12, paddingTop: 6 }}>
        {tree.summary ?? counts}
      </T>
    </Press>
  );
}
