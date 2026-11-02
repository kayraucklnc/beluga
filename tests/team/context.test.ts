import { afterEach, describe, expect, it } from 'vitest';
import { TeamBoardSync } from '../../src/core/team/board-sync.js';
import { TeamContext } from '../../src/core/team/context-share.js';
import { type Crowd, befriend, crowd, settle } from '../mesh/helpers.js';
import { type PartsFor, type TeamMac, teamMac } from './helpers.js';

/** BLG-298: a teamed project's About This Project is one text for the whole team. */

let net: Crowd | undefined;
const macs: TeamMac[] = [];

afterEach(async () => {
  for (const m of macs.splice(0)) await m.close();
  await net?.close();
  net = undefined;
});

const parts: PartsFor = ({ team, board, dir }) => [new TeamBoardSync(team, { board, live: () => false, dir }), new TeamContext(team, board)];

describe('a project’s context, shared', () => {
  it('a new teammate gets it; an edit on either Mac reaches the other, the newest winning', async () => {
    net = await crowd();
    const ata = await teamMac(net, 'ata', [{ id: 'pa', name: 'api', repo: 'acme/api' }], parts);
    const kay = await teamMac(net, 'kay', [{ id: 'pk', name: 'api', repo: 'acme/api' }], parts);
    macs.push(ata, kay);
    // Written before they teamed up.
    ata.board.setContext('pa', 'A payments API for bakeries.', 'ata');
    await befriend(ata.person, kay.person);
    await settle(() => ata.store.getState().team.offers[0] && kay.store.getState().team.offers[0]);
    ata.team.answer(kay.id, 'pa', true);
    await settle(() => kay.store.getState().team.offers[0]?.state === 'invited');
    kay.team.answer(ata.id, 'pk', true);
    await settle(() => ata.store.getState().team.teams.pa && kay.store.getState().team.teams.pk);

    const got = await settle(() => kay.board.state().projects.pk?.context);
    expect(got).toMatchObject({ text: 'A payments API for bakeries.', by: 'ata' });

    kay.board.setContext('pk', 'A payments API for bakeries. Code in src/, the app in web/.', 'kay');
    const back = await settle(() => (ata.board.state().projects.pa?.context?.by === 'kay' ? ata.board.state().projects.pa!.context : undefined));
    expect(back.text).toBe('A payments API for bakeries. Code in src/, the app in web/.');
    expect(back.at).toBe(kay.board.state().projects.pk!.context!.at);

    // Emptied on one Mac, emptied on both.
    ata.board.setContext('pa', '', 'ata');
    await settle(() => kay.board.state().projects.pk?.context?.text === '' || undefined);
  });
});
