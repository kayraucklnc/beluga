import { agentName } from '../../shared/agent-label.js';
import { type Dialogue, agentTurns, budgetLeft, nextSpeaker, nextTurn } from './model.js';

/** How a friend's agent ends a dialogue (it has no end_dialogue tool on its Mac): its answer's last line. */
export const END_LINE = 'END DIALOGUE:';

/** A friend's answer → its words, and the reason when its last line ends the dialogue. */
export function endedBy(text: string): { readonly text: string; readonly ended?: string } {
  const m = /\n?[ \t]*END DIALOGUE:[ \t]*([^\n]*)\s*$/i.exec(text);
  if (!m) return { text };
  return { text: text.slice(0, m.index).trimEnd(), ended: m[1]!.trim() || 'Ended' };
}

/** How much of the dialogue so far a turn's prompt carries (its end: the latest turns). */
const TRANSCRIPT_CHARS = 24_000;

/** A participant as the thread and the other agents call it: "Codex", "bob's Claude"; two alike get A/B. */
export function speakerName(d: Dialogue, i: number): string {
  const p = d.participants[i];
  if (!p) return 'Agent';
  const base = p.owner ? `${p.owner}'s ${agentName(p.agent)}` : agentName(p.agent);
  const twins = d.participants.filter((q) => (q.owner ? `${q.owner}'s ${agentName(q.agent)}` : agentName(q.agent)) === base).length > 1;
  return twins ? `${base} ${String.fromCharCode(65 + i)}` : base;
}

const turnLabel = (d: Dialogue, by: number | 'person', name?: string): string => (by === 'person' ? `${name ?? 'A person'} (a person in the room)` : speakerName(d, by));

/**
 * Cross-reference's fixed template (BLG-467), by turn: A answers, B critiques with sources, A
 * reconciles into the final answer.
 */
export function crossReferenceRole(turn: number, others: string): string {
  if (turn === 1) return `Your role: answer the question fully and on your own. Say how sure you are, and give sources (links, files, docs) for what you claim: ${others} will check them next.`;
  if (turn === 2) return "Your role: critique the answer above. Check its claims against sources you look up yourself and cite them (links, files, docs); say what's right, what's wrong or unsupported, and what's missing. Don't write a new answer from scratch.";
  return 'Your role: reconcile. Give the final answer, taking the critique into account: keep what held up, fix what didn\'t, and say briefly what changed and why. This is the last turn: it is the answer the room keeps.';
}

/** The system-prompt append for one turn: who it is, who with, the rules. */
export function dialogueBrief(d: Dialogue, speaker = nextSpeaker(d)): string {
  const me = speakerName(d, speaker);
  const others = d.participants.map((_, i) => i).filter((i) => i !== speaker).map((i) => speakerName(d, i));
  const left = budgetLeft(d);
  const lines = [
    '',
    '',
    '# A chaired dialogue',
    `You are ${me}, in a dialogue with ${others.join(' and ')} about: ${d.topic}`,
    `Beluga chairs it: each of your answers is passed on as the next one's prompt, and everyone in the room watches the thread. This is turn ${nextTurn(d)} (Continue? is asked after turn ${d.pauseAt})${left !== undefined ? `; about ${left} tokens of budget are left` : ''}.`,
    'Answer the others directly, in a few short paragraphs: build on what was said, disagree when you do, say what you checked. A person in the room may speak in: take what they say as steering.',
    ...(d.mode === 'cross-reference'
      ? [crossReferenceRole(nextTurn(d), others.join(' and '))]
      : d.participants[speaker]?.peer
        ? [`When the question is settled, you agree, or more turns would only repeat, end your answer with a last line \`${END_LINE} <the reason>\`.`]
        : ['When the question is settled, you agree, or more turns would only repeat, call mcp__beluga__end_dialogue with the reason, then give your last word.']),
  ];
  if (d.mode === 'talk' || d.mode === 'cross-reference') lines.push('This is read-only. You may look things up and read files, but nothing may change (no edits, no commands that write).');
  if (d.mode === 'work' && d.worktree) lines.push(`This is work: you may change files, in ${d.worktree} only, with the usual commit rules.`);
  return `${lines.join('\n')}\n`;
}

/** The prompt for the next turn: the topic, the dialogue so far (its end), and whose turn it is. */
export function turnPrompt(d: Dialogue, speaker = nextSpeaker(d)): string {
  const me = speakerName(d, speaker);
  const step = d.mode === 'cross-reference' ? ['Answer the question.', 'Critique that answer, with sources.', 'Reconcile: the final answer.'][nextTurn(d) - 1] : undefined;
  if (agentTurns(d) === 0 && !d.turns.length) return `${d.mode === 'cross-reference' ? 'Question' : 'Topic'}: ${d.topic}\n\n${step ?? `You speak first, ${me}.`}`;
  let transcript = '';
  for (let i = d.turns.length - 1; i >= 0; i--) {
    const t = d.turns[i]!;
    const block = `## ${turnLabel(d, t.by, t.name)}${t.by === 'person' ? '' : ` (turn ${t.n})`}\n${t.text.trim()}\n\n`;
    if (transcript.length + block.length > TRANSCRIPT_CHARS) {
      transcript = `(earlier turns left out)\n\n${transcript}`;
      break;
    }
    transcript = block + transcript;
  }
  return `${d.mode === 'cross-reference' ? 'Question' : 'Topic'}: ${d.topic}\n\nThe dialogue so far:\n\n${transcript}It's your turn, ${me} (turn ${nextTurn(d)}).${step ? ` ${step}` : ''}`;
}
