#!/usr/bin/env node
// A stand-in for the GitHub CLI in the end-to-end tests (the demo daemon runs it as BELUGA_GH).
// Its pull requests live in BELUGA_FAKE_GH (JSON); a test writes them there and reads back what
// was merged. With no file there are no pull requests, so other tests see none.
//
//   { "prs": { "<branch or its last part>": { number, url, state, title, isDraft, statusCheckRollup,
//              reviewDecision, mergeable, autoMergeRequest } },
//     "mergeError": "what gh says when GitHub refuses (optional)",
//     "merges": [["pr", "merge", "7", "--squash"], …] }
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const file = process.env.BELUGA_FAKE_GH ?? process.env.KLAUD_FAKE_GH;
const args = process.argv.slice(2);
const load = () => (file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { prs: {} });
const fail = (text) => {
  process.stderr.write(`${text}\n`);
  process.exit(1);
};

const state = load();
const entries = () => Object.entries(state.prs ?? {});
const find = (ref) => entries().find(([branch, pr]) => branch === ref || ref.endsWith(`/${branch}`) || String(pr.number) === ref);
const withBranch = (ref, branch) => (ref.includes('/') ? ref : branch);

if (args[0] === 'auth' && args[1] === 'status') process.exit(0);

if (args[0] === 'pr' && args[1] === 'view') {
  const hit = find(args[2] ?? '');
  if (!hit) fail(`no pull requests found for branch "${args[2]}"`);
  process.stdout.write(JSON.stringify(hit[1]));
  process.exit(0);
}

if (args[0] === 'pr' && args[1] === 'list') {
  process.stdout.write(JSON.stringify(entries().map(([branch, pr]) => ({ ...pr, headRefName: withBranch(pr.headRefName ?? `beluga/${branch}`, branch) }))));
  process.exit(0);
}

if (args[0] === 'pr' && args[1] === 'merge') {
  const hit = find(args[2] ?? '');
  if (!hit) fail(`no pull requests found for "${args[2]}"`);
  state.merges = [...(state.merges ?? []), args];
  if (state.mergeError) {
    writeFileSync(file, JSON.stringify(state, null, 2));
    fail(state.mergeError);
  }
  const [branch, pr] = hit;
  const method = (args.find((a) => ['--squash', '--merge', '--rebase'].includes(a)) ?? '--merge').slice(2).toUpperCase();
  state.prs[branch] = args.includes('--auto') ? { ...pr, autoMergeRequest: { mergeMethod: method } } : { ...pr, state: 'MERGED', autoMergeRequest: null };
  writeFileSync(file, JSON.stringify(state, null, 2));
  process.exit(0);
}

fail(`fake gh: ${args.join(' ')} isn't something it knows`);
