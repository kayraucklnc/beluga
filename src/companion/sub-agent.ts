import type { CcAgent, CcSteps } from '../core/claude-code/model.js';
import type { DomainState, LogItem } from '../core/store.js';
import type { StepPage, StepRecord } from '../shared/steps.js';
import { withMath } from './math-svg.js';
import type { SubAgentDetailView, SubAgentStepView } from './protocol.js';
import { HIDDEN_STEP, humanizeDoing, stepWords, stripCode } from './strip.js';

/**
 * One sub-agent opened on the phone (BLG-110, `companion.subAgent`): what it did, every step in
 * words, and once it ended the report it gave back (code stripped, as Claude's answers are). From
 * what the Mac already keeps, read only: your own Claude's step records of the turn (its steps are
 * tagged with the sub-agent's call; the call's result is its report), else the transcript Claude
 * Code keeps of it (the agent's last words). Never its prompt, its tools' input or output, or a file.
 */

/** Where the details come from (the session's step book and Claude Code watcher; absent in tests). */
export interface SubAgentSources {
  readonly steps?: (channel: string, itemId: string) => StepPage;
  readonly step?: (channel: string, itemId: string, stepId: string) => StepRecord | undefined;
  readonly ccSteps?: (sessionId: string, agentId: string) => CcSteps | undefined;
}

type AgentItem = Extract<LogItem, { type: 'agent' }>;

/** The timeline's length, and how much of a report goes to the phone. */
const TIMELINE = 200;
const REPORT_MAX = 60_000;

/** A background launch's answer ("Async agent launched…"): not its report, it works on. */
const LAUNCHED = /^\s*Async agent launched/i;

/** The report without what Claude Code adds to it for the lead (its agent id, its usage). */
export function reportOf(output: string): string {
  return output
    .replace(/<usage>[\s\S]*?<\/usage>/g, '')
    .replace(/^agentId: [\w-]+.*$/gm, '')
    .trim();
}

/** The Claude Code agent behind a sub-agent of this conversation (by the call that started it, or its own id). */
function ccAgentOf(state: DomainState, channel: string, id: string): { sessionId: string; agent: CcAgent } | undefined {
  const ws = channel.startsWith('ws:') ? channel.slice(3) : undefined;
  if (!ws) return undefined;
  for (const s of state.claudeCode.sessions) {
    if (s.workspaceId !== ws) continue;
    const agent = s.agents.find((a) => (a.toolUseId ?? a.id) === id || a.id === id);
    if (agent) return { sessionId: s.id, agent };
  }
  return undefined;
}

const words = (line: string, running: boolean): SubAgentStepView => {
  const w = stepWords(line);
  return { tool: w.tool, text: running ? w.doing : w.did };
};

export function subAgentDetail(state: DomainState, src: SubAgentSources, topic: string, turn: string, id: string): SubAgentDetailView {
  const channel = topic.replace(/^conv:/, '');
  const item = state.log.find((l): l is AgentItem => l.type === 'agent' && l.id === turn && l.channel === channel);
  const sub = item?.subagents.find((s) => s.id === id);
  const cc = ccAgentOf(state, channel, id);
  if (!sub && !cc) return { id, timeline: [], missing: true };
  const running = sub ? sub.status === 'running' || cc?.agent.status === 'running' : cc!.agent.status === 'running';

  // Its steps: your own Claude's records of the turn (tagged with its call), else Claude Code's transcript, else the one-liners the run sent.
  const records = item && src.steps ? safe(() => src.steps!(channel, item.id).steps.filter((s) => s.parent === id && s.kind === 'tool' && !HIDDEN_STEP.test(s.title))) : undefined;
  const transcript = cc && src.ccSteps ? safe(() => src.ccSteps!(cc.sessionId, cc.agent.id)) : undefined;
  let timeline: SubAgentStepView[];
  let count: number;
  if (records?.length) {
    timeline = records.map((r) => ({ ...words(r.title, r.status === 'running'), at: Math.round(r.startedAt) }));
    count = records.length;
  } else if (transcript && !transcript.missing && transcript.steps.some((s) => s.kind === 'tool')) {
    const tools = transcript.steps.filter((s) => s.kind === 'tool');
    timeline = tools.map((s) => ({ ...humanizeDoing(s.text), at: Math.round(s.ts) }));
    count = Math.max(tools.length, cc?.agent.steps ?? 0);
  } else {
    const lines = (sub?.steps ?? []).filter((s) => !HIDDEN_STEP.test(s));
    timeline = lines.map((s, i) => words(s, running && i === lines.length - 1));
    count = lines.length;
  }

  // Its report, once it ended: the call's result (what the lead Claude read), else its last words in the transcript.
  let report: string | undefined;
  if (!running) {
    const rec = item && src.step ? safe(() => src.step!(channel, item.id, id)) : undefined;
    if (rec?.output && !LAUNCHED.test(rec.output)) report = reportOf(rec.output);
    if (!report && transcript && !transcript.missing) {
      const last = [...transcript.steps].reverse().find((s) => s.kind === 'text' || s.kind === 'tool');
      if (last?.kind === 'text') report = last.text.trim();
    }
  }
  const result = report ? withMath(stripCode(report.length > REPORT_MAX ? `${report.slice(0, REPORT_MAX - 1)}…` : report)) : undefined;
  return {
    id,
    timeline: timeline.slice(-TIMELINE).map((s) => ({ ...s, text: s.text.slice(0, 300) })),
    count,
    ...(result ? { result } : {}),
  };
}

/** A source that throws (no watcher on this daemon) has nothing to say. */
function safe<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}
