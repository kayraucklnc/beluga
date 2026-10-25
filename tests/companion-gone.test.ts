import { describe, expect, it } from 'vitest';
import { goneTopics } from '../src/companion/gone.js';
import { PhoneCalls } from '../src/companion/calls.js';
import { PHONE } from '../src/companion/coverage.js';
import { COMPANION_API } from '../src/ipc/companion-api.js';
import { COMPANION_HANDLERS } from '../src/ipc/companion-handlers.js';
import { type DomainState, initialState } from '../src/core/store.js';
import type { Session } from '../src/core/session.js';

/** The phone's saved files go when their conversation is archived or deleted on the Mac (BLG-124). */

const ws = (id: string, archived?: boolean) => ({ id, projectRoot: '/x/landing', projectId: 'p1', name: id, path: `/x/landing/.w/${id}`, kind: 'worktree', createdAt: 1, external: false, ...(archived ? { archived } : {}) });

function state(): DomainState {
  const s = initialState('room');
  return {
    ...s,
    projects: [{ id: 'p1', name: 'landing', root: '/x/landing', base: 'main', workspaces: [ws('w1'), ws('w2', true)] }],
    shared: [{ id: 'f1', owner: 'peer1', project: 'theirs', name: 'theirs' }],
    assistant: { ...s.assistant, chats: [{ id: 'main', channel: 'mac:assistant' }, { id: 'abc', channel: 'mac:assistant:abc' }] },
  } as unknown as DomainState;
}

describe('companion.gone', () => {
  it('names archived and deleted worktrees and deleted chats of Your Mac, nothing else', () => {
    const topics = ['conv:ws:w1', 'conv:ws:w2', 'conv:ws:deleted', 'conv:ws:f1', 'conv:mac:assistant', 'conv:mac:assistant:abc', 'conv:mac:assistant:old', 'conv:room', 'conv:task:t1', 'plan:p1', 'conv:ws:w2'];
    expect(goneTopics(state(), topics)).toEqual(['conv:ws:w2', 'conv:ws:deleted', 'conv:mac:assistant:old']);
  });

  it('says nothing is gone while the Mac has no projects yet', () => {
    expect(goneTopics(initialState('room'), ['conv:ws:w1', 'conv:mac:assistant:old'])).toEqual([]);
  });

  it('is a phone call that takes conversation topics only', async () => {
    expect(PHONE['companion.gone']).toBe('phone');
    expect(PhoneCalls['companion.gone'].result.parse({ gone: ['conv:ws:w2'] })).toEqual({ gone: ['conv:ws:w2'] });
    const args = COMPANION_API['companion.gone'].args;
    expect(args.safeParse([['conv:ws:w1']]).success).toBe(true);
    expect(args.safeParse([['/etc/passwd']]).success).toBe(false);
    expect(args.safeParse([Array.from({ length: 501 }, (_, i) => `conv:ws:w${i}`)]).success).toBe(false);
    const session = { store: { getState: state } } as unknown as Session;
    expect(await COMPANION_HANDLERS['companion.gone'](session, ['conv:ws:w2', 'conv:ws:w1'])).toEqual({ gone: ['conv:ws:w2'] });
  });
});
