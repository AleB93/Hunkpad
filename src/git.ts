// All Git logic. Talks to the native side only through `run_git`,
// `read_file` and `write_file` (src-tauri/src/lib.rs).

import { invoke } from "@tauri-apps/api/core";

export interface GitOutput {
  code: number;
  stdout: string;
  stderr: string;
}

export class GitError extends Error {
  constructor(readonly args: string[], readonly output: GitOutput) {
    super(output.stderr.trim() || output.stdout.trim() || `git ${args[0]} exited with code ${output.code}`);
  }
}

/** git could not be started: Git is not installed (or not found). */
export class GitNotFoundError extends Error {
  constructor() {
    super("Git was not found. Install Git (git-scm.com).");
  }
}

let onGitMissing: () => void = () => {};
/** Called whenever a command fails because Git is missing. */
export function setGitMissingHandler(fn: () => void) {
  onGitMissing = fn;
}

/** The folder is neither a repository nor inside one. */
export class NotARepoError extends Error {
  constructor(readonly path: string) {
    super(`${path} is not a Git repository`);
  }
}

interface RunOptions {
  stdin?: string;
  /** Return a non-zero exit instead of throwing. */
  allowFail?: boolean;
  /** Keep read-only commands out of the output log. */
  quiet?: boolean;
  /** Use this temporary index instead of the repository's (GIT_INDEX_FILE). */
  indexFile?: string;
}

type Logger = (text: string, isError: boolean) => void;
let logger: Logger = () => {};
export function setLogger(fn: Logger) {
  logger = fn;
}

/** A command about to run that changes something (see setApprover). */
export interface PendingCommand {
  cwd: string;
  args: string[];
  stdin?: string;
  indexFile?: string;
}

/** The user said no to a command: the action stops, nothing else runs. */
export class CancelledError extends Error {
  constructor() {
    super("Cancelled");
  }
}

type Approver = (cmd: PendingCommand) => Promise<boolean>;
let approver: Approver | null = null;
/** Asked before every non-quiet (state-changing) command; read-only commands are `quiet`. */
export function setApprover(fn: Approver | null) {
  approver = fn;
}

/** Told when an approved command starts and ends; its live output arrives as `git-output` events. */
export interface RunObserver {
  started(id: number, cmd: PendingCommand): void;
  finished(id: number, result: GitOutput | null, ms: number): void;
}
let observer: RunObserver | null = null;
export function setRunObserver(o: RunObserver | null) {
  observer = o;
}
let nextStreamId = 1;

export async function runGit(cwd: string, args: string[], opts: RunOptions = {}): Promise<GitOutput> {
  let streamId: number | null = null;
  if (!opts.quiet && approver) {
    const cmd = { cwd, args, stdin: opts.stdin, indexFile: opts.indexFile };
    const ok = await approver(cmd);
    if (!ok) throw new CancelledError();
    if (observer) {
      streamId = nextStreamId++;
      observer.started(streamId, cmd);
    }
  }
  const t0 = performance.now();
  let out: GitOutput;
  try {
    out = await invoke<GitOutput>("run_git", {
      cwd,
      args,
      stdin: opts.stdin ?? null,
      indexFile: opts.indexFile ?? null,
      streamId,
    });
  } catch (e) {
    if (streamId !== null) observer?.finished(streamId, null, performance.now() - t0);
    if (String(e) === "GIT_NOT_FOUND") {
      onGitMissing();
      throw new GitNotFoundError();
    }
    throw e;
  }
  if (streamId !== null) observer?.finished(streamId, out, performance.now() - t0);
  const failed = out.code !== 0;
  if (!opts.quiet || (failed && !opts.allowFail)) {
    const detail = [out.stdout, out.stderr].map((s) => s.trim()).filter(Boolean).join("\n");
    logger(`> git ${args.join(" ")}${detail ? `\n${detail}` : ""}`, failed && !opts.allowFail);
  }
  if (failed && !opts.allowFail) throw new GitError(args, out);
  return out;
}

/** Hash of the empty tree: the "parent" of a root commit. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export type Operation = "merge" | "rebase" | "cherry-pick" | "revert";

/**
 * The files Git itself uses to tell an operation is in progress (as `git status`
 * does). A rebase is the `rebase-merge` / `rebase-apply` folder, not REBASE_HEAD,
 * which can be left behind after a rebase finished elsewhere. `rebase-apply`
 * with `applying` inside is `git am`, not a rebase.
 */
