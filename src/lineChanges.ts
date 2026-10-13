// Line-level staging: build a new file from an original plus a chosen subset
// of the diff editor's line changes (same approach VS Code uses).

export interface LineChange {
  /** For an insertion: the original line after which lines were inserted. */
  originalStartLineNumber: number;
  /** 0 for an insertion. */
  originalEndLineNumber: number;
  /** For a deletion: the modified line after which lines were removed. */
  modifiedStartLineNumber: number;
  /** 0 for a deletion. */
  modifiedEndLineNumber: number;
}

/** Splits into lines, each keeping its own terminator. */
export function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Returns `original` with only `changes` (taken from original → modified) applied. */
export function applyLineChanges(original: string, modified: string, changes: readonly LineChange[]): string {
  return applyLineChangesWithRanges(original, modified, changes).text;
}

/**
 * Like applyLineChanges, and also reports where each change landed in the
 * result: `ranges[i]` = [first, last] line of change i (for a deletion, the
 * line after which lines were removed, twice).
 */
export function applyLineChangesWithRanges(
  original: string,
  modified: string,
  changes: readonly LineChange[],
): { text: string; ranges: [number, number][] } {
  const orig = splitLines(original);
  const mod = splitLines(modified);
  const eol = original.includes("\r\n") || modified.includes("\r\n") ? "\r\n" : "\n";
  const out: string[] = [];
  const push = (lines: string[]) => {
    for (const line of lines) {
      // A line that was the last one (no terminator) now has something after it.
      const last = out.length - 1;
      if (last >= 0 && !out[last].endsWith("\n")) out[last] += eol;
      out.push(line);
    }
  };

  let next = 0; // 0-based index of the next original line to copy
  const ranges: [number, number][] = changes.map(() => [0, 0]);
  const order = changes
    .map((c, i) => ({ c, i }))
    .sort((a, b) => a.c.originalStartLineNumber - b.c.originalStartLineNumber);
  for (const { c, i } of order) {
    const insertion = c.originalEndLineNumber === 0;
    const deletion = c.modifiedEndLineNumber === 0;
    push(orig.slice(next, insertion ? c.originalStartLineNumber : c.originalStartLineNumber - 1));
    const first = out.length + 1;
    if (!deletion) push(mod.slice(c.modifiedStartLineNumber - 1, c.modifiedEndLineNumber));
    ranges[i] = deletion ? [out.length, out.length] : [first, out.length];
    next = insertion ? c.originalStartLineNumber : c.originalEndLineNumber;
  }
  push(orig.slice(next));
  return { text: out.join(""), ranges };
}
