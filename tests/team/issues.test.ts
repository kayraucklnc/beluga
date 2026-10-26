import { afterEach, describe, expect, it } from 'vitest';
import { BoardWork } from '../../src/core/board/work.js';
import { GitHubIssues } from '../../src/core/issues/issues.js';
import type { GhIssueFull } from '../../src/core/issues/model.js';
import { TeamBoardSync } from '../../src/core/team/board-sync.js';
import { teammateOn } from '../../src/core/team/model.js';
import { type Crowd, befriend, crowd, settle } from '../mesh/helpers.js';
import { type PartsFor, type TeamMac, personOf, teamMac } from './helpers.js';

/** BLG-224: teammates see who's on which GitHub issue, and starting one a teammate is on asks first. */

let net: Crowd | undefined;
const macs: TeamMac[] = [];

afterEach(async () => {
  for (const m of macs.splice(0)) await m.close();
  await net?.close();
  net = undefined;
});

const live = new Set<string>();
const parts: PartsFor = ({ team, board, dir }) => [new TeamBoardSync(team, { board, live: (id) => live.has(id), dir })];

const issue48 = { number: 48, title: 'Login fails behind the proxy', state: 'open', url: 'https://github.com/acme/api/issues/48', labels: [], assignees: [], comments: 0, createdAt: 1, updatedAt: 2, body: 'It fails', thread: [] } as unknown as GhIssueFull;

describe('team issues', () => {
  it('an issue a teammate works on says so on the other Mac, and starting it there asks first', async () => {
    net = await crowd();
    const ata = await teamMac(net, 'ata', [{ id: 'pa', name: 'api', repo: 'acme/api' }], parts);
    const kay = await teamMac(net, 'kay', [{ id: 'pk', name: 'api', repo: 'acme/api' }], parts);
    macs.push(ata, kay);
    await befriend(ata.person, kay.person);
    await settle(() => ata.store.getState().team.offers[0] && kay.store.getState().team.offers[0]);
    ata.team.answer(kay.id, 'pa', true);
    await settle(() => kay.store.getState().team.offers[0]?.state === 'invited');
    kay.team.answer(ata.id, 'pk', true);
    await settle(() => ata.store.getState().team.teams.pa && kay.store.getState().team.teams.pk);

    // Ata makes the issue's task and investigates it in a worktree of ata's.
    const t = ata.board.create({ projectId: 'pa', title: issue48.title, github: { repo: 'acme/api', number: 48, url: issue48.url } }, personOf(ata), 'github');
    live.add('ws-ata');
    ata.board.linkWorktree(t.id, 'ws-ata', { name: 'investigate-48' }, personOf(ata));
    ata.board.setGitHub(t.id, { repo: 'acme/api', number: 48, url: issue48.url, step: 'investigate', investigated: true }, personOf(ata), 'asked Claude to investigate #48');

    // Kay's board has which team task #48 became, and who's on it.
    const there = await settle(() => (kay.board.get(t.id)?.github?.step === 'investigate' && kay.store.getState().team.working[t.id]?.length ? kay.board.get(t.id) : undefined));
    expect(there.github).toMatchObject({ repo: 'acme/api', number: 48 });
    expect(teammateOn(kay.store.getState().team, there, kay.id)).toMatchObject({ name: 'ata', words: 'ata is investigating #48' });
    expect(there.activity.some((a) => a.text === 'asked Claude to investigate #48')).toBe(true);

    // Starting #48 on kay's Mac asks first; saying so goes on.
    const work = new BoardWork({ store: kay.store, board: kay.board, selfId: () => kay.id, selfName: () => 'kay', askClaude: () => undefined });
    const issues = new GitHubIssues({
      store: kay.store,
      work,
      repoOf: async () => ({ host: 'github.com', owner: 'acme', repo: 'api', url: 'https://github.com/acme/api' }),
      ghReady: async () => true,
      source: { list: async () => ({ issues: [issue48], more: false }), get: async () => issue48, comment: async () => '' },
      askClaude: () => undefined,
      prPrompt: () => '',
    });
    await expect(issues.investigate('pk', 48)).rejects.toThrow('ata is investigating #48. Ask ata first, or start it anyway');
    await expect(issues.fix('pk', 48)).rejects.toThrow(/ata is investigating #48/);
    // Anyway: past the question (this test Mac has no worktrees to start one in).
    await expect(issues.investigate('pk', 48, { anyway: true })).rejects.not.toThrow(/ata is/);
    work.stop();
  }, 60_000);
});
