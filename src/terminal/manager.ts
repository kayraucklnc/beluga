import { TerminalSession, type TerminalOptions } from './session.js';

export type OpenOptions = Omit<TerminalOptions, 'id'>;

/** Keeps terminal sessions alive by id (e.g. one per workspace). */
export class TerminalManager {
  private readonly sessions = new Map<string, TerminalSession>();

  /**
   * Get the session for `id`, creating it if needed. An existing session is
   * returned as is (resized to the given size), even if its program exited;
   * `close` it first to start fresh.
   */
  open(id: string, opts: OpenOptions): TerminalSession {
    const existing = this.sessions.get(id);
    if (existing) {
      existing.resize(opts.cols, opts.rows);
      return existing;
    }
    const session = new TerminalSession({ ...opts, id });
    this.sessions.set(id, session);
    return session;
  }

  get(id: string): TerminalSession | undefined {
    return this.sessions.get(id);
  }

  list(): TerminalSession[] {
    return [...this.sessions.values()];
  }

  /** Kill and forget a session. Returns false when there was none. */
  close(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    session.dispose();
    return true;
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }
}
