import { memo, useRef, useState } from 'react';
import { type Json, type JsonDoc, jsonPreview, jsonSize, openDepth, pathStep } from '@beluga/shared/render/json-tree.js';
import { ActionsContext, type ActionItem } from '../SpecMenu.js';
import { Icon } from '../Icon.js';
import { cx } from '../ui.js';
import { copyText } from '../../lib/copy.js';
import { toast, useBeluga } from '../../lib/beluga.js';
import { CodeLines } from '../markdown/CodeLines.js';
import { useCopied } from '../markdown/CodeBlock.js';
import b from './blocks.module.css';

/**
 * A ```json block (shared/render/json-tree.ts) as a tree that folds: keys, strings, numbers,
 * true/false and null each in their own soft color, every object and array with how much it holds.
 * On hover: Tree / Raw and Copy; right-click for beautified, minified, a key's path, and folding.
 */

/** Strings longer than this show their start (click for the rest). */
const LONG = 120;
/** An array shows this many items at first. */
const FIRST = 100;

type Fold = { readonly depth: number; readonly over: ReadonlyMap<string, boolean> };

/** A path as it reads in code: `users[0].name`. */
const pathText = (steps: readonly (string | number)[]): string => steps.map(pathStep).join('').replace(/^\./, '');

export const JsonTree = memo(function JsonTree({ doc, code, onQuote }: { doc: JsonDoc; code: string; onQuote?: ((fence: string) => void) | undefined }) {
  const { client } = useBeluga();
  const [raw, setRaw] = useState(false);
  const [fold, setFold] = useState<Fold>(() => ({ depth: openDepth(doc), over: new Map() }));
  const [copied, copyNow] = useCopied();
  const picked = useRef<readonly (string | number)[] | undefined>(undefined);
  const copy = (text: string, what: string): void => void copyText(text).then(() => toast(client, `Copied ${what}`, 'success'));
  const isOpen = (key: string, depth: number): boolean => fold.over.get(key) ?? depth < fold.depth;
  const toggle = (key: string, depth: number): void => setFold((f) => ({ ...f, over: new Map(f.over).set(key, !(f.over.get(key) ?? depth < f.depth)) }));

  const items = (): ActionItem[] => {
    const at = picked.current;
    return [
      { label: 'Copy', icon: 'copy', onSelect: () => copy(code, 'the JSON') },
      { label: 'Copy Beautified', onSelect: () => copy(doc.pretty, 'beautified') },
      { label: 'Copy Minified', onSelect: () => copy(JSON.stringify(doc.value), 'minified') },
      ...(at?.length ? [{ label: 'Copy Path', icon: 'link' as const, hint: pathText(at), onSelect: () => copy(pathText(at), pathText(at)) }] : []),
      ...(!raw
        ? [
            { label: 'Expand All', icon: 'chevronDown' as const, separate: true, onSelect: () => setFold({ depth: 999, over: new Map() }) },
            { label: 'Collapse All', icon: 'chevronRight' as const, onSelect: () => setFold({ depth: 1, over: new Map() }) },
          ]
        : []),
      ...(onQuote ? [{ label: 'Quote in Reply', icon: 'chat' as const, separate: true, onSelect: () => onQuote(`\`\`\`json\n${code}\n\`\`\``) }] : []),
    ];
  };

  return (
    <ActionsContext items={items}>
      <div className={cx(b.block, b.json)} data-block="json" onContextMenuCapture={() => (picked.current = undefined)}>
        <div className={b.tools}>
          <span className={b.segment} role="radiogroup" aria-label="Show as">
            <button type="button" role="radio" aria-checked={!raw} className={cx(b.segmentItem, !raw && b.segmentOn)} onClick={() => setRaw(false)}>
              Tree
            </button>
            <button type="button" role="radio" aria-checked={raw} className={cx(b.segmentItem, raw && b.segmentOn)} onClick={() => setRaw(true)}>
              Raw
            </button>
          </span>
          <button type="button" className={b.tool} aria-label="Copy the JSON" onClick={() => copyNow(code)}>
            <Icon name={copied ? 'check' : 'copy'} size={12} />
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        {raw ? (
          <div className={b.jsonRaw}>
            <CodeLines text={doc.pretty} lang="json" />
          </div>
        ) : (
          <div className={b.jsonRows} role="tree" aria-label="JSON">
            <Node value={doc.value} depth={0} steps={[]} last isOpen={isOpen} toggle={toggle} onPick={(s) => (picked.current = s)} />
          </div>
        )}
      </div>
    </ActionsContext>
  );
});

interface NodeProps {
  readonly name?: string | number;
  readonly value: Json;
  readonly depth: number;
  readonly steps: readonly (string | number)[];
  readonly last: boolean;
  readonly isOpen: (key: string, depth: number) => boolean;
  readonly toggle: (key: string, depth: number) => void;
  readonly onPick: (steps: readonly (string | number)[]) => void;
}

