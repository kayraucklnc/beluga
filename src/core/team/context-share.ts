import type { Board } from '../board/board.js';
import type { ProjectContext } from '../board/model.js';
import { type Action, clean } from '../store.js';
import type { TeamMsg } from './protocol.js';
import type { TeamBoards, TeamLink, TeamPart } from './service.js';

/**
 * A teamed project's About This Project (BLG-298): one text for the whole team, the newest edit
 * winning on every Mac. It goes to each teammate when it changes here (yours, or one a teammate
 * sent, so a team of three agrees even where two aren't linked), when a link forms, and when a
 * teammate's Mac comes online (a Mac that couldn't take it before may now). Nothing to keep of
 * its own: the board keeps the text with when it was written.
 */
export class TeamContext implements TeamPart {
  /** What each link last got (`at` and text), so an unchanged context isn't sent again. */
  private readonly sent = new Map<string, string>();

  constructor(
    private readonly team: TeamBoards,
    private readonly board: Board,
  ) {}

  private contextOf(projectId: string): ProjectContext | undefined {
    return this.board.state().projects[projectId]?.context;
  }

  private push(link: TeamLink): void {
    const c = this.contextOf(link.projectId);
    if (!c || this.team.cannot(link.peerId, 'team.context')) return;
    const print = `${c.at}:${c.text}`;
    if (this.sent.get(link.id) === print) return;
    this.sent.set(link.id, print);
    this.team.send(link.peerId, { k: 'context', link: link.id, text: c.text, by: c.by, at: c.at }, `context:${link.id}`);
  }

  receive(from: string, m: TeamMsg): boolean {
    if (m.k !== 'context') return false;
    const link = this.team.linkById(m.link);
    if (!link || link.peerId !== from) return true;
    // They have this one: no need to send it back.
    this.sent.set(link.id, `${m.at}:${m.text.trim()}`);
    try {
      this.board.setContext(link.projectId, clean(m.text), clean(m.by), { at: m.at });
    } catch {
      // The project went meanwhile.
    }
    return true;
  }

  joined(link: TeamLink): void {
    this.push(link);
  }

  linkUp(peerId: string): void {
    for (const link of this.team.allLinks()) if (link.peerId === peerId) this.push(link);
  }

  left(link: TeamLink): void {
    this.sent.delete(link.id);
  }

  onAction(action: Action): void {
    if (action.type !== 'board_meta') return;
    for (const link of this.team.allLinks()) this.push(link);
  }
}
