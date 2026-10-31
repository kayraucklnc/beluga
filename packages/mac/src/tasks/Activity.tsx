import { useRef, useState } from 'react';
import { type Activity as Entry, type ActivityKind, type Issue, activityText, actorName } from '@beluga/core/board/model.js';
import { useBoxSuggestions } from '../chat/BoxSuggestions.js';
import { Markdown } from '../chat/Markdown.js';
import { MentionHighlighter } from '../chat/MentionHighlighter.js';
import type { MentionWorld } from '../chat/mentions.js';
import { Icon, type IconName } from '../components/Icon.js';
import { Avatar, Button, cx } from '../components/ui.js';
import { ago } from './tasks-model.js';
import { useTaggable } from './use-taggable.js';
import { useSelf, useTaskActions } from './use-tasks.js';
import { useApp } from '../lib/beluga.js';
import { useMyAgent } from '../lib/agent-words.js';
import t from './tasks.module.css';

/**
 * What happened to a task, oldest first: changes as quiet lines ("Beluga moved this to In
 * Review"), comments and Claude's notes as messages. A comment box at the end (⌘↩ sends), where
 * "@" names a teammate or a friend (BLG-419): they're told they were mentioned.
 */

const KIND_ICON: Partial<Record<ActivityKind, IconName>> = {
  created: 'plus',
  status: 'task',
  priority: 'gauge',
  assignee: 'person',
  labels: 'tag',
  brief: 'pencil',
  relation: 'link',
  link: 'refresh',
  worktree: 'branch',
  pr: 'pr',
  proof: 'image',
  due: 'calendar',
  parent: 'outline',
};

function Who({ entry, selfId }: { entry: Entry; selfId: string }) {
  const by = entry.by;
  const mine = useMyAgent();
  if (by.kind === 'person') return <Avatar name={by.name} id={by.id} size={20} />;
  // The agent the board recorded (BLG-498); an older entry: yours, your agent's mark; someone else's, the Claude mark.
  if (by.kind === 'claude') return <Avatar name={by.ownerName} id={by.owner} claude agent={by.agent ?? (by.owner === selfId ? mine : undefined)} size={20} />;
  return (
    <span className={t.belugaMark} aria-label={actorName(by, selfId)}>
      <Icon name="claude" size={11} />
    </span>
  );
}

export function ActivityFeed({ issue }: { issue: Issue }) {
  const self = useSelf();
  const selfId = self.id;
  const projectName = useApp((s) => s.projects.find((p) => p.id === issue.projectId)?.name);
  const tagged = useTaggable(issue.projectId, selfId, projectName, self.name);
  const [all, setAll] = useState(false);
  const entries = issue.activity;
  const hidden = all ? 0 : Math.max(0, entries.length - 30);
  return (
    <div className={t.activity}>
      {hidden ? (
        <button type="button" className={t.activityMore} onClick={() => setAll(true)}>
          Show {hidden} earlier
        </button>
      ) : null}
      <ol className={t.activityList}>
        {entries.slice(hidden).map((e) =>
          e.body ? (
            <li key={e.id} className={cx(t.comment, e.kind === 'note' && t.commentNote)}>
              <Who entry={e} selfId={selfId} />
              <div className={t.commentBubble}>
                <div className={t.commentHead}>
                  <span className={t.activityWho}>{actorName(e.by, selfId)}</span>
                  <span className={t.activityWhen}>{ago(e.at)}</span>
                </div>
                <div className={t.commentBody}>
                  <Markdown text={e.body} paths tasks mentions={tagged.shown} />
                </div>
              </div>
            </li>
          ) : (
            <li key={e.id} className={t.event}>
              <span className={t.eventIcon}>
                <Icon name={KIND_ICON[e.kind] ?? 'info'} size={11} />
              </span>
              <span className={t.eventText}>
                <span className={t.activityWho}>{actorName(e.by, selfId)}</span> {activityText(e, selfId)}
              </span>
              <span className={t.activityWhen}>{ago(e.at)}</span>
            </li>
          ),
        )}
      </ol>
      <CommentBox issue={issue} people={tagged.people} world={tagged.world} />
    </div>
  );
}

function CommentBox({ issue, people, world }: { issue: Issue; people: ReadonlyArray<{ name: string; hint: string }>; world: MentionWorld }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const { api, act } = useTaskActions();
  const box = useRef<HTMLTextAreaElement>(null);
  const tags = useBoxSuggestions({ text, setText, people });
  const send = async (): Promise<void> => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    const done = await act(() => api.comment(issue.id, body));
    setBusy(false);
    if (done) setText('');
  };
  return (
    <div className={t.commentBox}>
      <div className={t.commentInput}>
        <MentionHighlighter text={text} world={world} input={box} className={t.commentLayer!} />
        <textarea
          ref={box}
          value={text}
          rows={text.includes('\n') ? 4 : 2}
          placeholder="Leave a comment… @ mentions someone"
          aria-label="Comment"
          aria-haspopup="listbox"
          aria-expanded={tags.open}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || tags.onKey(e)) return;
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {tags.list}
      </div>
      <div className={t.commentBar}>
        <span className={t.editorHint}>⌘↩ to send · @ mentions · Markdown</span>
        <span className={t.grow} />
        <Button size="small" variant="primary" disabled={!text.trim() || busy} onClick={() => void send()}>
          Comment
        </Button>
      </div>
    </div>
  );
}