const OPERATION_PATHS = [
  "rebase-merge",
  "rebase-apply",
  "rebase-apply/applying",
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
];

export function operationFrom(exists: boolean[]): Operation | null {
  const [rebaseMerge, rebaseApply, amApplying, merge, cherryPick, revert] = exists;
  if (rebaseMerge || (rebaseApply && !amApplying)) return "rebase";
  if (merge) return "merge";
  if (cherryPick) return "cherry-pick";
  if (revert) return "revert";
  return null;
}

export interface FileChange {
  path: string;
  /** Source path of a staged rename or copy. */
  origPath: string | null;
  /** Index status letter (M, A, D, R, C, T), null when unchanged. */
  staged: string | null;
  /** Work-tree status letter; "U" means untracked. */
  unstaged: string | null;
  /** Unmerged XY code (UU, AA, DU…), null when not conflicted. */
  conflict: string | null;
}

export interface RepoStatus {
  branch: string | null;
  /** null on an unborn branch (no commits yet). */
  oid: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  operation: Operation | null;
  files: FileChange[];
}

export interface Ref {
  kind: "local" | "remote" | "tag";
  name: string;
  sha: string;
  upstream: string;
  current: boolean;
}

export interface Commit {
  sha: string;
  shortSha: string;
  parents: string[];
  author: string;
  date: Date;
  refs: string;
  subject: string;
}

export interface Stash {
  ref: string;
  message: string;
}

/** One index line: a file version (mode + object id), or sha null to remove the path. */
export interface IndexEntry {
  path: string;
  sha: string | null;
  mode?: string;
}

export interface CommitEntry {
  path: string;
  content?: string;
  deleted?: boolean;
}

export interface Remote {
  name: string;
  fetchUrl: string;
  /** Usually the same as fetchUrl. */
  pushUrl: string;
}

/** Where an HTTPS remote signs in: what Git's credential helpers key a login by. */
export interface CredentialTarget {
  protocol: string;
  /** With the port, when there is one. */
  host: string;
  /** The account written in the URL itself (https://name@host/…), which wins over any setting; "" when none. */
  urlUser: string;
}

/** The sign-in target of an http(s) remote URL; null for SSH and local remotes (SSH keys, or no sign-in). */
export function credentialTarget(url: string): CredentialTarget | null {
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    const u = new URL(url);
    return { protocol: u.protocol.slice(0, -1), host: u.host, urlUser: decodeURIComponent(u.username) };
  } catch {
    return null;
  }
}

/** The repository setting naming the account to sign in with on that server. */
const accountKey = (t: CredentialTarget) => `credential.${t.protocol}://${t.host}.username`;

export interface ChangedFile {
  status: string;
  path: string;
  origPath: string | null;
}

/** Splits on `sep` at most `n - 1` times; the last part keeps the remainder. */
function splitN(s: string, sep: string, n: number): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let k = 0; k < n - 1; k++) {
    const j = s.indexOf(sep, start);
    if (j < 0) break;
    parts.push(s.slice(start, j));
    start = j + 1;
  }
  parts.push(s.slice(start));
  return parts;
}

const letter = (c: string) => (c === "." ? null : c);

export function parseStatus(out: string): RepoStatus {
  const status: RepoStatus = {
    branch: null,
    oid: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    operation: null,
    files: [],
  };
  const tokens = out.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    if (t.startsWith("# ")) {
      const [, key, value] = splitN(t, " ", 3);
      if (key === "branch.oid") status.oid = value === "(initial)" ? null : value;
      else if (key === "branch.head") status.branch = value === "(detached)" ? null : value;
      else if (key === "branch.upstream") status.upstream = value;
      else if (key === "branch.ab") {
        const m = /\+(\d+) -(\d+)/.exec(value);
        if (m) [status.ahead, status.behind] = [Number(m[1]), Number(m[2])];
      }
      continue;
    }
    switch (t[0]) {
      case "1": {
        const p = splitN(t, " ", 9);
        status.files.push({ path: p[8], origPath: null, staged: letter(p[1][0]), unstaged: letter(p[1][1]), conflict: null });
        break;
      }
      case "2": {
        // Renames/copies carry the original path in the next NUL-separated token.
        const p = splitN(t, " ", 10);
        const origPath = tokens[++i];
        status.files.push({ path: p[9], origPath, staged: letter(p[1][0]), unstaged: letter(p[1][1]), conflict: null });
        break;
      }
      case "u": {
        const p = splitN(t, " ", 11);
        status.files.push({ path: p[10], origPath: null, staged: null, unstaged: null, conflict: p[1] });
        break;
      }
      case "?":
        status.files.push({ path: t.slice(2), origPath: null, staged: null, unstaged: "U", conflict: null });
        break;
    }
  }
  return status;
}

