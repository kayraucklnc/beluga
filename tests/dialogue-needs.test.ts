import { describe, expect, it } from 'vitest';
import { waitingNeeds } from '../src/companion/needs-you.js';
import { type Dialogue, createDialogue } from '../src/core/dialogues/model.js';
import { detectNotices } from '../src/core/notify.js';
import { type DomainState, initialState } from '../src/core/store.js';

const CLAUDE = { runtime: 'claude', label: 'Claude' };
const CODEX = { runtime: 'codex', label: 'Codex' };

function withDialogue(d: Dialogue): DomainState {
  const s = initialState('room');
  return { ...s, dialogues: { [d.id]: d } };
}

const talk = (extra: Partial<Dialogue> = {}): Dialogue => ({ ...createDialogue({ id: 'dlg_needs0001', topic: 'Is the cache safe?\nmore', participants: [{ agent: CLAUDE }, { agent: CODEX }], channel: 'ws:abc' }, 1000), ...extra });

describe('a dialogue waiting on you', () => {
  it('paused at its cap: Continue or Stop, from the bell and the phone', () => {
    const [item] = waitingNeeds(withDialogue(talk({ status: 'paused', updatedAt: 2000 }))).filter((n) => n.id.startsWith('dialogue:'));
    expect(item?.kind).toBe('decision');
    expect(item?.detail).toBe('Is the cache safe?');
    expect(item?.actions.map((a) => a.method)).toEqual(['dialogues.continue', 'dialogues.stop']);
    expect(item?.topic).toBe('conv:ws:abc');
  });

  it('proposed: Start or Cancel; running, over, or chaired by a friend: nothing', () => {
    const proposed = waitingNeeds(withDialogue(talk({ status: 'proposed' }))).find((n) => n.id === 'dialogue:dlg_needs0001');
    expect(proposed?.actions.map((a) => a.method)).toEqual(['dialogues.confirm', 'dialogues.stop']);
    for (const d of [talk(), talk({ status: 'ended' }), talk({ status: 'paused', remoteChair: { peer: 'bob', name: 'bob' } })]) {
      expect(waitingNeeds(withDialogue(d)).filter((n) => n.id.startsWith('dialogue:'))).toEqual([]);
    }
  });

  it('notifies once when it pauses', () => {
    const before = withDialogue(talk());
    const after = withDialogue(talk({ status: 'paused' }));
    const notices = detectNotices(before, after).filter((n) => n.need === 'dialogue:dlg_needs0001');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.kind).toBe('needsYou');
    expect(detectNotices(after, withDialogue(talk({ status: 'paused', updatedAt: 5 }))).filter((n) => n.need?.startsWith('dialogue:'))).toEqual([]);
  });
});
