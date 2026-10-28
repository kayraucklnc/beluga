import { Fragment, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { localDirKey } from '@beluga/core/local-key.js';
import { workspaceMentions } from '@beluga/core/mentions.js';
import { mentionDir, suggest, type Suggestion } from '@beluga/ui/suggest.js';
import { shareNameOf } from '@beluga/shared/share-names.js';
import { cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApi, useApp, useBeluga } from '../lib/beluga.js';
import { handleInvite } from '../lib/invite-command.js';
import { MAX_LISTED, SuggestionBody, sectionOf } from './Suggestions.js';
import s from './composer.module.css';

/**
 * The chat box's / and @ suggestions for another text box (the project home's New Worktree):
 * commands, people, projects, and with `filesOf` a folder's files for "@src/au". Returns the
 * list to draw (above the box) and a key handler that says whether it took the key.
 */
export function useBoxSuggestions({ text, setText, filesOf }: { text: string; setText: (text: string) => void; filesOf?: string | undefined }): { list: ReactNode; onKey: (e: React.KeyboardEvent) => boolean } {
  const api = useApi();
  const { client, ui } = useBeluga();
  const actions = useActions();
  const state = useApp((st) => st);
  const [selected, setSelected] = useState(0);
  const [hidden, setHidden] = useState(false);
  const share = filesOf ? shareNameOf(filesOf) : undefined;
  const atDir = share ? mentionDir(text) : undefined;
  useEffect(() => {
    if (share && atDir !== undefined) void api.files.loadDir({ owner: state.selfId, share, path: atDir });
  }, [share, atDir, state.selfId]);
  useEffect(() => {
    setHidden(false);
    setSelected(0);
  }, [text]);
  const suggestions: Suggestion[] = useMemo(
    () =>
      hidden || !text
        ? []
        : suggest(text, {
            peers: state.peers,
            selfId: state.selfId,
            dirCache: state.dirCache,
            listLocalDirs: (dir) => state.dirCache[localDirKey(dir)] ?? [],
            workspaces: workspaceMentions(state.projects),
            friends: state.network.friends,
            projects: state.projects.filter((p) => p.root),
            ...(share ? { entries: (dir: string) => state.dirCache[`${state.selfId}:${share}/${dir}`] } : {}),
          }),
    [text, hidden, state.peers, state.selfId, state.dirCache, state.projects, state.network.friends, share],
  );
  const listed = Math.min(suggestions.length, MAX_LISTED);
  const pick = Math.min(selected, Math.max(0, listed - 1));
  const ref = useRef<HTMLDivElement>(null);
  const byKeys = useRef(false);
  useLayoutEffect(() => {
    if (byKeys.current) ref.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [pick, listed]);
  const accept = (sug: Suggestion): void => {
    if (sug.enter === 'submit') {
      setText('');
      // "/invite @ata" picked here does what typing it does (BLG-340): the daemon can't see what's on screen.
      if (!handleInvite(client, ui, sug.value)) actions.submit(sug.value);
      return;
    }
    setText(sug.value);
  };
  const onKey = (e: React.KeyboardEvent): boolean => {
    if (!suggestions.length || e.nativeEvent.isComposing) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      byKeys.current = true;
      setSelected((n) => (Math.min(n, listed - 1) + (e.key === 'ArrowDown' ? 1 : -1) + listed) % listed);
    } else if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && suggestions[pick]?.value !== text)) accept(suggestions[pick]!);
    else if (e.key === 'Escape') setHidden(true);
    else return false;
    e.preventDefault();
    return true;
  };
  const list = suggestions.length ? (
    <div ref={ref} className={s.suggestions} role="listbox" aria-label="Suggestions">
      {suggestions.slice(0, MAX_LISTED).map((sug, i, all) => (
        <Fragment key={`${sug.value}:${i}`}>
        {sectionOf(sug, all[i - 1]) ? (
          <div className={s.sugSection} role="presentation">
            {sectionOf(sug, all[i - 1])}
          </div>
        ) : null}
        <div
          role="option"
          aria-selected={i === pick}
          className={cx(s.suggestion, (sug.task || sug.kind) && s.sugTask, i === pick && s.suggestionOn)}
          onMouseEnter={() => {
            byKeys.current = false;
            setSelected(i);
          }}
          onMouseDown={(e) => (e.preventDefault(), accept(sug))}
        >
          <SuggestionBody sug={sug} />
        </div>
        </Fragment>
      ))}
    </div>
  ) : null;
  return { list, onKey };
}
