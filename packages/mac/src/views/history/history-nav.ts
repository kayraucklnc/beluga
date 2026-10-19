/** A commit to show when the History page opens (clicked on the project home), taken once. */
let pending: { projectId: string; hash: string } | undefined;

export function showCommitNext(projectId: string, hash: string): void {
  pending = { projectId, hash };
}

export function takePendingCommit(projectId: string): string | undefined {
  if (pending?.projectId !== projectId) return undefined;
  const { hash } = pending;
  pending = undefined;
  return hash;
}
