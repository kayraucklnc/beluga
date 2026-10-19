/**
 * The demo's Claudes in chats (no model): short answers that read like each person's Claude,
 * from the question and the files attached to it.
 */

const STYLES: Readonly<Record<string, (q: string) => string>> = {
  bob: (q) => `From bob’s side: ${/deploy|staging|release|ship/i.test(q) ? 'staging is green and the deploy script passed its dry run, so I’d ship after one smoke test.' : 'I’d keep it small and land it behind a flag first.'}`,
  mia: (q) => `Mia’s Claude here. ${/copy|landing|text|word/i.test(q) ? 'The landing copy reads well; I’d tighten the headline to six words.' : 'Agreed with the above. One thing to add: write down the decision in the channel so everyone’s Claude has it next time.'}`,
};

const gist = (q: string): string => {
  const words = q.replace(/\s+/g, ' ').trim();
  return words.length > 80 ? `${words.slice(0, 77)}…` : words;
};

export function demoAnswer(owner: string, question: string, files: readonly string[] = []): string {
  const q = question.trim();
  const style = STYLES[owner.toLowerCase()];
  const about = files.length ? ` I read ${files.join(', ')}: it looks complete, with no obvious gaps.` : '';
  if (style) return `${style(q)}${about}`;
  return [`Here’s my take on “${gist(q) || 'the files'}”:`, '', '- The chat so far agrees on the direction; nothing blocks it.', '- Next step: one person owns it and posts when it’s done.', about ? `-${about}` : ''].filter(Boolean).join('\n');
}

/** What a mock backend's chat answer reads from a prompt built by claude-prompt.ts. */
export function demoAnswerFromPrompt(system: string, prompt: string): string {
  const owner = /^You are (.+?)'s Claude/.exec(system)?.[1] ?? 'you';
  const question = /<message>\n([\s\S]*?)\n<\/message>/.exec(prompt)?.[1] ?? '';
  const files = [...prompt.matchAll(/<file name="([^"]+)">/g)].map((m) => m[1]!);
  return demoAnswer(owner, question.startsWith('(no text') ? '' : question, files);
}
