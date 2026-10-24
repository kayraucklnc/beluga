import { calls } from './link/calls';
import type { Topic } from './link/protocol';
import { store } from './store';

/**
 * Open on your Mac (BLG-40): Beluga comes to the front there, on this conversation, plan, task or
 * request. The phone says it worked, or why not: the Mac is away, Beluga isn't open on it, or it's
 * a Mac too old to be asked.
 */
export async function openOnMac(target: { topic?: Topic; need?: string }): Promise<void> {
  if (!store.supports('openOnMac')) return store.toast({ text: 'Update Beluga on your Mac to open things there from here.', tone: 'info' });
  if (store.getState().phase !== 'open') return store.toast({ text: 'Your Mac is away, so it can’t open there now.', tone: 'warn' });
  try {
    const r = await store.call<{ opened: boolean; why?: string }>(calls.openOnMac(target), { queue: false });
    if (r?.opened) store.toast({ text: 'Opened on your Mac', tone: 'ok' });
    else store.toast({ text: r?.why ?? 'Beluga isn’t open on your Mac', tone: 'info' });
  } catch (e) {
    store.toast({ text: (e as Error).message, tone: 'error' });
  }
}
