import { randomBytes } from 'node:crypto';
import { existsSync, realpathSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { readJson, writeJson } from '../../net/mesh/files.js';
import { type AccessDecision, type Capabilities, type Decision, type RequestFacts, Rule, capabilitiesFrom, decideAccess, ruleExpired, ruleFor } from './access.js';

/**
 * Your rules and capability settings, kept on this Mac: rules in ~/.klaud/rules.json (readable
 * only by you), capabilities in your settings. Expired rules are dropped as they're met. Without
 * a file (tests, the demo's simulated friends) everything stays in memory.
 */

const MAX_RULES = 500;
const RulesFile = z.object({ version: z.literal(1), rules: z.array(z.unknown()) });

export const ruleId = (): string => `r_${randomBytes(9).toString('base64url')}`;

/** A rule as it may be saved from a screen (an id to change one; none to add one). */
export const RuleInput = Rule.omit({ id: true, createdAt: true }).extend({ id: Rule.shape.id.optional() });
export type RuleInput = z.input<typeof RuleInput>;

/** A folder as typed (~ is your home) → where it really is, so a rule's scope can't be dodged by a link. */
export function realFolder(raw: string, home = os.homedir()): string {
  const abs = path.resolve(raw === '~' ? home : raw.startsWith('~/') ? path.join(home, raw.slice(2)) : raw);
  try {
    return realpathSync.native(abs);
  } catch {
    return abs;
  }
}

/** An Allow rule for any command, anywhere, would be full trust for commands: it needs a folder or a project. */
function checkScope(rule: Rule): void {
  if (rule.kind === 'command' && rule.decision === 'allow' && rule.command === undefined && rule.folder === undefined && rule.project === undefined) {
    throw new Error('An Allow rule for any command needs a folder or a project (or name the command)');
  }
}

export interface RuleBookDeps {
  /** ~/.klaud/rules.json (null: memory only). */
  readonly file: string | null;
  readonly loadCaps: () => unknown;
  readonly saveCaps: (caps: Capabilities) => void;
  /** Something about the file you should know (it couldn't be read, and was put aside). */
  readonly onProblem?: (title: string, body: string) => void;
  /** The book changed (show it). */
  readonly onChange: (rules: readonly Rule[], caps: Capabilities) => void;
  readonly now: () => number;
}

export class RuleBook {
  private list: readonly Rule[] = [];
  private caps: Capabilities;

  constructor(private readonly deps: RuleBookDeps) {
    this.caps = capabilitiesFrom(deps.loadCaps());
    if (deps.file && existsSync(deps.file)) this.load(deps.file);
    this.prune();
  }

  /** Read the rules; a file that can't be read (or has rules that can't) is put aside, never overwritten. */
  private load(file: string): void {
    const parsed = RulesFile.safeParse(readJson(file));
    const rules = parsed.success ? parsed.data.rules.map((raw) => Rule.safeParse(raw)) : [];
    this.list = rules.flatMap((r) => (r.success ? [r.data] : []));
    const lost = parsed.success ? rules.filter((r) => !r.success).length : -1;
    if (lost === 0) return;
    const aside = `${file}.bad-${new Date(this.deps.now()).toISOString().replace(/[:.]/g, '-')}`;
    try {
      renameSync(file, aside);
    } catch {
      // Can't move it: it stays, and is replaced at the next change.
    }
    if (this.list.length) writeJson(file, { version: 1, rules: this.list });
    this.deps.onProblem?.(
      lost < 0 ? "Your rules couldn't be read" : `${lost} of your rules couldn't be read`,
      `${lost < 0 ? 'None of them apply' : 'The others still apply'}: requests they covered ask you again. The file was kept as ${aside}.`,
    );
  }

  rules(): readonly Rule[] {
    this.prune();
    return this.list;
  }

  capabilities(): Capabilities {
    return this.caps;
  }

  decide(facts: RequestFacts, trust: string, self = false): AccessDecision {
    return decideAccess({ trust, caps: this.caps, rules: this.rules(), facts, now: this.deps.now(), self });
  }

  /** "Always" for a request: the rule it writes (this person, kind, needs and the scope you chose). */
  remember(facts: RequestFacts, peerName: string, decision: Pick<Decision, 'scope' | 'command' | 'expiry'>): Rule {
    const rule = ruleFor(facts, peerName, decision, this.deps.now(), ruleId());
    checkScope(rule);
    // The same rule again replaces the old one (a new expiry), rather than piling up.
    const same = (r: Rule): boolean => r.peerId === rule.peerId && r.kind === rule.kind && r.decision === 'allow' && r.project === rule.project && r.folder === rule.folder && r.command === rule.command && r.needs.join() === rule.needs.join();
    this.write([...this.list.filter((r) => !same(r)), rule]);
    return rule;
  }

  /** Add a rule, or change one (same id). */
  save(input: RuleInput): Rule {
    const parsed = RuleInput.parse(input);
    const old = parsed.id ? this.list.find((r) => r.id === parsed.id) : undefined;
    if (parsed.id && !old) throw new Error('That rule is gone');
    const rule = Rule.parse({ ...parsed, ...(parsed.folder ? { folder: realFolder(parsed.folder) } : {}), id: old?.id ?? ruleId(), createdAt: old?.createdAt ?? this.deps.now() });
    checkScope(rule);
    if (rule.expiresAt !== undefined && rule.expiresAt <= this.deps.now()) throw new Error('That expiry is in the past');
    this.write(old ? this.list.map((r) => (r.id === rule.id ? rule : r)) : [...this.list, rule]);
    return rule;
  }

  remove(id: string): boolean {
    if (!this.list.some((r) => r.id === id)) return false;
    this.write(this.list.filter((r) => r.id !== id));
    return true;
  }

  /** Forget everything about one person (they were removed). */
  forget(peerId: string): void {
    if (this.list.some((r) => r.peerId === peerId)) this.write(this.list.filter((r) => r.peerId !== peerId));
  }

  setCapabilities(patch: { levels?: Partial<Capabilities['levels']>; folders?: readonly string[] }): Capabilities {
    this.caps = capabilitiesFrom({ levels: { ...this.caps.levels, ...(patch.levels ?? {}) }, folders: patch.folders ?? this.caps.folders });
    this.deps.saveCaps(this.caps);
    this.deps.onChange(this.list, this.caps);
    return this.caps;
  }

  private prune(): void {
    const now = this.deps.now();
    if (this.list.some((r) => ruleExpired(r, now))) this.write(this.list.filter((r) => !ruleExpired(r, now)));
  }

  private write(next: readonly Rule[]): void {
    if (next.length > MAX_RULES) throw new Error(`At most ${MAX_RULES} rules`);
    this.list = next;
    if (this.deps.file) writeJson(this.deps.file, { version: 1, rules: next });
    this.deps.onChange(next, this.caps);
  }
}
