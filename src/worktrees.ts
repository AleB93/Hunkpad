// Running code in a repository's worktrees: scripts saved once per repository
// run in whichever worktree is active, and each worktree gets its own number
// (and port) so two of them can run side by side. No Git here: main.ts has the UI.

import { pathKey } from "./platform";

const trimSlash = (p: string) => p.replace(/[\\/]+$/, "");

/** `path` is `root` or inside it. */
export function isInside(path: string, root: string): boolean {
  const p = pathKey(path.replace(/\\/g, "/"));
  const r = pathKey(trimSlash(root.replace(/\\/g, "/")));
  return p === r || p.startsWith(`${r}/`);
}

/**
 * The same file in the worktree `current`: a script saved as a path inside one
 * of the repository's work trees (`roots`) is moved to the same place in
 * `current`. The innermost root wins (a worktree may sit inside the main one,
 * e.g. .claude/worktrees/x). Paths outside every root are returned as they are.
 */
export function inWorktree(path: string, roots: string[], current: string): string {
  const owner = roots
    .filter((r) => isInside(path, r))
    .sort((a, b) => trimSlash(b).length - trimSlash(a).length)[0];
  if (!owner) return path;
  return `${trimSlash(current)}${path.slice(trimSlash(owner).length)}`;
}

/** Variables for scripts run in worktree number `index` (0 = the main work tree). */
export function worktreeEnv(index: number, root: string, basePort: number | null): [string, string][] {
  const env: [string, string][] = [
    ["HUNKPAD_WORKTREE", String(index)],
    ["HUNKPAD_WORKTREE_PATH", root],
  ];
  if (basePort) env.push(["PORT", String(basePort + index)]);
  return env;
}

/** The setup's copy list as typed: one repo-relative path per line, without blanks, duplicates or `./`. */
export function parseCopyList(text: string): string[] {
  const paths = text
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\.\//, "").replace(/\/+$/, ""))
    .filter(Boolean);
  return [...new Set(paths)];
}

/** A copy-list path Hunkpad accepts: relative, inside the repository, not .git. */
export const validCopyPath = (p: string) =>
  !/^([a-z]:|\/)/i.test(p) && !p.split("/").some((s) => s === ".." || s === "." || s === "" || s === ".git");

/** Files often kept out of Git that a worktree needs to run, offered by default when they exist. */
export const COMMON_LOCAL_FILES = [".env", ".env.local", ".env.development.local", ".dev.vars"];
