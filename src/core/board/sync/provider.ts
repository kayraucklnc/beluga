import type { IssueStatus, Priority, SyncErrorCode, SyncProvider } from '../model.js';

/**
 * What a tracker (Linear today; GitHub Issues or Jira next) does for sync, in the board's own
 * terms: who you are there, its teams, the issues changed since a moment, and creating or
 * changing one. Each provider maps its states, priorities and labels to the board's.
 */

export interface RemoteTeam {
  readonly id: string;
  readonly key: string;
  readonly name: string;
}

/** An issue as the tracker has it, in the board's words. */
export interface RemoteIssue {
  readonly id: string;
  /** "ENG-12". */
  readonly key: string;
  readonly url: string;
  readonly title: string;
  /** Markdown. */
  readonly description: string;
  readonly status: IssueStatus;
  readonly priority: Priority;
  readonly estimate?: number;
  /** YYYY-MM-DD. */
  readonly due?: string;
  /** Lowercase, like the board's. */
  readonly labels: readonly string[];
  /** The parent issue's id there. */
  readonly parent?: string;
  /** When it last changed there (ms). */
  readonly updatedAt: number;
}

/** What sync sends: every field, as this side has it. */
export interface IssueFields {
  readonly title: string;
  readonly description: string;
  readonly status: IssueStatus;
  readonly priority: Priority;
  readonly estimate?: number;
  readonly due?: string;
  readonly labels: readonly string[];
  /** The parent's id there (only when the parent is linked too). */
  readonly parent?: string;
}

export interface Provider {
  readonly kind: SyncProvider;
  /** Check the key: the workspace's name and its teams. Throws SyncError. */
  teams(): Promise<{ readonly workspace?: string; readonly teams: readonly RemoteTeam[] }>;
  /**
   * The team's issues changed after `since` (ms), oldest first; none: the first look (open
   * ones, and those closed lately). Capped, so a huge team never stalls a sync.
   */
  changed(teamId: string, since: number | undefined): Promise<readonly RemoteIssue[]>;
  create(teamId: string, fields: IssueFields): Promise<RemoteIssue>;
  update(teamId: string, id: string, fields: Partial<IssueFields>): Promise<RemoteIssue>;
}

const MESSAGES: Record<SyncErrorCode, string> = {
  auth: 'The tracker doesn’t accept this key any more. Connect a new one.',
  offline: 'Couldn’t reach the tracker. Beluga tries again in a minute.',
  rate_limited: 'The tracker asked Beluga to slow down. It tries again later.',
  remote: 'The tracker had a problem answering. Beluga tries again later.',
  unknown: 'Couldn’t sync the tasks.',
};

/** What went wrong, in Beluga's own words (never the tracker's, which could quote the key). */
export class SyncError extends Error {
  constructor(
    readonly code: SyncErrorCode,
    message: string = MESSAGES[code],
  ) {
    super(message);
    this.name = 'SyncError';
  }
}

/** The part of fetch providers use (tests pass a fake tracker). */
export type FetchLike = (
  url: string,
  init: { readonly method: string; readonly headers: Record<string, string>; readonly body: string; readonly signal: AbortSignal },
) => Promise<{ readonly status: number; readonly headers: { get(name: string): string | null }; json(): Promise<unknown> }>;
