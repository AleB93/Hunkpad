// Change blocks ("hunks") for block-level change groups, like IntelliJ's
// partial changelists. Hunks are the unstaged changes (index → work tree) as
// Git reports them with `git diff -U0`; each one belongs to a local group.

import type { LineChange } from "./lineChanges";

export interface Hunk {
  path: string;
  /** Lines in the index version (old side); count 0 = insertion after oldStart. */
  oldStart: number;
  oldCount: number;
  /** Lines in the work tree (new side); count 0 = deletion after newStart. */
  newStart: number;
  newCount: number;
  removed: string[];
  added: string[];
  /** A whole-file change that cannot be split. */
  whole?: "untracked" | "binary";
  /** Stable-ish identity: the hunk's content. */
  sig: string;
  /** Identity of the replaced index lines only (survives further edits inside the block). */
  rsig: string;
}

/** What is stored per hunk (projects.ts): enough to recognise it after more edits. */
export interface HunkAssignment {
  path: string;
  group: string | null;
  oldStart: number;
  oldCount: number;
  sig: string;
  rsig: string;
}

/** FNV-1a, enough to tell hunks apart; never used for security. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function finish(h: Omit<Hunk, "sig" | "rsig">): Hunk {
  if (h.whole) return { ...h, sig: h.whole, rsig: h.whole };
  return {
    ...h,
    sig: hash(`${h.removed.join("\n")}\u0000${h.added.join("\n")}`),
    rsig: hash(h.removed.join("\n")),
  };
}

export function wholeFileHunk(path: string, kind: "untracked" | "binary"): Hunk {
  return finish({ path, oldStart: 0, oldCount: 0, newStart: 0, newCount: 0, removed: [], added: [], whole: kind });
}

const unquote = (p: string) => (p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p);

/** Parses `git diff -U0 --no-renames` output into hunks. */
export function parseDiffU0(out: string): Hunk[] {
  const hunks: Hunk[] = [];
  let path = "";
  let inHunks = false;
  let cur: Omit<Hunk, "sig" | "rsig"> | null = null;
  const flush = () => {
    if (cur) hunks.push(finish(cur));
    cur = null;
  };

  for (const raw of out.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("diff --git ")) {
      flush();
      inHunks = false;
      // "a/X b/X": both names are equal without renames.
      const s = line.slice("diff --git ".length);
      path = unquote(s.slice(0, (s.length - 1) / 2)).replace(/^a\//, "");
      continue;
    }
    if (!inHunks) {
      if (line.startsWith("+++ ") && line !== "+++ /dev/null") path = unquote(line.slice(4)).replace(/^b\//, "");
      else if (line.startsWith("--- ") && line !== "--- /dev/null") path = unquote(line.slice(4)).replace(/^a\//, "");
      else if (line.startsWith("Binary files ")) hunks.push(wholeFileHunk(path, "binary"));
    }
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      flush();
      inHunks = true;
      cur = {
        path,
        oldStart: Number(m[1]),
        oldCount: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newCount: m[4] === undefined ? 1 : Number(m[4]),
        removed: [],
        added: [],
      };
      continue;
    }
    if (cur && line.startsWith("-")) cur.removed.push(line.slice(1));
    else if (cur && line.startsWith("+")) cur.added.push(line.slice(1));
  }
  flush();
  return hunks;
}

/** The hunk in the line-change form used by applyLineChanges / Monaco. */
export function toLineChange(h: Hunk): LineChange {
  return {
    originalStartLineNumber: h.oldStart,
    originalEndLineNumber: h.oldCount === 0 ? 0 : h.oldStart + h.oldCount - 1,
    modifiedStartLineNumber: h.newStart,
    modifiedEndLineNumber: h.newCount === 0 ? 0 : h.newStart + h.newCount - 1,
  };
}

/** Old-side span; an insertion is the point between two lines. Padded so adjacent blocks touch. */
function span(start: number, count: number): [number, number] {
  return count === 0 ? [start + 0.5, start + 0.5] : [start - 0.5, start + count - 0.5];
}

const overlaps = (a: { oldStart: number; oldCount: number }, b: { oldStart: number; oldCount: number }) => {
  const [a0, a1] = span(a.oldStart, a.oldCount);
  const [b0, b1] = span(b.oldStart, b.oldCount);
  return a0 <= b1 && b0 <= a1;
};

/**
 * Gives each current hunk of one file its group, following the stored
 * assignments as the file keeps changing:
 *   1. same content (unchanged block, or a block that only moved),
 *   2. same replaced lines at an overlapping place (edited further inside the block),
 *   3. any overlapping place (blocks merged or reshaped),
 *   otherwise it is new and goes to the active group.
 */
export function resolveGroups(hunks: Hunk[], stored: HunkAssignment[], active: string | null): (string | null)[] {
  const used = new Set<HunkAssignment>();
  const take = (pred: (a: HunkAssignment) => boolean) => {
    const a = stored.find((x) => !used.has(x) && pred(x));
    if (a) used.add(a);
    return a;
  };
  return hunks.map((h) => {
    const a =
      take((x) => x.sig === h.sig) ??
      take((x) => x.rsig === h.rsig && overlaps(x, h)) ??
      take((x) => overlaps(x, h)) ??
      stored.find((x) => x.sig === h.sig);
    return a ? a.group : active;
  });
}

export const assignmentOf = (h: Hunk, group: string | null): HunkAssignment => ({
  path: h.path,
  group,
  oldStart: h.oldStart,
  oldCount: h.oldCount,
  sig: h.sig,
  rsig: h.rsig,
});

export const sameHunk = (a: HunkAssignment, h: Hunk) =>
  a.path === h.path && a.sig === h.sig && a.oldStart === h.oldStart;
