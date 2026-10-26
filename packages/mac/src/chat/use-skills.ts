import { useEffect, useState } from 'react';
import type { ClaudeSkill } from '@beluga/shared/skills.js';
import { useApi } from '../lib/beluga.js';

/** How long a conversation's list stays fresh (a skill you just added shows the next time you type /). */
const FRESH_MS = 20_000;
const cache = new Map<string, { at: number; skills: readonly ClaudeSkill[] }>();

/**
 * Claude's skills and custom commands in a worktree's conversation (BLG-217), loaded once you
 * start a command (`want`), for the / list. Elsewhere, none.
 */
export function useSkills(channel: string, want: boolean): readonly ClaudeSkill[] {
  const api = useApi();
  const [skills, setSkills] = useState<readonly ClaudeSkill[]>(() => cache.get(channel)?.skills ?? []);
  const inWorktree = channel.startsWith('ws:');
  useEffect(() => {
    setSkills(cache.get(channel)?.skills ?? []);
  }, [channel]);
  useEffect(() => {
    if (!want || !inWorktree) return;
    const kept = cache.get(channel);
    if (kept && Date.now() - kept.at < FRESH_MS) return;
    let live = true;
    api.claudeCode.skills(channel).then(
      (list) => {
        cache.set(channel, { at: Date.now(), skills: list });
        if (live) setSkills(list);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api, channel, want, inWorktree]);
  return inWorktree ? skills : [];
}
