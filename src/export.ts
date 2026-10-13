// "Copy for LLM": turns diffs, file status and review comments into plain
// Markdown for pasting into a chat. Data only: no instructions or prompt text,
// so the reader decides what to ask.

export interface ExportComment {
  /** Current line, or null when the commented line is gone (outdated). */
  line: number | null;
  status: "open" | "resolved" | "outdated";
  /** The commented line's code. */
  anchor: string;
  text: string;
}

export interface ExportFile {
  path: string;
  /** e.g. "modified · unstaged". */
  status: string;
  /** Unified diff for this file (may be empty, e.g. for a comment-only entry). */
  patch: string;
  note?: string;
  comments: ExportComment[];
}

export interface ExportDoc {
  title: string;
  /** "Key: value" lines under the title (repository, branch, scope…). */
  meta: string[];
  /** Free text before the files, e.g. a commit message. */
  intro?: string;
  files: ExportFile[];
}

/** A code fence longer than any backtick run inside, so the content cannot close it. */
export function fenceFor(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(longest + 1);
}

const unquote = (p: string) => (p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p);

/** Splits a multi-file unified diff into one chunk per file. */
export function splitPatch(out: string): { path: string; text: string }[] {
  const chunks: { path: string; text: string }[] = [];
  let lines: string[] = [];
  const flush = () => {
    if (!lines.length) return;
    // The new-side path: "+++ b/x" (or "--- a/x" for a deletion), else the header.
    const plus = lines.find((l) => l.startsWith("+++ ") && !l.startsWith("+++ /dev/null"));
    const minus = lines.find((l) => l.startsWith("--- ") && !l.startsWith("--- /dev/null"));
    const header = lines[0].slice("diff --git ".length);
    const fromHeader = header.slice(header.lastIndexOf(" b/") + 3);
    const raw = plus ? plus.slice(4).replace(/^b\//, "") : minus ? minus.slice(4).replace(/^a\//, "") : fromHeader;
    chunks.push({ path: unquote(raw.replace(/\t$/, "").trim()), text: lines.join("\n").replace(/\s+$/, "") });
    lines = [];
  };
  for (const line of out.split("\n")) {
    if (line.startsWith("diff --git ")) flush();
    if (line.startsWith("diff --git ") || lines.length) lines.push(line.replace(/\r$/, ""));
  }
  flush();
  return chunks;
}

const STATUS_WORDS: Record<string, string> = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "type changed",
  U: "untracked (new file)",
  "!": "conflicted",
};
export const statusWord = (letter: string | null | undefined) => (letter && STATUS_WORDS[letter]) || "changed";

export function toMarkdown(doc: ExportDoc): string {
  const out: string[] = [`# ${doc.title}`, ""];
  for (const m of doc.meta) out.push(`- ${m}`);
  const commentCount = doc.files.reduce((n, f) => n + f.comments.length, 0);
  out.push(`- Files: ${doc.files.length}${commentCount ? ` · Comments: ${commentCount}` : ""}`, "");
  if (doc.intro) out.push(doc.intro.trim(), "");

  for (const f of doc.files) {
    out.push(`## ${f.path}`, "", `Status: ${f.status}`);
    if (f.note) out.push(`Note: ${f.note}`);
    out.push("");
    if (f.patch.trim()) {
      const fence = fenceFor(f.patch);
      out.push(`${fence}diff`, f.patch.replace(/\s+$/, ""), fence, "");
    }
    if (f.comments.length) {
      out.push("Comments:");
      for (const c of f.comments) {
        const where = c.line === null ? "line no longer present" : `line ${c.line}`;
        const code = c.anchor ? ` on \`${c.anchor.replace(/`/g, "'")}\`` : "";
        out.push(`- ${where} · ${c.status}${code}`);
        for (const textLine of c.text.split("\n")) out.push(`  ${textLine}`);
      }
      out.push("");
    }
  }
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

/**
 * A group's change blocks as a unified diff, with up to `context` unchanged
 * index lines around each block. Old-side numbers are exact; new-side numbers
 * are the work tree's (other groups' blocks are not applied here).
 */
export function blocksPatch(
  path: string,
  indexText: string,
  blocks: { oldStart: number; oldCount: number; newStart: number; newCount: number; removed: string[]; added: string[] }[],
  context = 3,
): string {
  const lines = indexText.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const plain = lines.map((l) => l.replace(/\r$/, ""));
  const out = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`];
  for (const b of [...blocks].sort((x, y) => x.oldStart - y.oldStart)) {
    // First/last index line the block touches (an insertion sits after oldStart).
    const first = b.oldCount === 0 ? b.oldStart + 1 : b.oldStart;
    const last = b.oldCount === 0 ? b.oldStart : b.oldStart + b.oldCount - 1;
    const before = plain.slice(Math.max(0, first - 1 - context), first - 1);
    const after = plain.slice(last, last + context);
    const oldFrom = first - before.length;
    const newFrom = (b.newCount === 0 ? b.newStart + 1 : b.newStart) - before.length;
    const oldLen = before.length + b.oldCount + after.length;
    const newLen = before.length + b.newCount + after.length;
    out.push(`@@ -${oldFrom},${oldLen} +${newFrom},${newLen} @@`);
    out.push(...before.map((l) => ` ${l}`), ...b.removed.map((l) => `-${l}`), ...b.added.map((l) => `+${l}`), ...after.map((l) => ` ${l}`));
  }
  return out.join("\n");
}
