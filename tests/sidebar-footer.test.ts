import { describe, expect, it } from 'vitest';
import { footerStatus } from '../packages/mac/src/views/room/connection-model.js';

// The footer once read a stray `state` (a merge of KLD-48's selectors with KLD-52), so it threw whenever the room wasn't connected.
describe('sidebar footer status', () => {
  const base = { room: 'klaud', people: 1, ready: false, reconnecting: false };
  it('connected: who is here, or that the invite is ready', () => {
    expect(footerStatus({ ...base, status: 'connected', people: 3 })).toEqual({ label: '3 people in klaud', tone: 'ok' });
    expect(footerStatus({ ...base, status: 'connected', ready: true })).toEqual({ label: 'Invite ready', tone: 'ok' });
    expect(footerStatus({ ...base, status: 'connected' })).toEqual({ label: 'Just you', tone: 'ok' });
  });
  it('not connected: reconnecting, connecting or offline, without throwing', () => {
    expect(footerStatus({ ...base, status: 'disconnected', reconnecting: true })).toEqual({ label: 'Reconnecting…', tone: 'warn' });
    expect(footerStatus({ ...base, status: 'connecting' })).toEqual({ label: 'Connecting…', tone: 'warn' });
    expect(footerStatus({ ...base, status: 'disconnected' })).toEqual({ label: 'Offline', tone: 'error' });
  });
});
