import type { AgentRef } from '../protocol.js';
import { buildGraphAppend } from './graph-prompt.js';
import { buildAskOnlyAppend, buildCommitAppend, buildKeepAppend, buildScratchAppend, buildShippedAppend, buildSystemAppend } from './prompt.js';
import { buildSyncMainAppend } from './sync-main.js';
import { buildTerminalAppend } from './terminal-prompt.js';
import type { AgentRunInput } from './types.js';
import { buildViewAppend } from './view-prompt.js';

/**
 * What Beluga adds to an agent's own instructions for one run: who it is in the room, graphs and
 * views, the task's brief, the scratch folder, a worktree's keep/commit rules, a main folder's
 * ask-only rules. Plain text: Claude appends it to its system prompt, Codex takes it as developer
 * instructions. `agent` words what differs to be true for its runtime (.env files, kept processes).
 */
export function runInstructions(input: AgentRunInput, ownerName: string, agent?: AgentRef): string {
  const place = input.place;
  const askOnly = place?.askOnly;
  const syncMain = askOnly ? place?.syncMain : undefined;
  const worktree = Boolean(input.env?.KLAUD_WORKTREE);
  return (
    buildSystemAppend(ownerName, agent) +
    buildGraphAppend() +
    buildViewAppend() +
    (input.taskBrief ?? '') +
    (input.planBrief ?? '') +
    (input.macBrief ?? '') +
    (input.phoneBrief ?? '') +
    (input.sentinelBrief ?? '') +
    (input.dialogue?.brief ?? '') +
    (input.setup && !askOnly ? input.setup.brief : '') +
    (input.scratchDir ? buildScratchAppend(input.scratchDir) : '') +
    (worktree ? buildKeepAppend(agent) : '') +
    (worktree && !input.planBrief && !askOnly ? buildCommitAppend() : '') +
    (place?.shipped && !askOnly ? buildShippedAppend(place.shipped) : '') +
    (askOnly ? (syncMain ? buildSyncMainAppend(askOnly.project, syncMain.branch, syncMain.upstream) : buildAskOnlyAppend(askOnly.project, Boolean(input.continueInWorktree))) : '') +
    (input.terminal ? buildTerminalAppend() : '')
  );
}
