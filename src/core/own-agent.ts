import type { Session } from './session.js';
import type { Store } from './store.js';

export interface OwnClaude {
  /** Ask your Claude in a conversation → the request's id (undefined: it can't be asked there). `shown`: what the chat shows you asked (false: nothing). */
  ask(prompt: string, channel: string, shown: string | false): string | undefined;
  /** That request's final message; rejects with what went wrong (an error, a denial). */
  wait(requestId: string): Promise<string>;
  /** Stop it. */
  cancel(requestId: string, note: string): void;
  /** Stop listening: every wait still open rejects. */
  close(): void;
}

/** Your own Claude, asked in a conversation and waited for by its request (askAndWait's pattern, keyed by request). */
export function ownClaude(session: Session, store: Store): OwnClaude {
  const waits = new Map<string, { readonly resolve: (text: string) => void; readonly reject: (err: Error) => void }>();
  const off = store.onAction((a) => {
    if (a.type !== 'agent_event') return;
    const w = waits.get(a.requestId);
    if (!w || !['done', 'error', 'denied'].includes(a.event)) return;
    waits.delete(a.requestId);
    if (a.event === 'done') w.resolve(a.text);
    else w.reject(new Error(a.text || a.event));
  });
  return {
    ask: (prompt, channel, shown) => session.askOwnClaude(prompt, channel, false, shown),
    wait: (requestId) => new Promise<string>((resolve, reject) => void waits.set(requestId, { resolve, reject })),
    // The wait stays until the request ends (its done or error event), so the run can wait for it
    // before archiving its worktree; one that never says so is let go after a while.
    cancel: (requestId, note) => {
      const letGo = (): void => {
        const w = waits.get(requestId);
        if (!w) return;
        waits.delete(requestId);
        w.reject(new Error('Stopped'));
      };
      // Not running (any more): nothing to wait for.
      if (!session.host.cancelRun(requestId, note)) return letGo();
      const timer = setTimeout(letGo, 15_000);
      timer.unref?.();
    },
    close: () => {
      off();
      for (const w of waits.values()) w.reject(new Error('Beluga closed'));
      waits.clear();
    },
  };
}