export function parseNameStatus(out: string): ChangedFile[] {
  const tokens = out.split("\0");
  const files: ChangedFile[] = [];
  for (let i = 0; i < tokens.length && tokens[i]; ) {
    const code = tokens[i];
    if (code[0] === "R" || code[0] === "C") {
      files.push({ status: code[0], origPath: tokens[i + 1], path: tokens[i + 2] });
      i += 3;
    } else {
      files.push({ status: code[0], origPath: null, path: tokens[i + 1] });
      i += 2;
    }
  }
  return files;
}

export class Repo {
  /** Extra `-c key=value` settings for every command (the active Git user's identity). */
  config: string[] = [];

  private constructor(readonly root: string) {}

  static async open(path: string): Promise<Repo> {
    const args = ["rev-parse", "--show-toplevel"];
    const out = await runGit(path, args, { quiet: true, allowFail: true });
    if (out.code !== 0) {
      if (/not a git repository/i.test(out.stderr)) throw new NotARepoError(path);
      throw new GitError(args, out);
    }
    return new Repo(out.stdout.trim());
  }

  get name(): string {
    return this.root.split("/").pop() || this.root;
  }

  private git(args: string[], opts?: RunOptions) {
    return runGit(this.root, [...this.config, ...args], opts);
  }

  /** Effective config value in this repo (including `config` overrides), or "" if unset. */
  async configValue(key: string): Promise<string> {
    return (await this.read(["config", "--get", key], true)).trim();
  }

  private async read(args: string[], allowFail = false): Promise<string> {
    const out = await this.git(args, { quiet: true, allowFail });
    return out.code === 0 ? out.stdout : "";
  }

  // ---- status -----------------------------------------------------------

