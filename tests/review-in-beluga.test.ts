import { describe, expect, it } from 'vitest';
import { macViewFor } from '../src/companion/open-on-mac.js';
import { initialState } from '../src/core/store.js';
import { noticeTarget } from '../src/ui/notice-models.js';

/**
 * Review in Beluga (BLG-301): a "Claude needs your OK" card opens the conversation it holds up.
 * The Sentinel chat is one of those: its channel opens Sentinel › Chat, on the Mac and from the phone.
 */

describe('where an approval opens', () => {
  const st = initialState('room');

  it('the Sentinel chat opens its tab, on the chat that asked', () => {
    expect(noticeTarget(st, 'sentinel-chat:main')).toEqual({ kind: 'sentinel_chat', chat: 'main' });
    expect(noticeTarget(st, 'sentinel-chat:c2')).toEqual({ kind: 'sentinel_chat', chat: 'c2' });
  });

  it('the phone’s Open on your Mac lands there too', () => {
    expect(macViewFor(st, { topic: 'conv:sentinel-chat:c2' })).toEqual({ kind: 'sentinel_chat', chat: 'c2' });
  });

  it('Your Mac’s chats still open Your Mac, and an unknown place nothing', () => {
    expect(noticeTarget(st, 'mac:assistant:b')).toEqual({ kind: 'assistant', chat: 'b' });
    expect(noticeTarget(st, 'nowhere')).toBeUndefined();
  });
});
