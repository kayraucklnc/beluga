import { randomUUID } from 'node:crypto';
import { existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import { type DialogueTurnTools, talkReadOnly } from '../../agent/dialogue-tools.js';
import type { AgentRunInput } from '../../agent/types.js';
import { readJson, writeJson } from '../../net/mesh/files.js';
import {
  type Dialogue as DialogueT,
  type DialogueStart,
  type Participant,
  Dialogue,
  DialogueError,
  continueDialogue,
  createDialogue,
  failDialogue,
  interject,
  isOver,
  nextSpeaker,
  nextTurn,
  stopDialogue,
  turnDone,
} from './model.js';
import { dialogueBrief, turnPrompt } from './prompt.js';

/** One turn for the host to run: whose, and the AgentRunInput parts the chair decides (spread them in). */
export interface DialogueTurnRun {
  readonly dialogue: DialogueT;
  readonly speaker: number;
  readonly participant: Participant;
  /** 1-based. */
  readonly turn: number;
  readonly input: Pick<AgentRunInput, 'prompt' | 'signal' | 'vetTool'> & { readonly dialogue: DialogueTurnTools };
}

/** What a turn came back with: its final answer and the tokens it spent. */
export interface DialogueTurnResult {
  readonly text: string;
  readonly tokens: number;
}

export interface ChairDeps {
  /** Where dialogues.json lives (beside plans); unset: kept in memory only. */
  readonly dir?: string;
  readonly now?: () => number;
  /** Run one turn as an ordinary run through the runtime seam (core/agent-host, the gateway for a friend's agent). */
  runTurn(run: DialogueTurnRun): Promise<DialogueTurnResult>;
  /** Every change, for the room thread and the screens. */
  onChange?(d: DialogueT): void;
}

/** Dialogues that are over and still kept (the newest). */
const KEEP_OVER = 50;

/** Talk and cross-reference turns only look; work turns use the tools work has. */
const readOnlyMode = (d: DialogueT): boolean => d.mode === 'talk' || d.mode === 'cross-reference';

/**
 * The chair: runs a dialogue's turns one after another, each one run of the speaker's agent with
 * the dialogue's brief and its end_dialogue tool, and applies the rules (model.ts) between them.
 * State is saved on every change, so a dialogue survives a restart: `resume()` picks up running
 * ones at the turn that was in flight.
 */
export class Chair {
  private dialogues = new Map<string, DialogueT>();
  private readonly inflight = new Map<string, AbortController>();
  private readonly drives = new Map<string, Promise<void>>();
  private readonly now: () => number;
  private readOnlyFile = false;

  constructor(private readonly deps: ChairDeps) {
    this.now = deps.now ?? Date.now;
    this.load();
  }

  list = (): readonly DialogueT[] => [...this.dialogues.values()];

  get = (id: string): DialogueT | undefined => this.dialogues.get(id);

  private need(id: string): DialogueT {
    const d = this.dialogues.get(id);
    if (!d) throw new DialogueError('That dialogue isn’t here any more');
    return d;
  }

  start(start: Omit<DialogueStart, 'id'> & { readonly id?: string }): DialogueT {
    const d = createDialogue({ ...start, id: start.id ?? `dlg_${randomUUID().replace(/-/g, '').slice(0, 12)}` }, this.now());
    if (this.dialogues.has(d.id)) throw new DialogueError('That dialogue already exists');
    this.put(d);
    this.drive(d.id);
    return d;
  }

  /** Continue? → yes. */
  continue(id: string, more?: number): DialogueT {
    const d = this.put(continueDialogue(this.need(id), this.now(), more));
    this.drive(id);
    return d;
  }

  /** Stop: over now; a turn in flight is aborted and its answer dropped. */
  stop(id: string, by?: string): DialogueT {
    const d = this.put(stopDialogue(this.need(id), this.now(), by));
    this.inflight.get(id)?.abort();
    return d;
  }

  /** A person speaks in: the next agent turn reads it. */
  interject(id: string, text: string, name: string): DialogueT {
    return this.put(interject(this.need(id), text, name, this.now()));
  }

  /** After a restart: every dialogue that was running goes on at its next turn. */
  resume(): void {
    for (const d of this.dialogues.values()) if (d.status === 'running') this.drive(d.id);
  }

  /** Resolves when the dialogue's loop has nothing more to do (paused, over, or idle). */
  settled(id: string): Promise<void> {
    return this.drives.get(id) ?? Promise.resolve();
  }

  /** Stop every loop (the daemon closing): nothing is marked stopped, so resume() goes on later. */
  close(): void {
    for (const ac of this.inflight.values()) ac.abort();
    this.inflight.clear();
  }

  private drive(id: string): void {
    if (this.drives.has(id)) return;
    const loop = this.loop(id).finally(() => this.drives.delete(id));
    this.drives.set(id, loop);
  }

  private async loop(id: string): Promise<void> {
    for (;;) {
      const d = this.dialogues.get(id);
      if (!d || d.status !== 'running') return;
      const speaker = nextSpeaker(d);
      const participant = d.participants[speaker]!;
      const ac = new AbortController();
      this.inflight.set(id, ac);
      let ended: string | undefined;
      const tools: DialogueTurnTools = {
        brief: dialogueBrief(d, speaker),
        end: (reason) => {
          ended = reason.trim() || 'Ended';
          return 'The dialogue ends after this turn. Give your last word now.';
        },
      };
      const turn = nextTurn(d);
      let result: DialogueTurnResult;
      try {
        result = await this.deps.runTurn({
          dialogue: d,
          speaker,
          participant,
          turn,
          input: { prompt: turnPrompt(d, speaker), signal: ac.signal, dialogue: tools, ...(readOnlyMode(d) ? { vetTool: talkReadOnly } : {}) },
        });
      } catch (err) {
        if (this.inflight.get(id) === ac) this.inflight.delete(id);
        // Stopped (or the daemon closing): the turn is dropped, nothing else changes.
        if (ac.signal.aborted) return;
        const cur = this.dialogues.get(id);
        if (cur) this.put(failDialogue(cur, `Turn ${turn} couldn't run: ${err instanceof Error ? err.message : String(err)}`, this.now()));
        return;
      }
      if (this.inflight.get(id) === ac) this.inflight.delete(id);
      const cur = this.dialogues.get(id);
      // Stopped meanwhile: Stop wins, the late answer is dropped.
      if (!cur || cur.status !== 'running' || ac.signal.aborted) return;
      this.put(turnDone(cur, { text: result.text, tokens: result.tokens, ...(ended !== undefined ? { ended } : {}) }, this.now()));
    }
  }

  private put(d: DialogueT): DialogueT {
    this.dialogues.set(d.id, d);
    this.save();
    this.deps.onChange?.(d);
    return d;
  }

  private file(): string | undefined {
    return this.deps.dir ? path.join(this.deps.dir, 'dialogues.json') : undefined;
  }

  private load(): void {
    const file = this.file();
    if (!file || !existsSync(file)) return;
    let raw: unknown;
    try {
      raw = readJson(file);
    } catch {
      raw = undefined;
    }
    const items = raw && typeof raw === 'object' && Array.isArray((raw as { dialogues?: unknown }).dialogues) ? (raw as { dialogues: unknown[] }).dialogues : undefined;
    if (!items) {
      try {
        renameSync(file, `${file}.unreadable-${this.now()}`);
      } catch {
        this.readOnlyFile = true;
      }
      return;
    }
    for (const item of items) {
      const r = Dialogue.safeParse(item);
      if (r.success) this.dialogues.set(r.data.id, r.data);
    }
  }

  /** Saved at once (small, and a restart must find the turn that was in flight). */
  private save(): void {
    const file = this.file();
    if (!file || this.readOnlyFile) return;
    const all = [...this.dialogues.values()];
    const over = all.filter(isOver).sort((a, b) => b.updatedAt - a.updatedAt);
    const drop = new Set(over.slice(KEEP_OVER).map((d) => d.id));
    for (const id of drop) this.dialogues.delete(id);
    try {
      writeJson(file, { version: 1, dialogues: all.filter((d) => !drop.has(d.id)) });
    } catch {
      // The next change tries again.
    }
  }
}