function Indent({ depth }: { depth: number }) {
  return depth ? <span className={b.jsonIndent} style={{ '--depth': depth } as React.CSSProperties} aria-hidden="true" /> : null;
}

/** `"name": ` (an object's key) or nothing (an array's item, the root). */
function Key({ name }: { name: string | number | undefined }) {
  if (typeof name !== 'string') return null;
  return (
    <>
      <span className={b.jKey}>{JSON.stringify(name)}</span>
      <span className={b.jPunct}>: </span>
    </>
  );
}

function Node({ name, value, depth, steps, last, isOpen, toggle, onPick }: NodeProps) {
  const comma = last ? null : <span className={b.jPunct}>,</span>;
  if (value === null || typeof value !== 'object') {
    return (
      <div className={b.jsonRow} role="treeitem" aria-level={depth + 1} onContextMenu={() => onPick(steps)}>
        <Indent depth={depth} />
        <span className={b.jsonSpace} />
        <Key name={name} />
        <span className={b.jValue}>
          <Leaf value={value} />
          {comma}
        </span>
      </div>
    );
  }
  const key = steps.map(String).join('\u0000');
  const open = isOpen(key, depth);
  const array = Array.isArray(value);
  const entries: [string | number, Json][] = array ? (value as readonly Json[]).map((x, i) => [i, x]) : Object.entries(value);
  const [l, r] = array ? ['[', ']'] : ['{', '}'];
  const empty = entries.length === 0;
  const head = (
    <div className={cx(b.jsonRow, !empty && b.jsonFold)} role="treeitem" aria-level={depth + 1} {...(empty ? {} : { 'aria-expanded': open })} onClick={empty ? undefined : () => toggle(key, depth)} onContextMenu={() => onPick(steps)}>
      <Indent depth={depth} />
      {empty ? (
        <span className={b.jsonSpace} />
      ) : (
        <span className={cx(b.jsonToggle, open && b.jsonToggleOpen)} aria-hidden="true">
          <Icon name="chevronRight" size={9} />
        </span>
      )}
      <Key name={name} />
      {empty ? (
        <>
          <span className={b.jPunct}>{`${l}${r}`}</span>
          {comma}
        </>
      ) : open ? (
        <span className={b.jPunct}>{l}</span>
      ) : (
        <>
          <span className={b.jPreview}>{jsonPreview(value)}</span>
          {comma}
          <span className={b.jSize}>{jsonSize(value)}</span>
        </>
      )}
    </div>
  );
  if (empty || !open) return head;
  return (
    <>
      {head}
      <Children entries={entries} array={array} depth={depth} steps={steps} isOpen={isOpen} toggle={toggle} onPick={onPick} />
      <div className={b.jsonRow}>
        <Indent depth={depth} />
        <span className={b.jsonSpace} />
        <span className={b.jPunct}>{r}</span>
        {comma}
      </div>
    </>
  );
}

function Children({ entries, array, depth, steps, isOpen, toggle, onPick }: { entries: readonly [string | number, Json][]; array: boolean; depth: number; steps: readonly (string | number)[] } & Pick<NodeProps, 'isOpen' | 'toggle' | 'onPick'>) {
  const [shown, setShown] = useState(FIRST);
  const cut = array && entries.length > shown;
  const list = cut ? entries.slice(0, shown) : entries;
  return (
    <>
      {list.map(([k, x], i) => (
        <Node key={String(k)} name={k} value={x} depth={depth + 1} steps={[...steps, k]} last={!cut && i === list.length - 1} isOpen={isOpen} toggle={toggle} onPick={onPick} />
      ))}
      {cut ? (
        <div className={b.jsonRow}>
          <Indent depth={depth + 1} />
          <button type="button" className={b.jMore} onClick={() => setShown(entries.length)}>
            Show {entries.length - shown} more
          </button>
        </div>
      ) : null}
    </>
  );
}

function Leaf({ value }: { value: null | boolean | number | string }) {
  const [whole, setWhole] = useState(false);
  if (value === null) return <span className={b.jNull}>null</span>;
  if (typeof value === 'boolean') return <span className={b.jBool}>{String(value)}</span>;
  if (typeof value === 'number') return <span className={b.jNumber}>{String(value)}</span>;
  const text = JSON.stringify(value);
  if (text.length <= LONG || whole) return <span className={b.jString}>{text}</span>;
  return (
    <span className={b.jString}>
      {text.slice(0, LONG)}…
      <button type="button" className={b.jClip} onClick={(e) => (e.stopPropagation(), setWhole(true))} aria-label="Show the whole string">
        +{(text.length - LONG).toLocaleString()} chars
      </button>
    </span>
  );
}
