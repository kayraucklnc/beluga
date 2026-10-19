import type { WorkState } from '../core/work-store.js';
import type { KlaudClient } from '../ipc/client.js';
import { TerminalEmulator } from '../terminal/index.js';

/**
 * This screen's emulators for the terminal programs klaud runs (one per key, made when first
 * shown). A program that ended and started again gets a fresh emulator; one that's gone is freed.
 */
export class TerminalScreens {
  private readonly emulators = new Map<string, TerminalEmulator>();

  constructor(private readonly client: KlaudClient) {}

  /** The emulator for `key`, if klaud runs (or ran) a program by that name. */
  get(key: string, size: { cols: number; rows: number }, state: Pick<WorkState, 'terminals' | 'termExits'>): TerminalEmulator | undefined {
    this.prune(state);
    if (!(key in state.terminals)) return undefined;
    let emu = this.emulators.get(key);
    // It ended and was started again: the old emulator shows the old program.
    if (emu?.exited && !(key in state.termExits)) {
      emu.dispose();
      emu = undefined;
    }
    if (!emu) {
      emu = new TerminalEmulator(this.client.attachTerminal(key), { id: key, cols: size.cols, rows: size.rows, title: state.terminals[key] });
      this.emulators.set(key, emu);
    }
    return emu;
  }

  /** Free emulators of programs klaud no longer has. */
  prune(state: Pick<WorkState, 'terminals'>): void {
    for (const [key, emu] of this.emulators) {
      if (key in state.terminals) continue;
      emu.dispose();
      this.emulators.delete(key);
    }
  }

  dispose(): void {
    for (const emu of this.emulators.values()) emu.dispose();
    this.emulators.clear();
  }
}
