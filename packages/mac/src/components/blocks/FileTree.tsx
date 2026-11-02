import { memo, useMemo, useRef, useState } from 'react';
import { type FileTree as Tree, type TreeNode, nodePath } from '@beluga/shared/render/file-tree.js';
import { ActionsContext, type ActionItem } from '../SpecMenu.js';
import { Icon } from '../Icon.js';
import { cx } from '../ui.js';
import { copyText } from '../../lib/copy.js';
import { toast, useBeluga } from '../../lib/beluga.js';
import { useCopied } from '../markdown/CodeBlock.js';
import b from './blocks.module.css';

/**
 * A file tree Claude wrote as text (`tree`'s output, or ├── └── by hand), drawn as one: folders
 * fold, guides show what's inside what, notes stay beside their names. Copy on hover copies the
 * text as written; right-click for the rest.
 */

/** Past this many entries, only the first two levels start open. */
const MANY = 80;

/** Every folder's key ("0/2/1": the indexes from the root), with how deep it is. */
function folders(roots: readonly TreeNode[]): { key: string; depth: number }[] {
  const out: { key: string; depth: number }[] = [];
  const walk = (nodes: readonly TreeNode[], prefix: string, depth: number): void =>
    nodes.forEach((n, i) => {
      const key = prefix ? `${prefix}/${i}` : String(i);
      if (n.children.length) {
        out.push({ key, depth });
        walk(n.children, key, depth + 1);
      }
    });
  walk(roots, '', 0);
  return out;
}

function count(roots: readonly TreeNode[]): number {
  return roots.reduce((n, r) => n + 1 + count(r.children), 0);
}

export const FileTree = memo(function FileTree({ tree, code, onQuote }: { tree: Tree; code: string; onQuote?: ((fence: string) => void) | undefined }) {
  const { client } = useBeluga();
  const all = useMemo(() => folders(tree.roots), [tree]);
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => (count(tree.roots) > MANY ? new Set(all.filter((f) => f.depth >= 2).map((f) => f.key)) : new Set()));
  const [copied, copyNow] = useCopied();
  // The row right-clicked last (its path, for Copy Path).
  const picked = useRef<readonly TreeNode[] | undefined>(undefined);
  const fence = `\`\`\`text\n${code}\n\`\`\``;
  const copy = (text: string, what: string): void => void copyText(text).then(() => toast(client, `Copied ${what}`, 'success'));
  const toggle = (key: string): void =>
    setClosed((now) => {
      const next = new Set(now);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const items = (): ActionItem[] => {
    const at = picked.current;
    return [
      { label: 'Copy', icon: 'copy', onSelect: () => copy(code, 'the tree') },
      { label: 'Copy as Markdown', onSelect: () => copy(fence, 'as Markdown') },
      ...(at?.length ? [{ label: 'Copy Path', icon: 'link' as const, onSelect: () => copy(nodePath(at) || at.at(-1)!.name, nodePath(at) || at.at(-1)!.name) }] : []),
      { label: 'Expand All', icon: 'chevronDown', separate: true, disabled: !closed.size, onSelect: () => setClosed(new Set()) },
      { label: 'Collapse All', icon: 'chevronRight', disabled: !all.length || closed.size === all.length, onSelect: () => setClosed(new Set(all.map((f) => f.key))) },
      ...(onQuote ? [{ label: 'Quote in Reply', icon: 'chat' as const, separate: true, onSelect: () => onQuote(fence) }] : []),
    ];
  };

  const rows: React.ReactNode[] = [];
  const walk = (nodes: readonly TreeNode[], prefix: string, path: readonly TreeNode[]): void =>
    nodes.forEach((n, i) => {
      const key = prefix ? `${prefix}/${i}` : String(i);
      const here = [...path, n];
      const isDir = n.dir || n.children.length > 0;
      const open = !closed.has(key);
      const guides = path.map((_, d) => <span key={d} className={b.guide} aria-hidden="true" />);
      if (n.more) {
        rows.push(
          <div key={key} className={b.treeRow} role="treeitem" aria-level={path.length + 1} aria-label="More entries">
            {guides}
            <span className={b.chevronSpace} />
            <span className={b.treeMore}>…</span>
            {n.note ? <span className={b.treeNote}>{n.note}</span> : null}
          </div>,
        );
        return;
      }
      rows.push(
        <div
          key={key}
          className={cx(b.treeRow, isDir && b.treeDir)}
          role="treeitem"
          aria-level={path.length + 1}
          {...(n.children.length ? { 'aria-expanded': open } : {})}
          onClick={n.children.length ? () => toggle(key) : undefined}
          onContextMenu={() => (picked.current = here)}
        >
          {guides}
          {n.children.length ? (
            <span className={cx(b.chevron, open && b.chevronOpen)} aria-hidden="true">
              <Icon name="chevronRight" size={10} />
            </span>
          ) : (
            <span className={b.chevronSpace} />
          )}
          <Icon name={isDir ? 'folder' : 'file'} size={13} className={b.treeIcon} />
          <span className={b.treeName}>{n.name}</span>
          {n.note ? <span className={b.treeNote}>{n.note}</span> : null}
        </div>,
      );
      if (n.children.length && open) walk(n.children, key, here);
    });
  walk(tree.roots, '', []);

  const summary = tree.summary ?? [tree.dirs ? `${tree.dirs} ${tree.dirs === 1 ? 'folder' : 'folders'}` : '', `${tree.files} ${tree.files === 1 ? 'file' : 'files'}`].filter(Boolean).join(', ');
  return (
    <ActionsContext items={items}>
      <div className={cx(b.block, b.tree)} data-block="tree" onContextMenuCapture={() => (picked.current = undefined)}>
        <div className={b.tools}>
          <button type="button" className={b.tool} aria-label="Copy the tree" onClick={() => copyNow(code)}>
            <Icon name={copied ? 'check' : 'copy'} size={12} />
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <div className={b.treeRows} role="tree" aria-label="File tree">
          {rows}
        </div>
        <div className={b.treeSummary}>{summary}</div>
      </div>
    </ActionsContext>
  );
});
