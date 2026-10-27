import { describe, expect, it } from 'vitest';
import { localMentions, portableMentions, sharedProjects, sharedTasks } from '../../src/core/team/mentions.js';
import { askAboutTask, channelSuggestions, channelTasks } from '../../packages/mac/src/network/chat-model.js';
import type { Issue } from '../../src/core/board/model.js';
import type { TeamState } from '../../src/core/team/model.js';

/** BLG-263: team tasks named in chats with friends, each Mac by its own key. */

const team: Pick<TeamState, 'teams'> = {
  teams: {
    pa: { projectId: 'pa', repo: 'acme/api', mates: [{ peerId: 'kay', name: 'kay', since: 1 }] },
    pb: { projectId: 'pb', repo: 'acme/web', mates: [{ peerId: 'mia', name: 'mia', since: 1 }] },
  },
};
const issue = (id: string, key: string, projectId: string, over: Partial<Issue> = {}): Issue => ({ id, key, projectId, title: `Task ${key}`, status: 'todo', ...over }) as Issue;
const ata = [issue('i_1', 'API-12', 'pa'), issue('i_2', 'WEB-3', 'pb'), issue('i_3', 'API-13', 'pa', { archivedAt: 5 }), issue('i_4', 'OWN-1', 'mine')];

describe('team tasks in chats', () => {
  it('a chat names only the live tasks of repositories you share with its people', () => {
    expect([...sharedProjects(team, ['kay'])]).toEqual(['pa']);
    expect(sharedTasks(ata, team, ['kay']).map((i) => i.key)).toEqual(['API-12']);
    expect(sharedTasks(ata, team, ['kay', 'mia']).map((i) => i.key)).toEqual(['API-12', 'WEB-3']);
    expect(sharedTasks(ata, team, ['zed'])).toEqual([]);
  });

  it('goes out with the task’s id and reads on the other Mac by its own key', () => {
    const shared = sharedTasks(ata, team, ['kay']);
    const wire = portableMentions('@claude:kay can you take @API-12? Not @OWN-1, and `@API-12` is code', shared);
    expect(wire).toBe('@claude:kay can you take [@API-12](beluga-task-id:i_1)? Not @OWN-1, and `@API-12` is code');
    // Kay's Mac has the same task as BLG-40.
    expect(localMentions(wire, [{ id: 'i_1', key: 'BLG-40' }])).toBe('@claude:kay can you take @BLG-40? Not @OWN-1, and `@API-12` is code');
    // Back on ata's Mac (its own copy): its own key again.
    expect(localMentions(wire, ata)).toContain('take @API-12?');
    // A Mac that doesn't have it: the words as written.
    expect(localMentions(wire, [])).toContain('take @API-12?');
    // Twice in one message, and an email-like "a@API-12" left alone.
    expect(portableMentions('@API-12 and @api-12, a@API-12', shared)).toBe('[@API-12](beluga-task-id:i_1) and [@API-12](beluga-task-id:i_1), a@API-12');
  });

  it('the @ menu in a friend chat lists the tasks you share, after the Claudes and people', () => {
    const tasks = channelTasks(ata, team, [{ peerId: 'kay', name: 'kay' }]);
    expect(tasks.map((t) => t.key)).toEqual(['API-12']);
    const list = channelSuggestions('look at @API', { people: [{ peerId: 'kay', name: 'kay' }], tasks });
    expect(list.map((s) => [s.label, s.value])).toEqual([['@API-12', 'look at @API-12 ']]);
    expect(channelSuggestions('@', { people: [{ peerId: 'kay', name: 'kay' }], tasks }).map((s) => s.label)).not.toContain('@API-12');
  });

  it('asking about a task from its menu writes the words for their chat', () => {
    expect(askAboutTask('API-12', 'Kay Stone', true)).toMatch(/^@claude:\S+ @API-12 $/);
    expect(askAboutTask('API-12', 'kay', false)).toBe('@API-12 ');
  });
});
