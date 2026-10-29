import { Board } from '../board/board.js';
import { demoRepo } from '../issues/demo.js';
import { Store, initialState } from '../store.js';
import type { Mesh } from '../../net/mesh/mesh.js';
import type { Project } from '../../workspaces/types.js';
import { TeamBoardSync } from './board-sync.js';
import { TeamKnocks } from './knock.js';
import { TeamBoards } from './service.js';

/**
 * BELUGA_DEMO_SCENE=team (BLG-417): bob's Mac runs team boards of its own for the demo's bob-api,
 * so knocking can be seen and tested end to end. bob asks to team up (Team Up on your Tasks); once
 * you're a team he works on "Rate-limit the login endpoint" in a worktree of his (Knock to Join on
 * its page; he lets you in as an editor), and knocks on your worktree doing "Idempotent webhook
 * retries" (its card in that worktree's chat, the bell).
 */

const PROJECT = 'pb-demo';
const MY_TASK = 'Rate-limit the login endpoint';
const YOUR_TASK = 'Idempotent webhook retries';
const BOB_WS = 'bob-rate-limit';

export async function startDemoTeam(bob: Mesh, meId: string, dir: string): Promise<() => void> {
  const store = new Store(initialState('demo-bob', 'ask'));
  store.dispatch({ type: 'projects', projects: [{ id: PROJECT, name: 'api', root: `${dir}/api`, base: 'origin/main', workspaces: [] } as unknown as Project] });
  store.dispatch({ type: 'identity', selfId: bob.peerId, isHost: false });
  const sync = (): void => store.dispatch({ type: 'net_summary', summary: bob.summary() });
  bob.on('change', sync);
  sync();
  const board = new Board({ store, dir: null, projectName: () => 'api' });
  const live = new Set<string>();
  const team = new TeamBoards({ store, mesh: bob, dir: null, repoOf: async (id) => (id === PROJECT ? demoRepo('bob-api') : undefined) });
  const knocks = new TeamKnocks(team, { board, store, live: (id) => live.has(id), letIn: () => undefined, dir: null });
  team.use(new TeamBoardSync(team, { board, live: (id) => live.has(id), dir: null }));
  team.use(knocks);
  await team.start();
  // Let in to your worktree, it's shared with him (his Mac takes it; the demo doesn't open it).
  bob.offer(['share.project'], true);

  const timers: NodeJS.Timeout[] = [];
  const later = (ms: number, fn: () => void): void => void timers.push(setTimeout(fn, ms).unref());
  const bobActor = { kind: 'person' as const, id: bob.peerId, name: 'bob' };
  let asked = false;
  let working = false;
  let knocked = false;
  const answered = new Set<string>();
  const step = (): void => {
    const st = store.getState();
    // Your Mac found the shared repository: bob says yes (first, or to your Team Up).
    const offer = st.team.offers.find((o) => o.peerId === meId && o.state !== 'asked');
    if (offer && (!asked || offer.state === 'invited')) {
      asked = true;
      team.answer(meId, PROJECT, true);
    }
    if (!team.teamed(PROJECT)) return;
    const mine = board.list().find((i) => i.title === MY_TASK);
    if (mine && !working) {
      working = true;
      live.add(BOB_WS);
      board.linkWorktree(mine.id, BOB_WS, { name: 'rate-limit-login' }, bobActor);
    }
    const yours = board.list().find((i) => i.title === YOUR_TASK);
    if (yours && !knocked && st.team.working[yours.id]?.some((p) => p.peerId === meId)) {
      knocked = true;
      later(1500, () => knocks.knock(yours.id, meId, 'I wrote the Stripe client, happy to pair on retries'));
    }
    // Your knock on his worktree: he lets you in after a moment.
    for (const k of st.team.knocks ?? [])
      if (!answered.has(k.id)) {
        answered.add(k.id);
        later(2500, () => {
          try {
            knocks.answer(k.id, 'contribute');
          } catch {
            // Taken back meanwhile.
          }
        });
      }
  };
  const tick = setInterval(step, 1000);
  tick.unref();
  return () => {
    clearInterval(tick);
    for (const t of timers) clearTimeout(t);
    bob.off('change', sync);
    team.stop();
  };
}
