/**
 * BEAN FX — Editing engine (Milestone 1, shared editing core).
 *
 * Transactional application + undo/redo on top of the pure command layer.
 * The history holds the original forward commands and their inverses, so redo
 * replays exactly what the user did (never a regenerated approximation).
 */
import { applyCommand, type Command } from "./commands";
import type { Sequence } from "./model";
import { assertValidSequence } from "./model";

const MAX_HISTORY = 200;

interface HistoryEntry {
  forward: Command[];
  inverse: Command[];
}

export interface TransactionResult {
  sequence: Sequence;
  /** Inverses of each command, same order as the input commands. */
  inverses: Command[][];
  warnings: string[];
}

/** Apply a batch atomically: any failing command aborts the batch (the input
 *  sequence is never mutated — commands work on clones). Returns the final
 *  sequence plus per-command inverses for the caller's undo stack. */
export function applyTransaction(seq: Sequence, commands: unknown[]): TransactionResult {
  let current = seq;
  const inverses: Command[][] = [];
  const warnings: string[] = [];
  for (let i = 0; i < commands.length; i++) {
    try {
      const result = applyCommand(current, commands[i]);
      current = result.sequence;
      inverses.push(result.inverse);
      const report = assertValidSequence(current);
      warnings.push(...report.warnings);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw new Error(`transaction aborted at command ${i + 1}/${commands.length}: ${message}`);
    }
  }
  return { sequence: current, inverses, warnings };
}

/**
 * Client-side editing session history: undo/redo over command batches.
 * Persistence is handled separately (versions on the server) — this class
 * governs the interactive session state.
 */
export class EditHistory {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];

  constructor(public current: Sequence) {}

  /** Apply one command or an atomic batch. Returns warnings from validation. */
  apply(commands: unknown[]): { warnings: string[] } {
    const result = applyTransaction(this.current, commands);
    this.current = result.sequence;
    this.undoStack.push({ forward: commands.flatMap((c) => [c as Command]), inverse: result.inverses.flat() });
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
    return { warnings: result.warnings };
  }

  undo(): { ok: boolean; warnings: string[] } {
    const entry = this.undoStack.pop();
    if (!entry) return { ok: false, warnings: [] };
    // Undo = apply the inverse commands in reverse order (last change first).
    // The entry itself moves to the redo stack unchanged: its `forward` is
    // exactly what redo replays, and its `inverse` undoes that again.
    // A failing inverse must not corrupt the stack: the entry is pushed back
    // and the failure is REPORTED (ok:false), never swallowed.
    let seq = this.current;
    try {
      for (let i = entry.inverse.length - 1; i >= 0; i--) {
        seq = applyCommand(seq, entry.inverse[i]).sequence;
      }
    } catch (err) {
      this.undoStack.push(entry);
      return { ok: false, warnings: [err instanceof Error ? err.message : "undo failed"] };
    }
    this.current = seq;
    this.redoStack.push(entry);
    return { ok: true, warnings: assertValidSequence(seq).warnings };
  }

  redo(): { ok: boolean; warnings: string[] } {
    const entry = this.redoStack.pop();
    if (!entry) return { ok: false, warnings: [] };
    // Redo = replay the original forward commands in order. Same resilience
    // contract as undo: a failed replay keeps the entry and reports failure.
    let seq = this.current;
    try {
      for (const cmd of entry.forward) {
        seq = applyCommand(seq, cmd).sequence;
      }
    } catch (err) {
      this.redoStack.push(entry);
      return { ok: false, warnings: [err instanceof Error ? err.message : "redo failed"] };
    }
    this.current = seq;
    this.undoStack.push(entry);
    return { ok: true, warnings: assertValidSequence(seq).warnings };
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** The forward commands redo() would replay, or null — lets the persistence
   *  layer persist a redo as the same command batch. */
  peekRedoForward(): Command[] | null {
    return this.redoStack.length > 0 ? this.redoStack[this.redoStack.length - 1].forward : null;
  }

  /** The inverse commands undo() would apply (in undo's application order:
   *  reversed), or null — lets the persistence layer persist an undo as the
   *  same command batch. */
  peekUndoInverses(): Command[] | null {
    const entry = this.undoStack[this.undoStack.length - 1];
    return entry ? [...entry.inverse].reverse() : null;
  }
}
