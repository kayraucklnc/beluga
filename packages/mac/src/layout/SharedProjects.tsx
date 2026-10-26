import type { SharedProject } from '@beluga/core/friend-share-store.js';
import { Icon } from '../components/Icon.js';
import { ActionsContext, ActionsDropdown, type ActionItem } from '../components/SpecMenu.js';
import { Avatar, IconButton, cx } from '../components/ui.js';
import pi from '../components/ProjectIcon.module.css';
import { useActions } from '../lib/actions.js';
import { toast, useApi, useApp, useBeluga } from '../lib/beluga.js';
import { getPrefs, setPrefs, usePrefs } from '../lib/prefs.js';
import { sameDeep } from '../lib/stable.js';
import { signalOf } from './attention-model.js';
import { SignalMark, nameClass, signalClass } from './signal-marks.js';
import { Row } from './sidebar-parts.js';
import { presenceOf } from './shared-presence.js';
import side from './Sidebar.module.css';
import g from './project-groups.module.css';
import s from './shared-projects.module.css';

/**
 * Projects friends shared with you over the network, in Projects with your own: one row per
 * project, the owner's avatar on its icon and "ata's" beside it, its worktrees nested under it as
 * yours are. It stays while the owner's Mac is offline ("ata is offline"); what you say there waits.
 */

const foldKey = (p: Pick<SharedProject, 'owner' | 'id'>): string => `shared:${p.owner}/${p.id}`;

const hue = (name: string): number => [...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 0);

/** The project's icon as its owner has it (or its initial), with the owner's avatar on its corner. */
function SharedIcon({ p, size = 16 }: { p: SharedProject; size?: number }) {
  const radius = Math.round(size * 0.24);
  return (
    <span className={s.icon}>
      {p.icon ? (
        <img className={pi.image} src={`data:${p.icon.mime};base64,${p.icon.data}`} alt="" width={size} height={size} style={{ borderRadius: radius }} draggable={false} />
      ) : (
        <span className={pi.tile} style={{ width: size, height: size, borderRadius: radius, fontSize: size * 0.58, ['--h' as string]: hue(p.name) }} aria-hidden="true">
          {(p.name.match(/[a-z0-9]/i)?.[0] ?? '?').toUpperCase()}
        </span>
      )}
      <span className={s.badge}>
        <Avatar name={p.ownerName} id={p.owner} size={10} />
      </span>
    </span>
  );
}

function SharedProjectBlock({ p }: { p: SharedProject }) {
  const actions = useActions();
  const api = useApi();
  const { client } = useBeluga();
  const open = usePrefs().openProjects.includes(foldKey(p));
  const view = useApp((st) => st.view);
  const owner = useApp((st) => presenceOf(st, p.owner), sameDeep);
  const rows = useApp((st) => p.worktrees.map((w) => ({ w, signal: signalOf(st, `ws:${w.id}`) })), sameDeep);
  const here = view.kind === 'shared' && view.owner === p.owner ? view.id : undefined;
  const toggle = (): void => {
    const rest = getPrefs().openProjects.filter((k) => k !== foldKey(p));
    setPrefs({ openProjects: open ? rest : [...rest, foldKey(p)] });
  };
  const leave = (): void => void api.sharing.leaveProject(p.owner, p.id).catch((err: unknown) => toast(client, err instanceof Error ? err.message : String(err), 'error'));
  const items: ActionItem[] = [{ label: 'Leave Project', icon: 'x', danger: true, onSelect: leave }];
  const detail = owner.state === 'offline' ? `${p.ownerName} is offline` : owner.state === 'update' ? `${p.ownerName}'s Beluga needs an update` : `${p.ownerName}'s · ${p.role === 'contribute' ? 'you can work here' : 'you can follow along'}`;
  const shown = open ? rows : rows.filter((r) => r.w.id === here);
  return (
    <>
      <ActionsContext items={items}>
        <Row
          className={cx(side.projectRow, here && side.currentProject, owner.state === 'offline' && s.away)}
          aria-expanded={rows.length ? open : undefined}
          aria-label={`${p.name}, shared by ${p.ownerName}`}
          icon={
            <span className={g.projectIcon}>
              {rows.length ? (
                <button type="button" className={g.foldButton} aria-label={open ? `Fold ${p.name}` : `Show what's in ${p.name}`} onClick={(e) => (e.stopPropagation(), toggle())}>
                  <Icon name="chevronRight" size={9} className={cx(g.disclosure, open && g.disclosureOpen)} />
                </button>
              ) : (
                <span className={g.foldButton} aria-hidden="true" />
              )}
              <SharedIcon p={p} />
            </span>
          }
          label={
            <span>
              {p.name}
              <span className={s.whose}> · {p.ownerName}'s</span>
            </span>
          }
          detail={detail}
          onClick={toggle}
          trailing={
            <>
              <span className={side.hoverTools}>
                <ActionsDropdown items={items}>
                  <IconButton icon="more" label={`More for ${p.name}`} onClick={(e) => e.stopPropagation()} />
                </ActionsDropdown>
              </span>
            </>
          }
        />
      </ActionsContext>
      {shown.map(({ w, signal }) => {
        const selected = here === w.id;
        return (
          <Row
            key={w.id}
            indent={2}
            selected={selected}
            className={signalClass(signal, selected)}
            data-signal-row={signal.level}
            aria-label={w.name}
            icon={<Icon name={w.branch ? 'branch' : 'chat'} size={13} />}
            label={<span className={nameClass(signal)}>{w.name}</span>}
            detail={signal.tip || (w.branch ? `${p.ownerName}'s ${w.branch}` : `${p.ownerName}'s chat`)}
            onClick={() => actions.run({ type: 'open_shared', owner: p.owner, id: w.id, tab: 'chat' })}
            trailing={<SignalMark signal={signal} />}
          />
        );
      })}
    </>
  );
}

export function SharedProjects() {
  const projects = useApp((st) => st.sharedProjects);
  if (!projects.length) return null;
  return (
    <div role="group" aria-label="Shared with you by friends">
      {projects.map((p) => (
        <SharedProjectBlock key={foldKey(p)} p={p} />
      ))}
    </div>
  );
}