  async status(): Promise<RepoStatus> {
    const statusOut = this.read(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]);
    // Where those state files live (--git-path also handles linked worktrees).
    const where = this.read(["rev-parse", ...OPERATION_PATHS.flatMap((p) => ["--git-path", p])], true);
    const status = parseStatus(await statusOut);
    const paths = (await where).split("\n").map((p) => p.trim()).filter(Boolean);
    const exists =
      paths.length === OPERATION_PATHS.length
        ? await invoke<boolean[]>("paths_exist", { base: this.root, paths })
        : [];
    status.operation = operationFrom(exists);
    return status;
  }

  // ---- file contents ----------------------------------------------------

  /** Blob content in repository form (`<rev>:<path>`, `:<path>` = index), null if absent. */
  async show(spec: string): Promise<string | null> {
    const out = await this.git(["cat-file", "blob", spec], { quiet: true, allowFail: true });
    return out.code === 0 ? out.stdout : null;
  }

  /** Blob content converted to work-tree form (line endings, filters), so it compares cleanly with the file on disk. */
  async showAsWorktree(spec: string): Promise<string | null> {
    const out = await this.git(["cat-file", "--filters", spec], { quiet: true, allowFail: true });
    return out.code === 0 ? out.stdout : null;
  }

  readWorktree(path: string): Promise<string | null> {
    return invoke<string | null>("read_file", { repo: this.root, path });
  }

  writeWorktree(path: string, content: string): Promise<void> {
    return invoke("write_file", { repo: this.root, path, content });
  }

  /** Replaces a file's staged content without touching the work tree (used for line-level staging). */
  async setIndexContent(path: string, content: string): Promise<void> {
    await this.setIndexEntries([await this.blobFor(path, content)]);
  }

  /**
   * Stores a file version in Git's object database (nothing visible changes) and
   * returns what the index needs. `content` undefined = take the work-tree file.
   * --path applies the repo's filters (line endings), like `git add` would.
   */
  async blobFor(path: string, content?: string): Promise<IndexEntry> {
    const mode = (await this.read(["ls-files", "-s", "--", path])).split(" ")[0] || "100644";
    const hashed =
      content === undefined
        ? await this.git(["hash-object", "-w", "--", path], { quiet: true })
        : await this.git(["hash-object", "-w", "--stdin", `--path=${path}`], { quiet: true, stdin: content });
    return { path, mode, sha: hashed.stdout.trim() };
  }

  private zeroId: string | null = null;

  /**
   * Writes several index entries with ONE command (`update-index --index-info`),
   * so staging a whole group is one approval, not one per file. sha null = remove.
   */
  async setIndexEntries(entries: IndexEntry[], opts: { indexFile?: string; quiet?: boolean } = {}) {
    if (!entries.length) return;
    if (!this.zeroId) {
      const format = (await this.read(["rev-parse", "--show-object-format"], true)).trim();
      this.zeroId = "0".repeat(format === "sha256" ? 64 : 40);
    }
    const lines = entries.map((e) => (e.sha ? `${e.mode ?? "100644"} ${e.sha}\t${e.path}` : `0 ${this.zeroId}\t${e.path}`));
    await this.git(["update-index", "--index-info"], { stdin: `${lines.join("\n")}\n`, ...opts });
  }

  // ---- staging ----------------------------------------------------------

  async stage(paths: string[]) {
    if (paths.length) await this.git(["add", "-A", "--", ...paths]);
  }

  async unstage(paths: string[], unborn: boolean) {
    if (!paths.length) return;
    // Without a first commit there is no HEAD to restore from.
    await this.git(unborn ? ["rm", "--cached", "-r", "-q", "--", ...paths] : ["restore", "--staged", "--", ...paths]);
  }

  async discard(tracked: string[], untracked: string[]) {
    if (tracked.length) await this.git(["restore", "--worktree", "--", ...tracked]);
    if (untracked.length) await this.git(["clean", "-f", "-q", "--", ...untracked]);
  }

  async acceptConflict(path: string, side: "ours" | "theirs") {
    await this.git(["checkout", `--${side}`, "--", path]);
    await this.stage([path]);
  }

  // ---- commits ----------------------------------------------------------

  async commit(message: string, amend: boolean) {
    await this.git(["commit", "-F", "-", ...(amend ? ["--amend"] : [])], { stdin: message });
  }

  /** Full patch with 3 lines of context: staged (HEAD → index) or unstaged (index → work tree). */
  diffPatch(staged: boolean, paths: string[] = []): Promise<string> {
    const args = ["diff", "-U3", "--no-color", "--no-ext-diff", ...(staged ? ["--cached"] : [])];
    return this.read(paths.length ? [...args, "--", ...paths] : args, true);
  }

  /** An untracked file as a "new file" diff (against nothing). */
  async untrackedPatch(path: string): Promise<string> {
    // --no-index exits with 1 when the files differ, which is always here.
    const out = await this.git(["diff", "--no-index", "-U3", "--no-color", "--no-ext-diff", "--", "/dev/null", path], {
      quiet: true,
      allowFail: true,
    });
    return out.stdout;
  }

  /** Diff of one file between two revisions (history view). */
  revPatch(left: string, right: string, path: string): Promise<string> {
    return this.read(["diff", "-U3", "--no-color", "--no-ext-diff", left, right, "--", path], true);
  }

  /** Diff of one file between a branch/commit and the work tree ("compare with branch"). */
  refWorktreePatch(ref: string, path: string): Promise<string> {
    return this.read(["diff", "-U3", "--no-color", "--no-ext-diff", ref, "--", path], true);
  }

  /** Whether `ref` names a commit (branch, tag, SHA…). */
  async isCommit(ref: string): Promise<boolean> {
    const out = await this.git(["rev-parse", "-q", "--verify", `${ref}^{commit}`], { quiet: true, allowFail: true });
    return out.code === 0;
  }

  /** A commit: header (author, date, message) and its full patch. */
  async commitPatch(sha: string): Promise<{ header: string; patch: string }> {
    const header = await this.read(["log", "-1", "--format=commit %H%nAuthor: %an <%ae>%nDate:   %ad%n%n%B", sha], true);
    const patch = await this.read(["show", "--format=", "-U3", "--no-color", "--no-ext-diff", sha], true);
    return { header: header.trim(), patch };
  }

  /** Unstaged changes (index → work tree) as zero-context hunks, for block-level groups. */
  diffU0(): Promise<string> {
    return this.read(["diff", "-U0", "--no-color", "--no-ext-diff", "--no-renames"]);
  }

  /**
   * Commits exactly `entries` on top of HEAD, built in a temporary index outside
   * the repository, so whatever else is staged stays staged. Hooks run as usual.
   * Afterwards the real index takes the committed version of those files.
   *   content: the file's new content; deleted: remove it; neither: take the work-tree file.
   */
  async commitEntries(message: string, entries: CommitEntry[], unborn: boolean) {
    const tmp = await invoke<string>("temp_index_path");
    const temp = { quiet: true, indexFile: tmp };
    try {
      await this.git(unborn ? ["read-tree", "--empty"] : ["read-tree", "HEAD"], temp);
      const updates: IndexEntry[] = [];
      for (const e of entries) {
        updates.push(e.deleted ? { path: e.path, sha: null } : await this.blobFor(e.path, e.content));
      }
      await this.setIndexEntries(updates, temp);
      await this.git(["commit", "-F", "-"], { stdin: message, indexFile: tmp });
      // The real index now agrees with the new commit for these files: one command
      // (not quiet: it changes the repository's index, so it is shown and approved).
      await this.setIndexEntries(updates);
    } finally {
      await invoke("remove_temp_index", { path: tmp }).catch(() => {});
    }
  }

  /** Subjects of the latest commits (newest first), e.g. to match the message style. */
  async recentSubjects(limit = 12): Promise<string[]> {
    return (await this.read(["log", "--format=%s", "-n", String(limit)], true)).split("\n").filter(Boolean);
  }

  /** Commits on HEAD that are not on `base`, oldest first, as "abc1234 Subject". */
  async commitsSince(base: string): Promise<string[]> {
    const out = await this.read(["log", "--reverse", "--format=%h %s", `${base}..HEAD`], true);
    return out.split("\n").filter(Boolean);
  }

  /** What HEAD changes since it left `base` (base...HEAD: from their merge base). */
  branchPatch(base: string): Promise<string> {
    return this.read(["diff", "-U3", "--no-color", "--no-ext-diff", `${base}...HEAD`], true);
  }

  /** The remote's default branch ("origin/main"), if known. */
  async defaultRemoteBranch(): Promise<string | null> {
    const out = await this.read(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], true);
    return out.trim() || null;
  }

  lastCommitMessage(): Promise<string> {
    return this.read(["log", "-1", "--format=%B"], true).then((s) => s.trim());
  }

  async continueOperation(op: Operation) {
    await this.git(op === "merge" ? ["commit", "--no-edit"] : [op, "--continue"]);
  }

  async abortOperation(op: Operation) {
    await this.git([op, "--abort"]);
  }

  async skipRebaseStep() {
    await this.git(["rebase", "--skip"]);
  }

  async undoLastCommit() {
    await this.git(["reset", "--soft", "HEAD~1"]);
  }

  // ---- branches & tags --------------------------------------------------

  async refs(): Promise<Ref[]> {
    const out = await this.read([
      "for-each-ref",
      "--format=%(refname)%00%(refname:short)%00%(objectname:short)%00%(upstream:short)%00%(HEAD)",
      "refs/heads",
      "refs/remotes",
      "refs/tags",
    ]);
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [full, name, sha, upstream, head] = line.split("\0");
        const kind: Ref["kind"] = full.startsWith("refs/heads/") ? "local" : full.startsWith("refs/remotes/") ? "remote" : "tag";
        return { kind, name, sha, upstream, current: head === "*", full };
      })
      .filter((r) => !(r.kind === "remote" && r.full.endsWith("/HEAD")))
      .map(({ full: _full, ...ref }) => ref);
  }

  async remotes(): Promise<string[]> {
    return (await this.read(["remote"])).split("\n").filter(Boolean);
  }

  /** Remotes with their fetch and push URLs (`git remote -v`). */
  async remoteList(): Promise<Remote[]> {
    const map = new Map<string, Remote>();
    for (const line of (await this.read(["remote", "-v"])).split("\n")) {
      const m = /^(\S+)\t(.+?) \((fetch|push)\)$/.exec(line.trim());
      if (!m) continue;
      const r = map.get(m[1]) ?? { name: m[1], fetchUrl: "", pushUrl: "" };
      if (m[3] === "fetch") r.fetchUrl = m[2];
      else r.pushUrl = m[2];
      map.set(m[1], r);
    }
    return [...map.values()];
  }

  async addRemote(name: string, url: string) {
    await this.git(["remote", "add", name, url]);
  }

  async setRemoteUrl(name: string, url: string) {
    await this.git(["remote", "set-url", name, url]);
  }

  async renameRemote(oldName: string, newName: string) {
    await this.git(["remote", "rename", oldName, newName]);
  }

  async removeRemote(name: string) {
    await this.git(["remote", "remove", name]);
  }

  async fetchRemote(name: string) {
    await this.git(["fetch", "--prune", "--progress", name]);
  }

  async checkout(ref: string) {
    await this.git(["checkout", ref]);
  }

  async checkoutDetached(ref: string) {
    await this.git(["checkout", "--detach", ref]);
  }

  /** Checks out a remote branch as a new local tracking branch. */
  async checkoutTracking(remoteRef: string) {
    await this.git(["checkout", "--track", remoteRef]);
  }

  /**
   * Runs a checkout with the auto-stash Git only offers for rebase / merge:
   * uncommitted changes (untracked files too) go into a stash, `checkout` runs,
   * the stash is popped. A failed checkout gets them back at once. When the pop
   * conflicts, Git keeps the stash; `conflicted` says so.
   */
  async withAutostash(label: string, checkout: () => Promise<void>): Promise<{ conflicted: boolean }> {
    const dirty = (await this.read(["status", "--porcelain", "-uall"])).trim() !== "";
    if (!dirty) {
      await checkout();
      return { conflicted: false };
    }
    const top = () => this.read(["rev-parse", "-q", "--verify", "refs/stash"], true).then((s) => s.trim());
    const before = await top();
    await this.git(["stash", "push", "-u", "-m", `hunkpad autostash: ${label}`]);
    const ours = await top();
    if (!ours || ours === before) {
      await checkout(); // nothing was stashed after all
      return { conflicted: false };
    }
    const pop = async () => {
      if ((await this.read(["rev-parse", "-q", "--verify", "stash@{0}"], true)).trim() !== ours)
        throw new Error("the auto-stash is no longer the newest stash: apply it from the Stashes tab");
      await this.git(["stash", "pop", "stash@{0}"]);
    };
    try {
      await checkout();
    } catch (e) {
      await pop().catch(() => {}); // back as before; if even that fails the stash stays listed
      throw e;
    }
    try {
      await pop();
      return { conflicted: false };
    } catch {
      return { conflicted: true };
    }
  }

  async createBranch(name: string, startPoint?: string) {
    await this.git(["checkout", "-b", name, ...(startPoint ? [startPoint] : [])]);
  }

  async renameBranch(oldName: string, newName: string) {
    await this.git(["branch", "-m", oldName, newName]);
  }

  async deleteBranch(name: string, force: boolean) {
    await this.git(["branch", force ? "-D" : "-d", name]);
  }

  async deleteRemoteBranch(remoteRef: string) {
    const slash = remoteRef.indexOf("/");
    await this.git(["push", remoteRef.slice(0, slash), "--delete", remoteRef.slice(slash + 1)]);
  }

  async merge(ref: string) {
    await this.git(["merge", "--no-edit", ref]);
  }

  /** `autostash`: Git puts uncommitted changes aside and restores them afterwards (also on abort). */
  async rebase(ref: string, opts: { autostash?: boolean } = {}) {
    await this.git(["rebase", ...(opts.autostash ? ["--autostash"] : []), ref]);
  }

  /** Updates one remote branch, e.g. `origin/dev` → `git fetch origin dev`. */
  async fetchRemoteBranch(remoteRef: string) {
    const slash = remoteRef.indexOf("/");
    await this.git(["fetch", "--progress", remoteRef.slice(0, slash), remoteRef.slice(slash + 1)]);
  }

  /** How a rebase onto `onto` would go: commits replayed, and how many of them are already pushed. */
  async rebasePreview(onto: string): Promise<{ replay: number; pushed: number }> {
    const count = async (range: string) => Number((await this.read(["rev-list", "--count", range], true)).trim()) || 0;
    const replay = await count(`${onto}..HEAD`);
    const hasUpstream = (await this.git(["rev-parse", "-q", "--verify", "@{u}"], { quiet: true, allowFail: true })).code === 0;
    // Replayed commits that the upstream already has = replayed − not yet pushed.
    const pushed = hasUpstream ? Math.max(0, replay - (await count("@{u}..HEAD"))) : 0;
    return { replay, pushed };
  }

  async createTag(name: string, message: string | null, ref?: string) {
    const target = ref ? [ref] : [];
    await this.git(message ? ["tag", "-a", name, "-m", message, ...target] : ["tag", name, ...target]);
  }

  async deleteTag(name: string) {
    await this.git(["tag", "-d", name]);
  }

  async pushTag(name: string) {
    const [remote] = await this.remotes();
    if (!remote) throw new Error("No remote configured");
    await this.git(["push", remote, `refs/tags/${name}`]);
  }

  // ---- remotes ----------------------------------------------------------

  async fetch() {
    await this.git(["fetch", "--all", "--prune", "--progress"]);
  }

  /** `autostash`: Git puts uncommitted changes aside and restores them after the pull. */
  async pull(rebase = false, opts: { autostash?: boolean } = {}) {
    await this.git(["pull", "--progress", rebase ? "--rebase" : "--no-edit", ...(opts.autostash ? ["--autostash"] : [])]);
  }

  async push(hasUpstream: boolean, force = false) {
    if (hasUpstream) {
      await this.git(["push", "--progress", "--follow-tags", ...(force ? ["--force-with-lease"] : [])]);
      return;
    }
    // First push of a branch: publish it and set the upstream.
    const [remote] = await this.remotes();
    if (!remote) throw new Error("No remote configured");
    await this.git(["push", "--progress", "-u", remote, "HEAD"]);
  }

  // ---- sign-in (HTTPS remotes) -------------------------------------------
  //
  // The login itself is kept by Git's credential helper (macOS Keychain, Git
  // Credential Manager…), never by Hunkpad. The repository only records which
  // account to use for that server, in .git/config, so other repositories keep
  // their own (or the default) login.

  /** Whether Git has a credential helper, i.e. somewhere to keep a login. */
  async hasCredentialHelper(): Promise<boolean> {
    return (await this.read(["config", "--get-all", "credential.helper"], true)).trim() !== "";
  }

  /** The account Git signs in with for `url` ("" = the server's default login), and whether this repository chose it. */
  async signInAccount(url: string): Promise<{ account: string; local: boolean }> {
    const t = credentialTarget(url);
    if (!t) return { account: "", local: false };
    if (t.urlUser) return { account: t.urlUser, local: true };
    const local = (await this.read(["config", "--local", "--get", accountKey(t)], true)).trim();
    if (local) return { account: local, local: true };
    return { account: (await this.read(["config", "--get-urlmatch", "credential.username", url], true)).trim(), local: false };
  }

  /**
   * Signs this repository in to `remote` (at `url`) as `account`: the token goes
   * to the credential helper through stdin (never on the command line, in the
   * output log or in the "Ask before Git commands" prompt), the account into
   * .git/config, then reading the remote checks both. On failure both are undone.
   */
  async signIn(remote: string, url: string, account: string, token: string) {
    const t = credentialTarget(url);
    if (!t) throw new Error(`${remote} is not an HTTPS remote`);
    if (/[\0\n\r]/.test(account + token)) throw new Error("The account and token cannot contain line breaks");
    const key = accountKey(t);
    const previous = (await this.read(["config", "--local", "--get", key], true)).trim();
    const credential = `protocol=${t.protocol}\nhost=${t.host}\nusername=${account}\npassword=${token}\n\n`;
    // An account in the URL already wins; otherwise this repository names it.
    if (!t.urlUser && previous !== account) await this.git(["config", "--local", key, account]);
    await this.git(["credential", "approve"], { stdin: credential, quiet: true });
    const check = await this.git(["ls-remote", "--heads", remote], { quiet: true, allowFail: true });
    if (check.code === 0) return;

    await this.git(["credential", "reject"], { stdin: credential, quiet: true, allowFail: true });
    if (!t.urlUser && previous !== account)
      await this.git(previous ? ["config", "--local", key, previous] : ["config", "--local", "--unset", key], {
        quiet: true,
        allowFail: true,
      });
    const why = (check.stderr.trim() || check.stdout.trim()).split("\n").pop() ?? "";
    throw new Error(
      /not found/i.test(why)
        ? `${account} cannot see this repository on ${t.host}: check the account, and that the token has access to the repository (${why})`
        : /auth|denied|401|403|password/i.test(why)
          ? `${t.host} refused the token for ${account}: check that it is valid and not expired (${why})`
          : `Could not reach ${remote} as ${account}: ${why || `git ls-remote exited with code ${check.code}`}`,
    );
  }

  /** Back to the server's default login: removes this repository's account setting (the saved login stays). */
  async useDefaultAccount(url: string) {
    const t = credentialTarget(url);
    if (t) await this.git(["config", "--local", "--unset", accountKey(t)]);
  }

  // ---- search (search.ts) -----------------------------------------------

  /** Tracked and untracked (not ignored) files that exist on disk. */
  async listFiles(): Promise<string[]> {
    const [all, deleted] = await Promise.all([
      this.read(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]),
      this.read(["ls-files", "-z", "--deleted"]),
    ]);
    const gone = new Set(deleted.split("\0"));
    return [...new Set(all.split("\0"))].filter((p) => p && !gone.has(p));
  }

  /** `git grep` output for `grepArgs`; empty when nothing matched (exit code 1). */
  async grep(args: string[]): Promise<string> {
    const out = await this.git(args, { quiet: true, allowFail: true });
    if (out.code > 1) throw new GitError(args, out);
    return out.stdout;
  }

  // ---- stashes ----------------------------------------------------------

  async stashes(): Promise<Stash[]> {
    const out = await this.read(["stash", "list", "--format=%gd%x00%s"], true);
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [ref, message] = line.split("\0");
        return { ref, message };
      });
  }

  async stash(message: string | null, includeUntracked: boolean) {
    await this.git(["stash", "push", ...(includeUntracked ? ["-u"] : []), ...(message ? ["-m", message] : [])]);
  }

  async stashApply(ref: string, pop: boolean) {
    await this.git(["stash", pop ? "pop" : "apply", ref]);
  }

  async stashDrop(ref: string) {
    await this.git(["stash", "drop", ref]);
  }

  // ---- history ----------------------------------------------------------

  async log(skip: number, limit: number): Promise<Commit[]> {
    const out = await this.read(
      ["log", "--format=%H%x00%h%x00%P%x00%an%x00%at%x00%D%x00%s", `--skip=${skip}`, "-n", String(limit)],
      true, // fails on an unborn branch
    );
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, shortSha, parents, author, at, refs, subject] = line.split("\0");
        return {
          sha,
          shortSha,
          parents: parents ? parents.split(" ") : [],
          author,
          date: new Date(Number(at) * 1000),
          refs,
          subject,
        };
      });
  }

  async commitMessage(rev: string): Promise<string> {
    return (await this.read(["log", "-1", "--format=%B", rev], true)).trim();
  }

  async changedFiles(left: string, right: string): Promise<ChangedFile[]> {
    return parseNameStatus(await this.read(["diff", "--name-status", "-z", "-M", left, right]));
  }

  async cherryPick(sha: string) {
    await this.git(["cherry-pick", sha]);
  }

  async revert(sha: string) {
    await this.git(["revert", "--no-edit", sha]);
  }

  async reset(sha: string, mode: "soft" | "mixed" | "hard") {
    await this.git(["reset", `--${mode}`, sha]);
  }
}

/** Clones `url` into `parentDir` and returns the new repository path. */
export async function cloneRepo(parentDir: string, url: string): Promise<string> {
  const name = url.replace(/[\\/]+$/, "").split(/[\\/:]/).pop()!.replace(/\.git$/, "");
  await runGit(parentDir, ["clone", "--progress", url, name]);
  return `${parentDir.replace(/[\\/]+$/, "")}/${name}`;
}
