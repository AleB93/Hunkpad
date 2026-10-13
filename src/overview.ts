// The "all changes" overview shown when no file is selected: every changed
// file with only its changed chunks (and a little context), parsed from
// `git diff -U3` output.

export interface PatchLine {
  kind: " " | "-" | "+";
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface PatchHunk {
  /** The text after the second "@@" (often the enclosing function). */
  context: string;
  lines: PatchLine[];
}

export interface PatchFile {
  path: string;
  oldPath: string | null;
  binary: boolean;
  hunks: PatchHunk[];
  added: number;
  removed: number;
}

/** A path from a diff header. Git ends "--- a/x" / "+++ b/x" with a tab when the name has a space. */
const unquote = (raw: string) => {
  const p = raw.replace(/\t$/, "");
  return p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p;
};

/** Parses unified diff output (any number of files) into files and hunks. */
export function parsePatch(out: string): PatchFile[] {
  const files: PatchFile[] = [];
  let file: PatchFile | null = null;
  let hunk: PatchHunk | null = null;
  let inHunks = false;
  let oldNo = 0;
  let newNo = 0;

  for (const raw of out.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("diff --git ")) {
      // "a/X b/Y": take the b/ side as a first guess; ---/+++/rename lines refine it.
      const s = line.slice("diff --git ".length);
      const cut = s.lastIndexOf(" b/");
      file = {
        path: unquote(cut >= 0 ? s.slice(cut + 3) : s),
        oldPath: null,
        binary: false,
        hunks: [],
        added: 0,
        removed: 0,
      };
      files.push(file);
      hunk = null;
      inHunks = false;
      continue;
    }
    if (!file) continue;
    if (!inHunks) {
      if (line.startsWith("rename from ")) file.oldPath = line.slice("rename from ".length);
      else if (line.startsWith("rename to ")) file.path = line.slice("rename to ".length);
      else if (line.startsWith("+++ ") && line !== "+++ /dev/null") file.path = unquote(line.slice(4)).replace(/^b\//, "");
      else if (line.startsWith("Binary files ")) file.binary = true;
    }
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(line);
    if (m) {
      inHunks = true;
      oldNo = Number(m[1]);
      newNo = Number(m[2]);
      hunk = { context: m[3], lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    const kind = line[0];
    if (kind === " ") hunk.lines.push({ kind, text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    else if (kind === "-") {
      hunk.lines.push({ kind, text: line.slice(1), oldNo: oldNo++, newNo: null });
      file.removed++;
    } else if (kind === "+") {
      hunk.lines.push({ kind, text: line.slice(1), oldNo: null, newNo: newNo++ });
      file.added++;
    }
  }
  return files;
}

/** A new (untracked) file shown as one all-added chunk, at most `maxLines` lines. */
export function untrackedPatch(path: string, content: string | null, maxLines: number): PatchFile {
  if (content === null || content.includes("\0")) {
    return { path, oldPath: null, binary: content !== null, hunks: [], added: 0, removed: 0 };
  }
  const all = content.split("\n");
  if (all[all.length - 1] === "") all.pop();
  const lines: PatchLine[] = all
    .slice(0, maxLines)
    .map((text, i) => ({ kind: "+", text: text.replace(/\r$/, ""), oldNo: null, newNo: i + 1 }));
  return { path, oldPath: null, binary: false, hunks: [{ context: "new file", lines }], added: all.length, removed: 0 };
}
