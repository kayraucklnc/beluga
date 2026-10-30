import { describe, expect, it } from 'vitest';
import { buildSystemAppend } from '../src/agent/prompt.js';
import { friendMention, suggest } from '../src/ui/suggest.js';

/** "@mia send me a screenshot of your desktop": friends on the network, tagged by name in a message to your Claude. */

const ctx = { peers: [], selfId: 'me', friends: [{ name: 'mia', online: true }, { name: 'Bob Stone', online: false }] };

describe('@friend in the message box', () => {
  it('offers friends by name, anywhere in the message, saying when they’re offline', () => {
    // Each friend twice: the person, then their Claude.
    expect(suggest('@m', ctx)).toEqual([
      { label: '@mia', hint: "mia, the person: they're told you mentioned them", value: '@mia ', enter: 'complete', kind: 'person' },
      { label: '@claude:mia', hint: "ask mia's Claude, on their Mac", value: '@claude:mia ', enter: 'complete', kind: 'claude' },
    ]);
    expect(suggest('please ask @Bo', ctx).map((s) => s.label)).toEqual(['@BobStone', '@claude:BobStone']);
    expect(suggest('please ask @Bo', ctx)[1]).toMatchObject({ hint: "ask Bob Stone's Claude, on their Mac (offline: it goes when they’re back)", value: 'please ask @claude:BobStone ', kind: 'claude' });
    expect(suggest('@claude:m', ctx).map((s) => s.label)).toEqual(['@claude:mia']);
    expect(suggest('@mia ', ctx)).toEqual([]);
  });

  it('writes names without spaces or punctuation', () => {
    expect(friendMention('Mia Chen')).toBe('@MiaChen');
    expect(friendMention('o’neil')).toBe('@oneil');
  });

  it('your Claude knows @claude:Name is a friend’s Claude to ask, @Name the person, and to give their notification a summary', () => {
    const prompt = buildSystemAppend('kay');
    expect(prompt).toContain('"@claude:Name" in the user');
    expect(prompt).toContain('"@Name" alone is the person, not their agent');
    expect(prompt).toContain('Give ask_person a summary');
  });
});

describe('the demo’s Claude reads @friend', () => {
  it('"@bob run the tests" asks bob; "ask mia to …" still works; @claude is not a friend', async () => {
    const { gatewayTarget } = await import('../src/agent/mock.js');
    expect(gatewayTarget('@bob run the tests in bob-api')).toEqual({ person: 'bob', ask: 'run the tests in bob-api' });
    expect(gatewayTarget('@claude:bob run the tests in bob-api')).toEqual({ person: 'bob', ask: 'run the tests in bob-api' });
    expect(gatewayTarget('hey @mia, send me a screenshot of your desktop!')).toEqual({ person: 'mia', ask: 'send me a screenshot of your desktop' });
    expect(gatewayTarget('ask mia to review the copy')).toEqual({ person: 'mia', ask: 'review the copy' });
    expect(gatewayTarget('@claude fix it')).toBeUndefined();
  });
});

describe('@ata is Ata, @claude:ata is Ata’s Claude', () => {
  it('tells the two apart, in words and never in code', async () => {
    const { personMentions, claudeMentions, mentionNote } = await import('../src/core/person-mentions.js');
    const friends = [
      { peerId: 'a1', name: 'ata' },
      { peerId: 'm1', name: 'Mia Chen' },
    ];
    expect(personMentions('@ata can you look? cc @MiaChen', friends).map((f) => f.name)).toEqual(['ata', 'Mia Chen']);
    expect(personMentions('@claude:ata run the tests', friends)).toEqual([]);
    expect(claudeMentions('@claude:ata run the tests, and tell @MiaChen', friends).map((f) => f.name)).toEqual(['ata']);
    expect(personMentions('see `@ata` in the docs\n```\n@ata\n```', friends)).toEqual([]);
    expect(personMentions('@claude fix it', friends)).toEqual([]);
    expect(mentionNote('kay', 'fix-auth (ata-api)', '@ata can you look?')).toBe('kay mentioned you in fix-auth (ata-api):\n\n@ata can you look?');
  });

  it('draws @claude:ata as a pill for a friend who isn’t in the room', async () => {
    const { resolveMention } = await import('../packages/mac/src/chat/mentions.js');
    const world = { friends: [{ name: 'ata', peerId: 'a1' }], peers: [], projects: [], workspaces: [] };
    expect(resolveMention('claude:ata', world)).toEqual({ kind: 'claude', label: 'ata’s Claude', id: 'a1' });
    expect(resolveMention('ata', world)).toEqual({ kind: 'friend', label: 'ata', id: 'a1' });
  });
});
