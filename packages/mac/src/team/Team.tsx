import { OFFER_DETAIL, offerWords, teammatesOf, workingOn, workingWords } from '@beluga/core/team/model.js';
import { ActionsDropdown, type ActionItem } from '../components/SpecMenu.js';
import { Avatar, Button, IconButton } from '../components/ui.js';
import { AvatarStack } from '../network/Avatars.js';
import { toast, useApi, useApp, useBeluga } from '../lib/beluga.js';
import { sameDeep } from '../lib/stable.js';
import s from './team.module.css';

/**
 * Team boards on the Mac (core/team): the offer to team up with a friend on the same GitHub
 * repository (one main action, Team Up; Not Now behind •••), the teammates' avatars on a project,
 * and who's working on a task.
 */

/** Say what went wrong in a toast. */
function useSay(): (p: Promise<unknown>) => void {
  const { client } = useBeluga();
  return (p) => void p.catch((err: unknown) => toast(client, err instanceof Error ? err.message : String(err), 'error'));
}

/** Offers to team up on this project waiting on you (or on them, quietly). */
export function TeamOffers({ projectId }: { projectId: string }) {
  const offers = useApp((st) => st.team.offers.filter((o) => o.projectId === projectId), sameDeep);
  const api = useApi();
  const say = useSay();
  if (!offers.length) return null;
  return (
    <div className={s.list}>
      {offers.map((o) => {
        const more: ActionItem[] = [{ label: o.state === 'asked' ? 'Take Back' : 'Not Now', onSelect: () => say(api.team.answer(o.peerId, o.projectId, false)) }];
        return (
          <section key={`${o.peerId}:${o.projectId}`} className={s.offer} aria-label={offerWords(o)}>
            <Avatar name={o.name} id={o.peerId} size={26} />
            <div className={s.offerText}>
              <span className={s.offerTitle}>{offerWords(o)}</span>
              <span className={s.offerDetail}>{o.state === 'asked' ? 'The team forms when they say yes too.' : OFFER_DETAIL}</span>
            </div>
            {o.state === 'asked' ? null : (
              <Button variant="primary" icon="people" onClick={() => say(api.team.answer(o.peerId, o.projectId, true))}>
                Team Up
              </Button>
            )}
            <ActionsDropdown items={more}>
              <IconButton icon="more" label="More" />
            </ActionsDropdown>
          </section>
        );
      })}
    </div>
  );
}

/** A project's teammates as small avatars (the team badge on its row). */
export function TeamBadge({ projectId }: { projectId: string }) {
  const team = useApp((st) => st.team.teams[projectId], sameDeep);
  if (!team?.mates.length) return null;
  const names = team.mates.map((m) => m.name).join(', ');
  return (
    <span className={s.badge} title={`Team on ${team.repo}: you and ${names}`} aria-label={`Team on ${team.repo} with ${names}`} role="img">
      <AvatarStack people={team.mates} size={13} max={3} />
    </span>
  );
}

/** "Leave Team" (one item per teammate when there are several) for a project's menu. */
export function useTeamMenuItems(projectId: string): readonly ActionItem[] {
  const mates = useApp((st) => teammatesOf(st.team, projectId), sameDeep);
  const api = useApi();
  const say = useSay();
  if (!mates.length) return [];
  if (mates.length === 1) return [{ label: `Leave Team with ${mates[0]!.name}`, icon: 'people', separate: true, onSelect: () => say(api.team.leave(projectId)) }];
  return [{ label: 'Leave Team', icon: 'people', separate: true, onSelect: () => say(api.team.leave(projectId)) }];
}

/** "Ata is working on this" with their avatars, for a task. */
export function WorkingOn({ issueId }: { issueId: string }) {
  const people = useApp((st) => workingOn(st.team, issueId), sameDeep);
  const words = workingWords(people.map((p) => p.name));
  if (!words) return null;
  return (
    <span className={s.working}>
      <AvatarStack people={people} size={14} max={3} />
      {words}
    </span>
  );
}

/** A teammate working on a task, as their avatars only (a row in Tasks). */
export function WorkingMark({ issueId }: { issueId: string }) {
  const people = useApp((st) => workingOn(st.team, issueId), sameDeep);
  const words = workingWords(people.map((p) => p.name));
  if (!words) return null;
  return (
    <span className={s.badge} title={words} aria-label={words} role="img">
      <AvatarStack people={people} size={14} max={2} />
    </span>
  );
}
