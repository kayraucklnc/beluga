import type { NoticeEvent } from '../../src/core/notify.js';
import { Board } from '../../src/core/board/board.js';
import { keepFriendOffer } from '../../src/core/friend-offers.js';
import { Store, initialState } from '../../src/core/store.js';
import { TeamBoards, type TeamPart } from '../../src/core/team/service.js';
import type { Project } from '../../src/workspaces/types.js';
import type { MeshOptions } from '../../src/net/mesh/mesh.js';
import type { Crowd, Person } from '../mesh/helpers.js';

/**
 * One simulated Mac with team boards: a mesh node on the local testnet, its own store and board
 * (in memory), projects on GitHub as given, and core/team between them. `restart` is quitting
 * Beluga and opening it again: same identity and files (the board stays as it was in memory, as
 * board.json would keep it).
 */

export interface RepoProject {
  readonly id: string;
  readonly name: string;
  /** "acme/api" on github.com. */
  readonly repo?: string;
}

export interface TeamMac {
  readonly name: string;
  readonly person: Person;
  readonly store: Store;
  readonly board: Board;
  readonly id: string;
  readonly notices: NoticeEvent[];
  team: TeamBoards;
  stop(): Promise<void>;
  start(): Promise<void>;
  close(): Promise<void>;
}

export type PartsFor = (m: { team: TeamBoards; store: Store; board: Board; name: string; id: string; dir: string }) => readonly TeamPart[];

export async function teamMac(net: Crowd, name: string, projects: readonly RepoProject[], parts: PartsFor = () => [], extra: Partial<MeshOptions> = {}): Promise<TeamMac> {
  const person = await net.add(name, extra);
  const store = new Store(initialState('test', 'ask'));
  const list = projects.map((p) => ({ id: p.id, name: p.name, root: `/tmp/${name}/${p.name}`, base: 'origin/main', workspaces: [] }) as unknown as Project);
  store.dispatch({ type: 'projects', projects: list });
  store.dispatch({ type: 'identity', selfId: person.identity.peerId, isHost: false });
  const board = new Board({ store, dir: null, projectName: (id) => store.getState().projects.find((p) => p.id === id)?.name });
  const notices: NoticeEvent[] = [];
  const sync = (): void => store.dispatch({ type: 'net_summary', summary: person.mesh.summary() });
  const boot = async (): Promise<TeamBoards> => {
    person.mesh.on('change', sync);
    sync();
    const team = new TeamBoards({
      store,
      mesh: person.mesh,
      dir: person.dir,
      repoOf: async (id) => {
        const repo = projects.find((p) => p.id === id)?.repo;
        if (!repo) return undefined;
        const [owner, r] = repo.split('/') as [string, string];
        return { host: 'github.com', owner, repo: r, url: `https://github.com/${repo}` };
      },
      notify: (e) => notices.push(e),
      onFriendAsk: (ask) => keepFriendOffer({ store, notify: (e) => notices.push(e) }, ask),
    });
    for (const part of parts({ team, store, board, name, id: person.identity.peerId, dir: person.dir })) team.use(part);
    await team.start();
    return team;
  };
  const m: TeamMac = {
    name,
    person,
    store,
    board,
    id: person.identity.peerId,
    notices,
    team: await boot(),
    stop: async () => {
      m.team.stop();
      person.mesh.off('change', sync);
      await person.stop();
    },
    start: async () => {
      await person.start();
      m.team = await boot();
    },
    close: async () => {
      m.team.stop();
    },
  };
  return m;
}

/** The person whose Claude / name is shown for someone: a board actor. */
export const personOf = (m: TeamMac) => ({ kind: 'person' as const, id: m.id, name: m.name });
