import { keepFriendOffer } from '../friend-offers.js';
import type { GitHubRepo } from '../../workspaces/github.js';
import type { NoticeEvent } from '../notify.js';
import { watchNetwork } from '../network.js';
import type { Store } from '../store.js';
import { TeamBoards, type TeamPart } from './service.js';

/**
 * Team boards for the daemon, whenever the network is on (core/team/service.ts). Started with the
 * board (core/board/launch.ts), which hands over what the parts need.
 */

const services = new WeakMap<object, TeamBoards>();

/** This session's team boards, or undefined while the network is off. */
export const teamOf = (session: object): TeamBoards | undefined => services.get(session);

/** This session's team boards, or a clear error while the network is off. */
export function needTeam(session: object): TeamBoards {
  const service = services.get(session);
  if (!service) throw new Error('Team boards need the Beluga network: turn it on in Settings › Network');
  return service;
}

export interface TeamHost {
  readonly session: object;
  readonly store: Store;
  /** Where its files live; null: memory only (the demo). */
  readonly dir: string | null;
  readonly repoOf: (projectId: string) => Promise<GitHubRepo | undefined>;
  readonly notify: (e: NoticeEvent) => void;
  readonly toast: (text: string, level: 'info' | 'success' | 'warn' | 'error') => void;
  /** The parts for one run of the service (board sync, plans…), made fresh each time the network starts. */
  readonly parts: (team: TeamBoards) => readonly TeamPart[];
}

export function launchTeam(host: TeamHost): () => void {
  const { session, store } = host;
  let current: TeamBoards | undefined;
  const off = watchNetwork(session, (service) => {
    current?.stop();
    services.delete(session);
    current = undefined;
    if (!service) return;
    const team = new TeamBoards({ store, mesh: service.mesh, dir: host.dir, repoOf: host.repoOf, notify: host.notify, toast: host.toast, onFriendAsk: (ask) => keepFriendOffer({ store, notify: host.notify }, ask) });
    for (const part of host.parts(team)) team.use(part);
    current = team;
    services.set(session, team);
    void team.start();
  });
  return () => {
    off();
    current?.stop();
    services.delete(session);
  };
}
