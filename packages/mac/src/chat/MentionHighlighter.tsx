import { type RefObject, useEffect, useMemo, useRef } from 'react';
import { type MentionPiece, type MentionWorld, splitMentions } from './mentions.js';
import m from './mention.module.css';

/** "[image 2]" in the words: the pasted image it points at, marked like a mention. */
const IMAGE_REF = /\[image \d+\]/g;

function withImages(piece: MentionPiece): MentionPiece[] {
  if ('ref' in piece) return [piece];
  const out: MentionPiece[] = [];
  let last = 0;
  for (const m of piece.text.matchAll(IMAGE_REF)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: piece.text.slice(last, at) });
    out.push({ raw: m[0], ref: { kind: 'image', label: m[0] } });
    last = at + m[0].length;
  }
  if (last < piece.text.length) out.push({ text: piece.text.slice(last) });
  return out;
}

/**
 * Behind the message box: the same text, invisible, with every mention that names someone or
 * something marked, so "@mia" or "@src/auth.ts" shows as a pill while you type. It follows the
 * box's scrolling; the box itself stays a plain text field (typing, selection, undo as usual).
 */
export function MentionHighlighter({ text, world, input, className }: { text: string; world: MentionWorld; input: RefObject<HTMLTextAreaElement | null>; className: string }) {
  const layer = useRef<HTMLDivElement>(null);
  const pieces = useMemo(() => splitMentions(text, world).flatMap(withImages), [text, world]);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    const follow = (): void => {
      if (layer.current) layer.current.scrollTop = el.scrollTop;
    };
    follow();
    el.addEventListener('scroll', follow);
    return () => el.removeEventListener('scroll', follow);
  }, [input, text]);
  if (!pieces.some((p) => 'ref' in p)) return null;
  return (
    <div ref={layer} className={`${className} ${m.highlighter}`} aria-hidden="true" data-testid="mention-highlighter">
      {pieces.map((p, i) =>
        'ref' in p ? (
          <mark key={i} className={m.mark} data-kind={p.ref.kind} data-mention={p.raw}>
            {p.raw}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
      {/* A last line that ends in a newline still takes its height. */}
      {'​'}
    </div>
  );
}
