// Review comments on lines of the current files. Local only: stored with the
// repository's other Diffpane data in .diffpane/state.json (repoStore.ts).
//
// A comment remembers its line number *and* that line's text, so it follows the
// line when code above it moves. If the text is gone, it is "outdated" (kept,
// shown apart) instead of silently landing on the wrong line.

import { repoData, updateRepoData } from "./repoStore";

export interface ReviewComment {
  id: string;
  /** Repo-relative path. */
  path: string;
  /** 1-based line in the file (last known position). */
  line: number;
  /** The line's text (trimmed) when commented: how the comment finds its line again. */
  anchor: string;
  text: string;
  created: number;
  updated?: number;
  resolved: boolean;
}

const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function loadComments(root: string): ReviewComment[] {
  return copy(repoData(root).comments);
}

export function saveComments(root: string, comments: ReviewComment[]) {
  updateRepoData(root, (d) => (d.comments = copy(comments)));
}

/**
 * Where the comment's line is now in `lines` (1-based), or null if outdated:
 * the remembered line if its text still matches, else the nearest line with the
 * same text.
 */
export function locate(lines: string[], c: ReviewComment): number | null {
  if (!c.anchor) return c.line >= 1 && c.line <= lines.length ? c.line : null; // a blank line: trust the number
  if (lines[c.line - 1]?.trim() === c.anchor) return c.line;
  let best: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== c.anchor) continue;
    if (best === null || Math.abs(i + 1 - c.line) < Math.abs(best - c.line)) best = i + 1;
  }
  return best;
}

export function newCommentId(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
