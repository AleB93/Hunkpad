// Search in the repository: file names (Ctrl+P) and file contents (Ctrl+Shift+F,
// and Ctrl+click on a word). Both run on Git (`git ls-files`, `git grep`), so
// nothing is indexed and nothing stays in memory between searches.

/** A file-name match: `hits` are the matched character positions in `path`, for highlighting. */
export interface FileMatch {
  path: string;
  score: number;
  hits: number[];
}

/**
 * Fuzzy match of `query` in `path`: every query character must appear, in order.
 * Matches in the file name, at word starts (after / . _ - or a case change) and in
 * runs score higher; shorter paths win ties. Null when it does not match.
 */
export function fuzzyMatch(query: string, path: string): FileMatch | null {
  const q = query.replace(/\s+/g, "").toLowerCase();
  if (!q) return { path, score: 0, hits: [] };
  const p = path.toLowerCase();
  const nameStart = path.lastIndexOf("/") + 1;
  // Leftmost matching, tried within the file name and across the whole path: the better one wins.
  let best: FileMatch | null = null;
  for (const start of [nameStart, 0]) {
    const hits = leftmost(q, p, start);
    if (!hits) continue;
    let score = 0;
    hits.forEach((i, k) => {
      score += 1;
      if (k > 0 && i === hits[k - 1] + 1) score += 4; // a run
      if (isWordStart(path, i)) score += 3;
      if (i >= nameStart) score += 2;
    });
    if (p.slice(nameStart).startsWith(q)) score += 10;
    score -= path.length / 100;
    if (!best || score > best.score) best = { path, score, hits };
  }
  return best;
}

/** Positions of `q`'s characters in `p`, each the first one after the previous; null if one is missing. */
function leftmost(q: string, p: string, from: number): number[] | null {
  const hits: number[] = [];
  for (const ch of q) {
    const i = p.indexOf(ch, from);
    if (i === -1) return null;
    hits.push(i);
    from = i + 1;
  }
  return hits;
}

function isWordStart(path: string, i: number): boolean {
  if (i === 0) return true;
  const before = path[i - 1];
  if ("/\\._- ".includes(before)) return true;
  return before === before.toLowerCase() && path[i] !== path[i].toLowerCase(); // camelCase
}

/** The best `limit` matches, best first. */
export function rankFiles(query: string, paths: string[], limit = 100): FileMatch[] {
  const out: FileMatch[] = [];
  for (const path of paths) {
    const m = fuzzyMatch(query, path);
    if (m) out.push(m);
  }
  out.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return out.slice(0, limit);
}

export interface TextSearchOptions {
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
}

/** `git grep` arguments for a content search (tracked and untracked, not ignored). */
export function grepArgs(query: string, o: TextSearchOptions): string[] {
  return [
    "grep",
    "-n",
    "--column",
    "-z",
    "-I", // skip binary files
    "--untracked",
    "--no-color",
    ...(o.matchCase ? [] : ["-i"]),
    ...(o.wholeWord ? ["-w"] : []),
    o.regex ? "-E" : "-F",
    "-e",
    query,
  ];
}

/** One line that matched. `column` is 1-based, in characters. */
export interface TextMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

/**
 * Parses `git grep -n --column -z` output: `path NUL line NUL column NUL text`
 * per line. Git's column counts bytes; it is converted to characters here.
 * Stops after `limit` matches; `truncated` says there were more.
 */
export function parseGrep(out: string, limit = 2000): { matches: TextMatch[]; truncated: boolean } {
  const matches: TextMatch[] = [];
  let start = 0;
  while (start < out.length) {
    let end = out.indexOf("\n", start);
    if (end === -1) end = out.length;
    const row = out.slice(start, end);
    start = end + 1;
    const a = row.indexOf("\0");
    const b = row.indexOf("\0", a + 1);
    const c = row.indexOf("\0", b + 1);
    if (a < 0 || b < 0 || c < 0) continue;
    if (matches.length === limit) return { matches, truncated: true };
    const text = row.slice(c + 1).replace(/\r$/, "");
    matches.push({
      path: row.slice(0, a),
      line: Number(row.slice(a + 1, b)),
      column: byteToCharColumn(text, Number(row.slice(b + 1, c))),
      text,
    });
  }
  return { matches, truncated: false };
}

function byteToCharColumn(text: string, byteColumn: number): number {
  const enc = new TextEncoder();
  let bytes = 0;
  let col = 1;
  for (const ch of text) {
    if (bytes + 1 >= byteColumn) break;
    bytes += enc.encode(ch).length;
    col += ch.length;
  }
  return col;
}

/** Where the match is in `text` (0-based, characters), for highlighting; null if not found again. */
export function matchRange(text: string, query: string, o: TextSearchOptions, from = 0): [number, number] | null {
  const source = o.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let re: RegExp;
  try {
    re = new RegExp(o.wholeWord ? `(?<![\\w])(?:${source})(?![\\w])` : source, o.matchCase ? "g" : "gi");
  } catch {
    return null; // an ERE that is not a valid JS regex
  }
  re.lastIndex = Math.max(0, from);
  const m = re.exec(text);
  return m && m[0].length ? [m.index, m.index + m[0].length] : null;
}
