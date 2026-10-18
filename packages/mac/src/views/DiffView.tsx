import { useMemo, useState } from 'react';
import { type DiffLine as Line, parseDiff } from '@klaud/shared/diff-lines.js';
import type { ChangedFile } from '@klaud/workspaces/git.js';
import { Icon } from '../components/Icon.js';
import { Button, Empty, Segmented, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApp } from '../lib/klaud.js';
import s from './diff.module.css';

/** Side by side: deletions on the left, additions on the right, aligned within each change. */
function splitRows(lines: Line[]): Array<{ left?: Line; right?: Line; full?: Line }> {
  const rows: Array<{ left?: Line; right?: Line; full?: Line }> = [];
  let dels: Line[] = [];
  let adds: Line[] = [];
  const flush = (): void => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) rows.push({ ...(dels[i] ? { left: dels[i] } : {}), ...(adds[i] ? { right: adds[i] } : {}) });
    dels = [];
    adds = [];
  };
  for (const l of lines) {
    if (l.kind === 'del') dels.push(l);
    else if (l.kind === 'add') adds.push(l);
    else {
      flush();
      if (l.kind === 'ctx') rows.push({ left: l, right: l });
      else rows.push({ full: l });
    }
  }
  flush();
  return rows;
}

const STATE: Record<ChangedFile['state'], { letter: string; tone: string }> = {
  modified: { letter: 'M', tone: s.modified! },
  added: { letter: 'A', tone: s.added! },
  untracked: { letter: 'U', tone: s.added! },
  deleted: { letter: 'D', tone: s.deleted! },
  renamed: { letter: 'R', tone: s.modified! },
};

/** What changed in a workspace (or one shared with you): the files, then the selected file's diff. */
export function DiffView() {
  const actions = useActions();
  const review = useApp((st) => st.review);
  const view = useApp((st) => st.view);
  const [mode, setMode] = useState<'unified' | 'split'>('unified');
  const lines = useMemo(() => (review?.diff ? parseDiff(review.diff) : []), [review?.diff]);
  const files = review?.data?.files ?? [];
  const totals = files.reduce((t, f) => ({ add: t.add + f.added, del: t.del + f.removed }), { add: 0, del: 0 });
  const mine = view.kind === 'workspace';
  if (!review || (review.loading && !review.data)) return <Empty icon="diff" title="Looking at what changed…" />;
  if (review.error) return <Empty icon="alert" title="Couldn't read the changes" detail={review.error} />;
  if (!files.length) return <Empty icon="check" title="Nothing has changed yet" detail={review.data ? `Everything matches ${review.data.base}.` : undefined} />;
  const file = files[review.selected];
  return (
    <div className={s.diff}>
      <aside className={s.files} aria-label="Changed files">
        <div className={s.filesHead}>
          <span>
            {files.length} file{files.length === 1 ? '' : 's'}
          </span>
          <span className={s.add}>+{totals.add}</span>
          <span className={s.del}>−{totals.del}</span>
        </div>
        {review.data?.commits.length ? (
          <div className={s.commits}>
            {review.data.commits.slice(0, 6).map((c) => (
              <div key={c.hash} className={s.commit} title={c.subject}>
                <span className={s.hash}>{c.hash}</span> {c.subject}
              </div>
            ))}
          </div>
        ) : null}
        <div className={s.fileList} role="listbox" aria-label="Files">
          {files.map((f, i) => {
            const st = STATE[f.state];
            const name = f.path.split('/').pop();
            const dir = f.path.slice(0, f.path.length - (name?.length ?? 0));
            return (
              <div key={f.path} role="option" aria-selected={i === review.selected} className={cx(s.file, i === review.selected && s.fileOn)} onClick={() => actions.run({ type: 'review_file', index: i })} title={f.path}>
                <span className={cx(s.letter, st.tone)}>{st.letter}</span>
                <span className={s.fileName}>
                  {name}
                  <span className={s.dir}>{dir}</span>
                </span>
                <span className={s.add}>{f.added ? `+${f.added}` : ''}</span>
                <span className={s.del}>{f.removed ? `−${f.removed}` : ''}</span>
              </div>
            );
          })}
        </div>
        {mine ? (
          <div className={s.filesFoot}>
            <Button icon="spark" onClick={() => actions.run({ type: 'ws', id: view.id, action: 'review_claude' })}>
              Ask Claude to review
            </Button>
          </div>
        ) : null}
      </aside>
      <section className={s.body} aria-label={file?.path ?? 'Diff'}>
        <div className={s.bodyHead}>
          <Icon name="file" size={13} />
          <span className={s.path}>{file?.path}</span>
          <span className={s.flex} />
          <Segmented
            label="Layout"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'unified', label: 'Unified' },
              { value: 'split', label: 'Split' },
            ]}
          />
        </div>
        <div className={`${s.code} selectable`}>
          {!review.diff ? (
            <div className={s.loadingDiff}>Loading the diff…</div>
          ) : mode === 'unified' ? (
            <table className={s.table}>
              <tbody>
                {lines.map((l, i) =>
                  l.kind === 'hunk' || l.kind === 'meta' ? (
                    <tr key={i} className={s.hunk}>
                      <td colSpan={3}>{l.text}</td>
                    </tr>
                  ) : (
                    <tr key={i} className={s[`l_${l.kind}`]}>
                      <td className={s.num}>{l.old ?? ''}</td>
                      <td className={s.num}>{l.new ?? ''}</td>
                      <td className={s.text}>
                        <span className={s.sign}>{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
                        {l.text || ' '}
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          ) : (
            <table className={cx(s.table, s.split)}>
              <tbody>
                {splitRows(lines).map((r, i) =>
                  r.full ? (
                    <tr key={i} className={s.hunk}>
                      <td colSpan={4}>{r.full.text}</td>
                    </tr>
                  ) : (
                    <tr key={i}>
                      <td className={cx(s.num, r.left && s[`l_${r.left.kind}`])}>{r.left?.old ?? ''}</td>
                      <td className={cx(s.text, r.left ? s[`l_${r.left.kind}`] : s.blank)}>{r.left?.text ?? ''}</td>
                      <td className={cx(s.num, r.right && s[`l_${r.right.kind}`])}>{r.right?.new ?? ''}</td>
                      <td className={cx(s.text, r.right ? s[`l_${r.right.kind}`] : s.blank)}>{r.right?.text ?? ''}</td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}
