/** Where the cursor goes after filling in a template: at a double space (a blank to fill), else the end. */
export function cursorFor(prompt: string): number {
  const blank = prompt.indexOf('  ');
  if (blank >= 0) return blank + 1;
  const hash = prompt.indexOf('# ');
  if (hash >= 0) return hash + 1;
  const colon = prompt.indexOf(': .');
  return colon >= 0 ? colon + 2 : prompt.length;
}
