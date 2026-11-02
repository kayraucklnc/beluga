import type { TaskView } from '@beluga/core/gateway/model.js';
import { isFinal } from '@beluga/core/gateway/model.js';
import { humanizeLine } from '@beluga/shared/step-titles.js';

/**
 * What Claude is waiting on when it asked someone else's Claude (or Mac), in words, from the
 * task's live state: "bob is approving…", "bob's Claude is working · Reading payments.ts".
 */

const target = (t: Pick<TaskView, 'peerName' | 'kind'>): string => (t.kind === 'ask' ? `${t.peerName}’s agent` : `${t.peerName}’s Mac`);

/** The waiting row's heading. */
export const waitingFor = (t: TaskView | undefined): string => (t ? `Waiting for ${target(t)}` : 'Waiting for an answer');

/** Where the task is right now, as one line. */
export function waitState(t: TaskView): string {
  const them = t.peerName;
  if (t.question) return `${them}’s agent asks: ${t.question.questions[0]?.question ?? 'a question'}`;
  switch (t.state) {
    case 'confirm':
      return `Waiting for you to OK asking ${them}`;
    case 'sent':
      return `Sent · reaching ${them}’s Mac`;
    case 'queued':
      return `In line behind ${them}’s other work`;
    case 'awaiting_approval':
      return `${them} is approving…`;
    case 'working': {
      if (t.incoming) return `Receiving files from ${them}`;
      if (t.kind === 'run') return `Running on ${them}’s Mac`;
      if (t.kind === 'file') return `${them}’s Mac is sending the file`;
      const last = t.steps.at(-1);
      return `${them}’s agent is working${last ? ` · ${humanizeLine(last).doing}` : ''}`;
    }
    case 'done':
      return `${target(t)} answered`;
    case 'declined':
      return `${them} declined`;
    case 'failed':
      return 'It failed';
    case 'cancelled':
      return 'Cancelled';
  }
}

/** How a finished wait reads in the list of steps. */
export function waitedLabel(t: TaskView | undefined): string | undefined {
  if (!t || !isFinal(t.state)) return undefined;
  if (t.state === 'done') return t.kind === 'ask' ? `Heard back from ${t.peerName}’s agent` : `Got the result from ${t.peerName}’s Mac`;
  if (t.state === 'declined') return `${t.peerName} declined`;
  return t.state === 'cancelled' ? `Stopped waiting for ${target(t)}` : `${target(t)} couldn’t do it`;
}

export const waitTone = (t: TaskView | undefined): 'claude' | 'warn' | 'ok' | 'error' =>
  !t ? 'claude' : t.question || t.state === 'awaiting_approval' || t.state === 'confirm' ? 'warn' : t.state === 'done' ? 'ok' : t.state === 'failed' || t.state === 'declined' ? 'error' : 'claude';
