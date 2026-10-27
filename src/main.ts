import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ask, message, open } from "@tauri-apps/plugin-dialog";
import {
  ChangedFile,
  Commit,
  CommitEntry,
  IndexEntry,
  EMPTY_TREE,
  FileChange,
  CancelledError,
  GitError,
  GitNotFoundError,
  PendingCommand,
  NotARepoError,
  Ref,
  Remote,
  Repo,
  RepoStatus,
  Stash,
  Worktree,
  cloneRepo,
  credentialTarget,
  runGit,
  setApprover,
  setGitMissingHandler,
  setRunObserver,
  setLogger,
} from "./git";
import { McpHost, Outcome, ToolError, blockId, handleMcp, installArgs, mcpUrl, newToken, parseBlockId, removeArgs } from "./mcp";
import { isMarkdown, isWebLink, markdownToHtml, resolveRepoPath, slug } from "./markdown";
import { TextMatch, TextSearchOptions, grepArgs, matchRange, parseGrep, rankFiles } from "./search";
import { LineChange, applyLineChanges, applyLineChangesWithRanges } from "./lineChanges";
import { PatchFile, parsePatch, untrackedPatch } from "./overview";
import { ReviewComment, loadComments, locate, newCommentId, saveComments } from "./comments";
import { ExportComment, ExportFile, blocksPatch, fenceFor, splitPatch, statusWord, toMarkdown } from "./export";
import {
  COMMIT_SCHEMA,
  COMMIT_SYSTEM,
  CONFLICT_SCHEMA,
  CONFLICT_SYSTEM,
  ClaudeCancelledError,
  ClaudeSignInError,
  EXPLAIN_SYSTEM,
  SETUP_SCHEMA,
  SETUP_SYSTEM,
  parseSetupSuggestion,
  setupPrompt,
  MAX_PROMPT_BYTES,
  ORGANIZE_SCHEMA,
  ORGANIZE_SYSTEM,
  PR_SYSTEM,
  PlanBlock,
  REVIEW_SCHEMA,
  REVIEW_SYSTEM,
  TEXT_SCHEMA,
  claudeSignIn,
  claudeVersion,
  commitPrompt,
  conflictPrompt,
  explainPrompt,
  findSecrets,
  hasConflictMarkers,
  isSecretPath,
  organizePrompt,
  parseCommitMessage,
  parseFindings,
  parseGroupPlan,
  parseResolution,
  parseText,
  prPrompt,
  reviewPrompt,
  runClaude,
} from "./claude";
import {
  DATA_DIR,
  flushAll,
  hasRepoData,
  loadRepoData,
  setRepoStoreCreatedHandler,
  setRepoStoreErrorHandler,
  type WorktreeSetup,
} from "./repoStore";
import { COMMON_LOCAL_FILES, inWorktree, parseCopyList, validCopyPath, worktreeEnv } from "./worktrees";
import {
  Hunk,
  HunkAssignment,
  assignmentOf,
  parseDiffU0,
  resolveGroups,
  sameHunk,
  toLineChange,
  wholeFileHunk,
} from "./hunks";
import {
  Project,
  REPO_COLORS,
  favouriteRefs,
  findProject,
  listProjects,
  ChangeGroup,
  GitUser,
  defaultGroupName,
  deleteUserTabs,
  loadGroups,
  loadHunkState,
  loadKeptLocal,
  loadScripts,
  loadWorktreeSetup,
  saveScripts,
  saveWorktreeSetup,
  UserScript,
  saveKeptLocal,
  saveHunkState,
  saveGroups,
  loadUserTabs,
  loadUsers,
  newUserId,
  npmScriptNames,
  removeProject,
  repoColor,
  saveUserTabs,
  saveUsers,
  setRepoColor,
  toggleFavourite,
  touchProject,
  updateProject,
} from "./projects";
import { isLinux, isMac, isWindows, keys, localizeShortcuts, pathKey, primaryKey, samePath } from "./platform";
import { setSettingsErrorHandler, settings } from "./settings";

// The diff view is read-only, so the generic editor worker is enough;
// syntax highlighting runs on the main thread.
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

// ---- DOM helpers ----------------------------------------------------------

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = String(v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k in el) (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

const iconBtn = (label: string, title: string, run: () => void) =>
  h("button", {
    class: "icon",
    title,
    onclick: (e: MouseEvent) => {
      e.stopPropagation();
      run();
    },
  }, label);

// ---- popup menu -----------------------------------------------------------

type MenuItem = { label: string; run: () => void; color?: string } | "-";
let openMenu: HTMLElement | null = null;

function swatch(color: string) {
  const el = h("span", { class: "swatch" });
  el.style.background = color;
  return el;
}

function closeMenu() {
  openMenu?.remove();
  openMenu = null;
}

function showMenu(x: number, y: number, items: MenuItem[]) {
  closeMenu();
  const menu = h(
    "div",
    { class: "menu" },
    ...items.map((it) =>
      it === "-"
        ? h("hr")
        : h("div", {
            class: "menu-item",
            onclick: () => {
              closeMenu();
              it.run();
            },
          }, it.color ? swatch(it.color) : null, it.label),
    ),
  );
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
  openMenu = menu;
}

function menuButton(items: () => MenuItem[]) {
  return h("button", {
    class: "icon",
    title: "More actions",
    onclick: (e: MouseEvent) => {
      e.stopPropagation();
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      showMenu(r.left, r.bottom, items());
    },
  }, "⋯");
}

function withContextMenu<T extends HTMLElement>(el: T, items: () => MenuItem[]): T {
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showMenu(e.clientX, e.clientY, items());
  });
  return el;
}

document.addEventListener("mousedown", (e) => {
  if (openMenu && !openMenu.contains(e.target as Node)) closeMenu();
});

// No WebView browser menu (Back, Print, More tools → Share…): it is meaningless
// in an app. Text fields keep it for cut/copy/paste; the diff editor and our
// own lists show their own menus.
document.addEventListener("contextmenu", (e) => {
  const el = e.target as HTMLElement;
  if (!el.closest("input, textarea")) e.preventDefault();
});

// ---- dialogs --------------------------------------------------------------

const inputDialog = $<HTMLDialogElement>("input-dialog");
const inputValue = $<HTMLInputElement>("input-value");
$("input-cancel").addEventListener("click", () => inputDialog.close("cancel"));

function promptInput(label: string, value = ""): Promise<string | null> {
  $("input-label").textContent = label;
  inputValue.value = value;
  inputDialog.returnValue = "";
  inputDialog.showModal();
  inputValue.select();
  return new Promise((resolve) =>
    inputDialog.addEventListener(
      "close",
      () => resolve(inputDialog.returnValue === "ok" && inputValue.value.trim() ? inputValue.value.trim() : null),
      { once: true },
    ),
  );
}

/** Like promptInput, but an empty answer is "" (OK with nothing typed); only Cancel gives null. */
function promptOptional(label: string, value = ""): Promise<string | null> {
  $("input-label").textContent = label;
  inputValue.value = value;
  inputDialog.returnValue = "";
  inputDialog.showModal();
  inputValue.select();
  return new Promise((resolve) =>
    inputDialog.addEventListener(
      "close",
      () => resolve(inputDialog.returnValue === "ok" ? inputValue.value.trim() : null),
      { once: true },
    ),
  );
}

const confirmAction = (message: string) => ask(message, { title: "Hunkpad", kind: "warning" });

// ---- status bar & output log ---------------------------------------------

const statusText = $("status-text");
const outputEl = $("output");

setLogger((text, isError) => {
  outputEl.append(h("div", { class: isError ? "err" : "" }, text));
  while (outputEl.childElementCount > 500) outputEl.firstElementChild!.remove();
  outputEl.scrollTop = outputEl.scrollHeight;
});

function setStatus(text: string, isError = false) {
  statusText.textContent = text;
  statusText.title = text;
  statusText.classList.toggle("err", isError);
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0];

function showError(e: unknown) {
  if (!(e instanceof GitError)) console.error(e);
  setStatus(errorText(e), true);
}

let busy = 0;

/** The action whose Git commands are being approved (see the approver below). */
let currentAction: { label: string; approveAll: boolean } | null = null;

/** Runs a Git action with status feedback, then refreshes everything. */
async function act(label: string, fn: () => Promise<unknown>): Promise<Outcome> {
  busy++;
  document.body.classList.add("busy");
  setStatus(`${label}…`);
  const previous = currentAction;
  currentAction = { label, approveAll: false };
  try {
    await fn();
    setStatus(`${label}: done`);
    finishSession("ok");
    return "done";
  } catch (e) {
    if (e instanceof CancelledError) {
      setStatus(`${label}: cancelled, nothing more was run`);
      finishSession("cancelled");
      return "cancelled";
    }
    showError(e);
    setStatus(`${label} failed: ${errorText(e)}`, true);
    finishSession("failed", e instanceof GitError ? signInHint(e) : errorText(e));
    return "failed";
  } finally {
    currentAction = previous;
    if (--busy === 0) document.body.classList.remove("busy");
    await refresh().catch(showError);
  }
}

/** For a fetch / pull / push the server turned away: where to choose the account. */
function signInHint(e: GitError): string {
  const sub = e.args.find((a) => ["fetch", "pull", "push", "ls-remote"].includes(a));
  // GitHub refuses a token without the workflow scope any push touching .github/workflows.
  if (sub && /without `?workflow`? scope/i.test(e.message))
    return "The access token lacks the workflow scope needed to push changes to .github/workflows: create one with the repo and workflow scopes, then use it with ⋯ → Sign in…";
  const refused = /repository not found|authentication failed|could not read (username|password)|permission .* denied|403/i;
  return sub && refused.test(e.message)
    ? "Wrong account, or no login saved? Choose the account this repository uses with ⋯ → Sign in…"
    : "";
}

// ---- asking before Git commands ---------------------------------------------
//
// Every command that changes something goes through runGit's approver: the user
// sees the exact command line and what it does, and can cancel the action.

let confirmGit = settings.getItem("confirmGit") !== "off";

function setConfirmGit(on: boolean) {
  confirmGit = on;
  settings.setItem("confirmGit", on ? "on" : "off");
  setStatus(on ? "Hunkpad will ask before each Git command" : "Git commands now run without asking");
}

// Pull with --autostash: uncommitted changes are put aside and restored afterwards.
let pullAutostash = settings.getItem("pullAutostash") !== "off";

function setPullAutostash(on: boolean) {
  pullAutostash = on;
  settings.setItem("pullAutostash", on ? "on" : "off");
  setStatus(on ? "Pull will auto-stash uncommitted changes" : "Pull will no longer auto-stash");
}

/** Shell-style display of a command line: arguments with spaces are quoted. */
const showArgs = (args: string[]) =>
  args.map((a) => (/[\s"'`$&|<>]/.test(a) || a === "" ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ");

/** What a Git command does, in plain words; `danger` = loses work or rewrites shared history. */
function explainGit(args: string[]): { text: string; danger: boolean } {
  // Skip global options ("-c key=value", "--no-literal-pathspecs"…) to find the subcommand.
  let i = 0;
  while (args[i] === "-c" || args[i]?.startsWith("--")) i += args[i] === "-c" ? 2 : 1;
  const sub = args[i] ?? "";
  const rest = args.slice(i + 1);
  const has = (...flags: string[]) => flags.some((f) => rest.includes(f));
  const say = (text: string, danger = false) => ({ text, danger });
  switch (sub) {
    case "add":
      return say("Stages the listed files: their current content goes into the index (the next commit).");
    case "restore":
      return has("--staged")
        ? say("Unstages the listed files: the index goes back to HEAD; your files on disk are not touched.")
        : say("Discards the changes in the listed files on disk: they go back to the staged/committed version. This cannot be undone.", true);
    case "rm":
      return has("--cached")
        ? say("Removes the listed files from the index only (unstages them); the files on disk stay.")
        : say("Deletes the listed files from disk and from the index.", true);
    case "clean":
      return say("Deletes the listed untracked files from disk. This cannot be undone.", true);
    case "commit":
      if (has("--amend")) return say("Replaces the last commit with a new one (new message and/or content). Rewrites history if it was already pushed.");
      if (has("--no-edit")) return say("Creates the merge commit with Git's prepared message.");
      return say("Creates a new commit from what is in the index.");
    case "update-index":
      if (has("--index-info")) {
        return say("Writes the new versions of the files listed below straight into the index, all in one go (staging change blocks, or committing a group). Mode 0 = remove from the index. Your files on disk are not touched.");
      }
      return has("--force-remove")
        ? say("Removes a file from the index (part of staging specific change blocks / committing a group).")
        : say("Writes a file's new version straight into the index (staging specific lines or change blocks).");
    case "hash-object":
      return say("Stores a file version in Git's object database (needed before it can be staged).");
    case "checkout":
      if (has("--ours", "--theirs")) return say(`Resolves the conflict by taking the ${has("--ours") ? "current (ours)" : "incoming (theirs)"} version of the whole file.`);
      if (has("-b")) return say("Creates a new branch and switches to it.");
      if (has("--detach")) return say("Switches to that commit without a branch (detached HEAD).");
      if (has("--track")) return say("Creates a local branch that tracks the remote branch, and switches to it.");
      return say("Switches the working tree to another branch or commit.");
    case "worktree":
      switch (rest[0]) {
        case "add":
          if (has("-b")) return say("Creates a new folder (a linked worktree) with a new branch checked out in it. This folder is not changed.");
          if (has("--detach")) return say("Creates a new folder (a linked worktree) with that commit checked out, without a branch. This folder is not changed.");
          return say("Creates a new folder (a linked worktree) with that branch checked out in it. This folder is not changed.");
        case "remove":
          return has("--force")
            ? say("Deletes the worktree's folder although it has uncommitted changes or untracked files: they are lost. Its branch and commits stay.", true)
            : say("Deletes the worktree's folder (it has no uncommitted changes). Its branch and commits stay.");
        case "move":
          return say("Moves the worktree's folder to the new path.");
        case "lock":
          return say("Locks the worktree so Git does not prune or remove it (e.g. while it is on a removable disk).");
        case "unlock":
          return say("Unlocks the worktree: it can be pruned and removed again.");
        case "prune":
          return say("Forgets the worktrees whose folder was deleted. Nothing on disk is touched.");
      }
      return say("Runs this Git command.");
    case "branch":
      if (has("-D")) return say("Deletes the branch even if it is not merged: its unmerged commits can be lost.", true);
      if (has("-d")) return say("Deletes the branch (only if it is merged).");
      if (has("-m")) return say("Renames the branch.");
      return say("Creates a branch.");
    case "merge":
      return has("--abort") ? say("Aborts the merge and goes back to the state before it.") : say("Merges that branch into the current branch.");
    case "rebase":
      if (has("--abort")) return say("Aborts the rebase and goes back to the state before it.");
      if (has("--continue")) return say("Continues the rebase after the conflicts were resolved.");
      if (has("--skip")) return say("Skips the current commit of the rebase (its changes are dropped).", true);
      return say(
        "Replays the current branch's commits on top of that branch (rewrites their history)." +
          (has("--autostash") ? " --autostash: uncommitted changes are put aside first and restored afterwards (also on abort)." : ""),
      );
    case "cherry-pick":
      return has("--abort") ? say("Aborts the cherry-pick.") : say("Applies that commit's changes on top of the current branch as a new commit.");
    case "revert":
      return has("--abort") ? say("Aborts the revert.") : say("Creates a new commit that undoes that commit's changes.");
    case "reset":
      if (has("--hard")) return say("Moves the branch to that commit and DISCARDS all uncommitted changes. This cannot be undone.", true);
      if (has("--soft")) return say("Moves the branch to that commit; the undone commits' changes stay staged.");
      return say("Moves the branch to that commit; the undone commits' changes stay in your files, unstaged.");
    case "stash":
      if (rest[0] === "drop") return say("Deletes the stash. Its changes are lost.", true);
      if (rest[0] === "pop") return say("Applies the stash to your files and deletes it if that succeeds.");
      if (rest[0] === "apply") return say("Applies the stash to your files and keeps it.");
      return say("Saves your uncommitted changes in a stash and cleans the working tree.");
    case "tag":
      return has("-d") ? say("Deletes the tag locally.") : say("Creates a tag.");
    case "fetch":
      return say(
        (() => {
          const [remote, branch] = rest.filter((x) => !x.startsWith("-"));
          const from = has("--all") ? "all remotes" : branch ? `branch “${branch}” from the remote “${remote}”` : `the remote “${remote ?? "default"}”`;
          return `Downloads new commits from ${from}; does not change your files or your branches.${has("--prune") ? " --prune removes remote branches that were deleted." : ""}`;
        })(),
      );
    case "pull":
      return say(
        (has("--rebase") ? "Fetches and rebases your local commits on top of the remote branch." : "Fetches and merges the remote branch into the current branch.") +
          (has("--autostash") ? " --autostash: uncommitted changes are put aside first and restored afterwards." : ""),
      );
    case "push":
      if (has("--delete")) return say("Deletes that branch on the remote.", true);
      if (has("--force-with-lease")) return say("Overwrites the remote branch with yours (only if nobody pushed since your last fetch). Remote commits you do not have are lost.", true);
      if (has("-u")) return say("Publishes the current branch to the remote and makes it the upstream.");
      return say("Uploads your new commits to the remote.");
    case "clone":
      return say("Downloads a copy of the repository into a new folder.");
    case "remote":
      if (rest[0] === "add") return say("Adds a remote: a named link to another copy of the repository (e.g. on GitHub), used by fetch, pull and push.");
      if (rest[0] === "set-url") return say("Changes the URL of that remote.");
      if (rest[0] === "rename") return say("Renames the remote (its remote branches are renamed too).");
      if (rest[0] === "remove") return say("Removes the remote from this repository, with its remote-tracking branches. Nothing is deleted on the server.", true);
      return say("Manages remotes.");
    case "read-tree":
      return say("Loads a tree into the (temporary) index.");
    case "config":
      if (rest.some((a) => /^credential\..*\.username$/.test(a)))
        return has("--unset")
          ? say("Stops choosing an account for that server in this repository: Git signs in with its default login again.")
          : say("Chooses the account Git signs in with on that server, for this repository only (.git/config).");
      return say("Changes a setting of this repository (.git/config).");
    default:
      return say("Runs this Git command.");
  }
}

// The dialog walks through three modes for one action ("session"):
//   prompting: shows the next command and waits for Run / Cancel;
//   running:   live output of the running command, with a timer;
//   finished:  the whole transcript and the outcome, until Close.

const gitDialog = $<HTMLDialogElement>("git-dialog");
const gitLog = $("git-log");
const gitState = $("git-state");
let approvalQueue: Promise<unknown> = Promise.resolve();

/** One action's dialog: its transcript lives in #git-log until the dialog is closed. */
let session: { label: string; hidden: boolean; ran: number } | null = null;
/** Stream id of the command whose live output is being shown. */
let liveId: number | null = null;
let runTimer: number | undefined;
/** The line a progress update (`\r`) overwrites, if the last output was progress. */
let progressLine: HTMLElement | null = null;
let answerPrompt: ((ok: boolean) => void) | null = null;

const seconds = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;

function setGitMode(mode: "prompting" | "running" | "finished") {
  for (const m of ["prompting", "running", "finished"]) gitDialog.classList.toggle(m, m === mode);
}

function openSession(label: string) {
  if (!session || session.label !== label) {
    session = { label, hidden: false, ran: 0 };
    gitLog.replaceChildren();
    gitLog.classList.add("hidden");
  }
  if (!gitDialog.open && !session.hidden) gitDialog.showModal();
}

function logLine(text: string, cls = ""): HTMLElement {
  gitLog.classList.remove("hidden");
  const el = h("span", { class: cls }, `${text}\n`);
  gitLog.append(el);
  while (gitLog.childElementCount > 2000) gitLog.firstElementChild!.remove();
  gitLog.scrollTop = gitLog.scrollHeight;
  return el;
}

/** Shows the outcome and waits for Close (or ends quietly if the dialog was hidden). */
function finishSession(outcome: "ok" | "failed" | "cancelled", detail = "") {
  if (!session) return;
  clearInterval(runTimer);
  liveId = null;
  if (detail) logLine(detail, "bad");
  const label = session.label;
  if (session.hidden) {
    session = null;
    return;
  }
  setGitMode("finished");
  gitDialog.classList.remove("danger");
  $("git-dialog-title").textContent =
    outcome === "ok" ? `✓ ${label}: done` : outcome === "cancelled" ? `${label}: cancelled` : `✗ ${label}: failed`;
  gitState.className = outcome === "ok" ? "small ok" : outcome === "failed" ? "small bad" : "small";
  gitState.textContent =
    outcome === "ok" ? "Finished." : outcome === "cancelled" ? "Cancelled: nothing more was run." : "Finished with an error (see above).";
  if (!gitDialog.open) gitDialog.showModal();
  $("git-close").focus();
}

/** Shows one command and waits for Run / Cancel. Prompts never overlap. */
function askToRun(cmd: PendingCommand): Promise<boolean> {
  const ask = async () => {
    const action = currentAction;
    if (!confirmGit || action?.approveAll) return true;
    openSession(action?.label ?? "Git");
    session!.hidden = false; // a question must be seen
    if (!gitDialog.open) gitDialog.showModal();

    const { text, danger } = explainGit(cmd.args);
    gitDialog.classList.toggle("danger", danger);
    setGitMode("prompting");
    $("git-dialog-title").textContent = danger ? "⚠ Run this Git command?" : "Run this Git command?";
    $("git-action").textContent = `${action ? `Action: ${action.label}` : "Git"}  ·  in ${cmd.cwd}`;
    $("git-cmd").textContent = `git ${showArgs(cmd.args)}`;
    $("git-info").textContent = text;
    const extra: string[] = [];
    if (cmd.stdin !== undefined && cmd.args.includes("--index-info")) {
      // "mode sha<TAB>path" lines: show the files, not the object ids.
      const files = cmd.stdin
        .split("\n")
        .filter(Boolean)
        .map((l) => (l.startsWith("0 ") ? `${l.split("\t")[1]} (removed)` : l.split("\t")[1]));
      const shown = files.slice(0, 15).map((p) => `• ${p}`);
      if (files.length > 15) shown.push(`…and ${files.length - 15} more`);
      extra.push(`${files.length} file(s):\n${shown.join("\n")}`);
    } else if (cmd.stdin !== undefined) {
      const preview = cmd.stdin.length > 300 ? `${cmd.stdin.slice(0, 300)}…` : cmd.stdin;
      extra.push(`Input passed to the command (e.g. the commit message):\n${preview.trim()}`);
    }
    if (cmd.indexFile) extra.push("Uses a temporary index in the system temp folder (your real index is not touched by this step).");
    $("git-extra").textContent = extra.join("\n\n");
    $("git-extra").style.whiteSpace = "pre-wrap";
    gitState.textContent = session!.ran ? `${session!.ran} command(s) already ran in this action (above).` : "";
    gitState.className = "small muted";
    const all = $<HTMLInputElement>("git-all");
    all.checked = false;
    $("git-run").focus();

    const ok = await new Promise<boolean>((resolve) => (answerPrompt = resolve));
    answerPrompt = null;
    if (ok) {
      if (all.checked && action) action.approveAll = true;
      return true;
    }
    // Cancelled: show what already ran, otherwise just close.
    if (session?.ran) finishSession("cancelled");
    else {
      session = null;
      gitDialog.close();
    }
    return false;
  };
  const result = approvalQueue.then(ask, ask);
  approvalQueue = result.catch(() => {});
  return result;
}

setApprover(askToRun);
setRunObserver({
  started(id, cmd) {
    if (!confirmGit) return;
    openSession(currentAction?.label ?? "Git");
    setGitMode("running");
    gitDialog.classList.remove("danger");
    liveId = id;
    progressLine = null;
    logLine(`$ git ${showArgs(cmd.args)}`, "cmd");
    const t0 = performance.now();
    $("git-dialog-title").textContent = "Running…";
    gitState.className = "small";
    const tick = () => (gitState.textContent = `Running… ${seconds(performance.now() - t0)}`);
    tick();
    clearInterval(runTimer);
    runTimer = window.setInterval(tick, 100);
  },
  finished(id, result, ms) {
    if (id !== liveId || !session) return;
    clearInterval(runTimer);
    liveId = null;
    progressLine = null;
    session.ran++;
    if (result && result.code === 0) logLine(`→ exit 0 (${seconds(ms)})`, "ok");
    else logLine(`→ ${result ? `exit ${result.code}` : "could not start"} (${seconds(ms)})`, "bad");
    gitState.textContent = `Waiting for the next step… (${session.ran} done)`;
    // A command outside any action ends its own session.
    if (!currentAction) finishSession(result?.code === 0 ? "ok" : "failed");
  },
});

// Live output of the running command (from run_git's stream).
listen<{ id: number; stream: string; text: string; progress: boolean }>("git-output", (e) => {
  const { id, text, progress } = e.payload;
  if (id !== liveId || (!text && !progress)) return;
  if (progressLine) {
    // Git rewrites its progress line in place: update it instead of adding lines.
    progressLine.textContent = `${text}\n`;
    if (!progress) progressLine = null;
  } else {
    const el = logLine(text);
    if (progress) progressLine = el;
  }
  gitLog.scrollTop = gitLog.scrollHeight;
});

$("git-run").addEventListener("click", () => answerPrompt?.(true));
$("git-cancel").addEventListener("click", () => answerPrompt?.(false));
$("git-hide").addEventListener("click", () => {
  if (session) session.hidden = true;
  gitDialog.close();
  setStatus("Still running in the background: see the status bar and Output");
});
// Esc: cancels a question, hides while running, closes when finished.
gitDialog.addEventListener("cancel", (e) => {
  if (gitDialog.classList.contains("prompting")) {
    e.preventDefault();
    answerPrompt?.(false);
  } else if (gitDialog.classList.contains("running")) {
    e.preventDefault();
    $("git-hide").click();
  }
});
gitDialog.addEventListener("close", () => {
  if (gitDialog.classList.contains("finished")) session = null;
});

// ---- diff editor ----------------------------------------------------------

// ---- themes (top bar): System follows the OS; Light, Dark and Retro are fixed ----

type Theme = "system" | "light" | "dark" | "retro";
const THEMES: Theme[] = ["system", "light", "dark", "retro"];
const dark = window.matchMedia("(prefers-color-scheme: dark)");
let theme: Theme = THEMES.find((t) => t === settings.getItem("theme")) ?? "system";

// The code editor's Retro look: the same PICO-8 palette as the app.
monaco.editor.defineTheme("hunkpad-retro", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "comment", foreground: "83769c", fontStyle: "italic" },
    { token: "keyword", foreground: "ff77a8" },
    { token: "string", foreground: "ffec27" },
    { token: "number", foreground: "ffa300" },
    { token: "type", foreground: "29adff" },
    { token: "delimiter", foreground: "c2c3c7" },
  ],
  colors: {
    "editor.background": "#1a1c2c",
    "editor.foreground": "#f4f4f4",
    "editorGutter.background": "#1a1c2c",
    "editorLineNumber.foreground": "#5f574f",
    "editorLineNumber.activeForeground": "#ffec27",
    "editorCursor.foreground": "#ffec27",
    "editor.lineHighlightBackground": "#262b44",
    "editor.selectionBackground": "#5d275d",
    "diffEditor.insertedTextBackground": "#00e43638",
    "diffEditor.removedTextBackground": "#ff004d38",
    "diffEditor.insertedLineBackground": "#00e4361c",
    "diffEditor.removedLineBackground": "#ff004d1c",
    "scrollbarSlider.background": "#3e4a6e99",
  },
});

const editorTheme = () =>
  theme === "retro" ? "hunkpad-retro" : theme === "dark" || (theme === "system" && dark.matches) ? "vs-dark" : "vs";

function applyTheme(next: Theme) {
  theme = next;
  if (next === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = next;
  monaco.editor.setTheme(editorTheme());
  const select = document.getElementById("theme-select") as HTMLSelectElement | null;
  if (select) select.value = next;
}
applyTheme(theme);
dark.addEventListener("change", () => theme === "system" && monaco.editor.setTheme(editorTheme()));
$<HTMLSelectElement>("theme-select").addEventListener("change", (e) => {
  const value = (e.target as HTMLSelectElement).value as Theme;
  settings.setItem("theme", value);
  applyTheme(value);
});

const originalModel = monaco.editor.createModel("", "plaintext");
const modifiedModel = monaco.editor.createModel("", "plaintext");
const diffEditor = monaco.editor.createDiffEditor($("diff"), {
  readOnly: true,
  originalEditable: false,
  automaticLayout: true,
  renderSideBySide: true,
  // Whitespace changes must be visible, or line staging would silently skip them.
  ignoreTrimWhitespace: false,
  hideUnchangedRegions: { enabled: true },
  // Room in the left margin for the comment icons (💬 / ＋).
  glyphMargin: true,
  theme: editorTheme(),
});
diffEditor.setModel({ original: originalModel, modified: modifiedModel });

type DiffTarget =
  | { kind: "worktree"; path: string; conflict: boolean }
  | { kind: "index"; path: string; origPath: string | null }
  | { kind: "tree"; left: string; right: string; path: string; origPath: string | null; label: string }
  /** Index ↔ index plus only the given group's change blocks (null = Ungrouped). */
  | { kind: "blocks"; path: string; group: string | null }
  /** A branch/commit's version ↔ the file on disk ("Compare with"). `fromKey`: the row it was opened from. */
  | { kind: "vsref"; path: string; ref: string; fromKey: string };

interface Sides {
  original: string;
  modified: string;
  binary: boolean;
  /** Not valid UTF-8: shown, but never written back. */
  lossy: boolean;
  /** Shown after the title, e.g. "not in origin/dev". */
  note?: string;
  /** For a "blocks" view: each shown block and the lines it occupies on the right. */
  blocks?: { hunk: Hunk; range: [number, number] }[];
}

let target: DiffTarget | null = null;
let sides: Sides | null = null;

function languageFor(path: string): string {
  const name = path.split("/").pop()!.toLowerCase();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
  const lang = monaco.languages
    .getLanguages()
    .find((l) => l.filenames?.some((f) => f.toLowerCase() === name) || (ext && l.extensions?.includes(ext)));
  return lang?.id ?? "plaintext";
}

function setValue(model: monaco.editor.ITextModel, text: string) {
  // Skipping identical content keeps the scroll position on auto-refresh.
  if (model.getValue() !== text) model.setValue(text);
}

async function loadSides(r: Repo, t: DiffTarget): Promise<Sides> {
  let original: string;
  let modified: string;
  if (t.kind === "worktree") {
    // Conflicts compare against "ours"; otherwise index vs disk, in work-tree form.
    original = (await r.showAsWorktree(t.conflict ? `:2:${t.path}` : `:${t.path}`)) ?? "";
    modified = (await r.readWorktree(t.path)) ?? "";
  } else if (t.kind === "index") {
    original = (await r.show(`HEAD:${t.origPath ?? t.path}`)) ?? "";
    modified = (await r.show(`:${t.path}`)) ?? "";
  } else if (t.kind === "blocks") {
    original = (await r.showAsWorktree(`:${t.path}`)) ?? "";
    const work = (await r.readWorktree(t.path)) ?? "";
    const mine = blocksOf(t.path, t.group);
    if (mine.some((b) => b.whole) || mine.length === allBlocksOf(t.path).length) {
      modified = work; // the whole file belongs to this group
    } else {
      const composed = applyLineChangesWithRanges(original, work, mine.map(toLineChange));
      return {
        ...finishSides(original, composed.text),
        blocks: mine.map((hunk, i) => ({ hunk, range: composed.ranges[i] })),
      };
    }
  } else if (t.kind === "vsref") {
    // Work-tree form (line endings) so it compares cleanly with the file on disk.
    const onBranch = await r.showAsWorktree(`${t.ref}:${t.path}`);
    const onDisk = await r.readWorktree(t.path);
    const note = onBranch === null ? `not in ${t.ref}` : onDisk === null ? "deleted here" : undefined;
    return { ...finishSides(onBranch ?? "", onDisk ?? ""), note };
  } else {
    original = (await r.show(`${t.left}:${t.origPath ?? t.path}`)) ?? "";
    modified = (await r.show(`${t.right}:${t.path}`)) ?? "";
  }
  return finishSides(original, modified);
}

function finishSides(original: string, modified: string): Sides {
  return {
    original,
    modified,
    binary: original.includes("\0") || modified.includes("\0"),
    lossy: original.includes("�") || modified.includes("�"),
  };
}

function diffLabel(t: DiffTarget): string {
  if (t.kind === "vsref") return `${t.path}  (${t.ref} ↔ Working tree)`;
  if (t.kind === "blocks") {
    const group = t.group ? (currentGroups().find((g) => g.id === t.group)?.name ?? "group") : "Ungrouped";
    return `${t.path}  (Index ↔ “${group}” changes)`;
  }
  const name = t.kind !== "worktree" && t.origPath ? `${t.origPath} → ${t.path}` : t.path;
  if (t.kind === "worktree") return `${name}  (${t.conflict ? "Current ↔ Merged" : "Index ↔ Working tree"})`;
  if (t.kind === "index") return `${name}  (HEAD ↔ Index)`;
  return `${name}  (${t.label})`;
}

/** `wholeFile`: show every line (e.g. to see a comment on an unchanged line). */
async function showDiff(t: DiffTarget, opts: { wholeFile?: boolean } = {}) {
  if (!repo) return;
  // While "Compare with" is on, a changed file opens against that branch instead.
  if (compareRef && ((t.kind === "worktree" && !t.conflict) || t.kind === "index" || t.kind === "blocks")) {
    t = { kind: "vsref", path: t.path, ref: compareRef, fromKey: targetKey(t) };
  }
  target = t;
  const s = await loadSides(repo, t);
  if (target !== t) return; // a newer selection won the race
  sides = s;
  diffEditor.updateOptions({ hideUnchangedRegions: { enabled: !opts.wholeFile } });
  const lang = languageFor(t.path);
  monaco.editor.setModelLanguage(originalModel, lang);
  monaco.editor.setModelLanguage(modifiedModel, lang);
  setValue(originalModel, s.binary ? "" : s.original);
  setValue(modifiedModel, s.binary ? "(binary file)" : s.modified);
  $("diff-title").textContent = s.note ? `${diffLabel(t)}  ·  ${s.note}` : diffLabel(t);
  $("placeholder").classList.add("hidden");
  $("overview").classList.add("hidden");
  $("overview-btn").classList.remove("hidden");
  $("copy-btn").textContent = "⧉ Copy for LLM";
  renderDiffActions();
  markSelected();
  renderCommentZones();
  renderMarkdownPreview();
}

/** Deselects the file: back to the overview of all changes (or the placeholder). */
function clearDiff() {
  target = null;
  sides = null;
  setValue(originalModel, "");
  setValue(modifiedModel, "");
  $("diff-title").textContent = "";
  $("diff-actions").replaceChildren();
  $("overview-btn").classList.add("hidden");
  $("copy-btn").textContent = "⧉ Copy all for LLM";
  $("placeholder").classList.remove("hidden");
  markSelected();
  renderOverview().catch(showError);
  renderCommentZones();
  renderMarkdownPreview();
}

// ---- Markdown preview (markdown.ts) -----------------------------------------
//
// A Markdown file opens rendered (its current version: the right side of the
// diff); "⇆ Diff" switches back to the diff, and the choice is remembered.

const mdPane = $("md-preview");
let mdPreviewOn = loadFlag("mdPreview", true);
/** What the pane shows now, so an auto-refresh with the same text keeps the scroll. */
let mdShown: { path: string; text: string } | null = null;
let mdBlobUrls: string[] = [];

const showsMarkdown = () => !!target && !!sides && !sides.binary && isMarkdown(target.path);

function renderMarkdownPreview() {
  if (!mdPreviewOn || !showsMarkdown() || !repo) {
    mdPane.classList.add("hidden");
    mdShown = null;
    return;
  }
  const path = target!.path;
  const text = sides!.modified;
  mdPane.classList.remove("hidden");
  if (mdShown?.path === path && mdShown.text === text) return;
  const samePath = mdShown?.path === path;
  const scroll = mdPane.scrollTop;
  mdShown = { path, text };
  for (const url of mdBlobUrls) URL.revokeObjectURL(url);
  mdBlobUrls = [];

  const body = h("article", { class: "markdown" });
  body.innerHTML = markdownToHtml(text);
  const used = new Map<string, number>();
  body.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6").forEach((el) => {
    const base = slug(el.textContent ?? "");
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    el.id = n ? `${base}-${n}` : base;
  });
  const root = repo.root;
  body.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src") ?? "";
    if (src.startsWith("data:")) return;
    if (/^([a-z]+:)?\/\//i.test(src)) {
      // Remote images are not loaded (privacy, and the app's CSP): a link instead.
      const link = h("a", { href: src, class: "md-remote-img", title: src }, `🖼 ${img.alt || "image"}`);
      img.replaceWith(link);
      return;
    }
    const file = resolveRepoPath(path, src.split(/[?#]/)[0]);
    img.removeAttribute("src");
    if (!file) return;
    invoke<ArrayBuffer>("read_image", { repo: root, path: file })
      .then((bytes) => {
        const type = file.toLowerCase().endsWith(".svg") ? "image/svg+xml" : "";
        const url = URL.createObjectURL(new Blob([bytes], type ? { type } : {}));
        mdBlobUrls.push(url);
        img.src = url;
      })
      .catch(() => (img.title = `${file}: not found`));
  });
  mdPane.replaceChildren(body);
  mdPane.scrollTop = samePath ? scroll : 0;
}

function toggleMarkdownPreview() {
  mdPreviewOn = !mdPreviewOn;
  saveFlag("mdPreview", mdPreviewOn);
  renderDiffActions();
  renderMarkdownPreview();
}

/** Links never navigate the app's page: web links open in the browser, repo files open here. */
mdPane.addEventListener("click", async (e) => {
  const a = (e.target as HTMLElement).closest("a");
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute("href") ?? "";
  if (!href || !repo || !target) return;
  if (isWebLink(href)) {
    invoke("open_link", { url: href }).catch(showError);
    return;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return setStatus(`Not opened: ${href}`, true);
  const [file, anchor] = href.split("#");
  const scrollTo = () => {
    if (!anchor) return;
    const el = mdPane.querySelector(`#${CSS.escape(decodeURIComponent(anchor))}`);
    el?.scrollIntoView({ block: "start" });
  };
  if (!file) return scrollTo();
  const path = resolveRepoPath(target.path, file);
  const exists = !!path && (await invoke<boolean>("is_file", { path: `${repo.root}/${path}` }));
  if (!path || !exists) return setStatus(`Not a file in the repository: ${file}`, true);
  await showDiff({ kind: "worktree", path, conflict: false }, { wholeFile: true }).catch(showError);
  scrollTo();
});

// ---- review comments in the diff (comments.ts) ------------------------------
//
// Shown under their line on the right-hand side; a 💬 marks the line in the
// margin, and hovering a line shows a ＋ there to add one. Also: right-click →
// "Add comment on this line", or Ctrl+Alt+M.

const modifiedEditor = diffEditor.getModifiedEditor();
let commentZoneIds: string[] = [];
const commentGlyphs = modifiedEditor.createDecorationsCollection();
const addGlyph = modifiedEditor.createDecorationsCollection();

/** Comments live on a current version of a file: not on history diffs, conflicts or binaries. */
function commentablePath(): string | null {
  const t = target;
  if (!t || !repo || sides?.binary || t.kind === "tree" || (t.kind === "worktree" && t.conflict)) return null;
  return t.path;
}

const whenText = (ms: number) => {
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString();
};

function updateComment(id: string, change: (c: ReviewComment) => void) {
  if (!repo) return;
  const list = loadComments(repo.root);
  const c = list.find((x) => x.id === id);
  if (!c) return;
  change(c);
  c.updated = Date.now();
  saveComments(repo.root, list);
  commentsChanged();
}

async function deleteComment(c: ReviewComment) {
  if (!repo || !(await confirmAction(`Delete this comment?\n\n${c.text.slice(0, 200)}`))) return;
  saveComments(repo.root, loadComments(repo.root).filter((x) => x.id !== c.id));
  commentsChanged();
}

async function editComment(c: ReviewComment) {
  const text = await commentDialog(`Edit comment · ${c.path}`, c.anchor, c.text);
  if (text !== null) updateComment(c.id, (x) => (x.text = text));
}

function commentCard(c: ReviewComment): HTMLElement {
  const small = (label: string, title: string, run: () => void) =>
    h("button", { type: "button", title, onclick: (e: MouseEvent) => (e.stopPropagation(), run()) }, label);
  return h(
    "div",
    { class: "comment-zone" },
    h(
      "div",
      { class: `comment-card${c.resolved ? " resolved" : ""}` },
      h(
        "div",
        { class: "head" },
        h("span", {}, c.resolved ? "✓ Resolved" : "💬 Comment"),
        h("span", { class: "meta" }, whenText(c.updated ?? c.created)),
        h("span", { class: "spacer" }),
        small("Edit", "Edit this comment", () => editComment(c)),
        small(c.resolved ? "Reopen" : "Resolve", c.resolved ? "Mark as open again" : "Mark as resolved", () =>
          updateComment(c.id, (x) => (x.resolved = !x.resolved)),
        ),
        small("Delete", "Delete this comment", () => deleteComment(c)),
      ),
      h("div", { class: "body", title: c.text }, c.text),
    ),
  );
}

/** Height of a comment card in the diff: header row + up to 3 text lines. */
const commentZoneHeight = (c: ReviewComment) => 40 + Math.min(3, c.text.split("\n").length) * 17;

/** Places this file's comments under their lines (and follows lines that moved). */
function renderCommentZones() {
  const path = commentablePath();
  const r = repo;
  const lines = path ? modifiedModel.getLinesContent() : [];
  const all = r && path ? loadComments(r.root) : [];
  const placed: { c: ReviewComment; line: number }[] = [];
  let moved = false;
  for (const c of all) {
    if (c.path !== path) continue;
    const line = locate(lines, c);
    if (line === null) continue; // outdated: listed in the Comments tab
    // Follow the line only in the work-tree view (other views can number lines differently).
    if (line !== c.line && target?.kind === "worktree") {
      c.line = line;
      moved = true;
    }
    placed.push({ c, line });
  }
  if (moved && r) saveComments(r.root, all);

  modifiedEditor.changeViewZones((zones) => {
    for (const id of commentZoneIds) zones.removeZone(id);
    commentZoneIds = placed.map(({ c, line }) =>
      zones.addZone({
        afterLineNumber: line,
        heightInPx: commentZoneHeight(c),
        domNode: commentCard(c),
        suppressMouseDown: true, // let the card's buttons get the clicks
      }),
    );
  });
  commentGlyphs.set(
    placed.map(({ c, line }) => ({
      range: new monaco.Range(line, 1, line, 1),
      options: { glyphMarginClassName: "comment-glyph", glyphMarginHoverMessage: { value: c.text } },
    })),
  );
}

async function addCommentAt(line: number) {
  const path = commentablePath();
  const r = repo;
  if (!path || !r) {
    setStatus("Comments can be added on the right side of a working, staged or group diff", true);
    return;
  }
  const lineText = modifiedModel.getLineContent(line);
  const text = await commentDialog(`Comment on line ${line} · ${path}`, lineText, "");
  if (text === null) return;
  const list = loadComments(r.root);
  list.push({ id: newCommentId(), path, line, anchor: lineText.trim(), text, created: Date.now(), resolved: false });
  saveComments(r.root, list);
  commentsChanged();
}

function commentsChanged() {
  renderCommentZones();
  updateCommentsTab();
  if (activeTab === "comments") renderCommentsPanel().catch(showError);
}

modifiedEditor.addAction({
  id: "hunkpad.addComment",
  label: "Add comment on this line",
  contextMenuGroupId: "navigation",
  contextMenuOrder: 0,
  keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyM],
  run: (ed) => {
    const p = ed.getPosition();
    if (p) addCommentAt(p.lineNumber);
  },
});

// Hovering a line shows ＋ in the margin; clicking the margin adds (or edits) a comment.
modifiedEditor.onMouseMove((e) => {
  const line = e.target.position?.lineNumber;
  const commented = commentGlyphs.getRanges().some((rg) => rg.startLineNumber === line);
  if (!line || !commentablePath() || commented) return addGlyph.clear();
  addGlyph.set([{ range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: "comment-add-glyph" } }]);
});
modifiedEditor.onMouseLeave(() => addGlyph.clear());
modifiedEditor.onMouseDown((e) => {
  if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || !e.target.position) return;
  const line = e.target.position.lineNumber;
  const r = repo;
  const path = commentablePath();
  const existing =
    r && path ? loadComments(r.root).find((c) => c.path === path && locate(modifiedModel.getLinesContent(), c) === line) : undefined;
  if (existing) editComment(existing);
  else addCommentAt(line);
});

// ---- comment dialog -------------------------------------------------------

const commentDialogEl = $<HTMLDialogElement>("comment-dialog");
const commentText = $<HTMLTextAreaElement>("comment-text");
let answerComment: ((text: string | null) => void) | null = null;

/** Asks for a comment's text; null when cancelled or left empty. */
function commentDialog(title: string, lineText: string, initial: string): Promise<string | null> {
  $("comment-dialog-title").textContent = title;
  $("comment-line").textContent = lineText.trim() || "(empty line)";
  commentText.value = initial;
  commentDialogEl.showModal();
  commentText.focus();
  return new Promise((resolve) => (answerComment = resolve));
}

function closeCommentDialog(save: boolean) {
  const text = commentText.value.trim();
  answerComment?.(save && text ? text : null);
  answerComment = null;
  commentDialogEl.close();
}

$("comment-save").addEventListener("click", () => closeCommentDialog(true));
$("comment-cancel").addEventListener("click", () => closeCommentDialog(false));
commentText.addEventListener("keydown", (e) => {
  if (primaryKey(e) && e.key === "Enter") {
    e.preventDefault();
    closeCommentDialog(true);
  }
});
commentDialogEl.addEventListener("cancel", (e) => {
  e.preventDefault();
  closeCommentDialog(false);
});

// ---- Comments tab ---------------------------------------------------------

type CommentFilter = "open" | "resolved" | "outdated" | "all";
let commentFilter: CommentFilter = "open";

function updateCommentsTab() {
  const open = repo ? loadComments(repo.root).filter((c) => !c.resolved).length : 0;
  $("comments-tab").textContent = open ? `Comments (${open})` : "Comments";
}

/** Opens a comment's file (whole file visible) at its line. */
async function openComment(c: ReviewComment, line: number | null) {
  await showDiff({ kind: "worktree", path: c.path, conflict: false }, { wholeFile: true });
  revealLine(line ?? c.line, "modified");
}

/** The comments the Comments tab shows now (after the filter): what its quick actions act on. */
let commentsShown: ReviewComment[] = [];

/** Resolves (or reopens) every comment in `list`. */
function setCommentsResolved(list: ReviewComment[], resolved: boolean) {
  const r = repo;
  const ids = new Set(list.filter((c) => c.resolved !== resolved).map((c) => c.id));
  if (!r || !ids.size) return;
  const now = Date.now();
  saveComments(
    r.root,
    loadComments(r.root).map((c) => (ids.has(c.id) ? { ...c, resolved, updated: now } : c)),
  );
  commentsChanged();
  setStatus(`${resolved ? "Resolved" : "Reopened"} ${ids.size} comment${ids.size === 1 ? "" : "s"}`);
}

/** Deletes every comment in `list`, after asking. */
async function dropComments(list: ReviewComment[], where: string) {
  const r = repo;
  if (!r || !list.length) return;
  const n = list.length;
  if (!(await confirmAction(`Delete ${n} comment${n === 1 ? "" : "s"} ${where}? This cannot be undone.`))) return;
  const ids = new Set(list.map((c) => c.id));
  saveComments(r.root, loadComments(r.root).filter((c) => !ids.has(c.id)));
  commentsChanged();
  setStatus(`Deleted ${n} comment${n === 1 ? "" : "s"}`);
}

const filterName = () => ({ open: "open", resolved: "resolved", outdated: "outdated", all: "" })[commentFilter];

function renderCommentActions() {
  const shown = commentsShown;
  const open = shown.filter((c) => !c.resolved).length;
  const resolved = shown.length - open;
  const name = filterName();
  $("comments-shown").textContent = `${shown.length} ${name ? `${name} ` : ""}comment${shown.length === 1 ? "" : "s"}`;
  $<HTMLButtonElement>("comments-resolve-all").disabled = !open;
  $<HTMLButtonElement>("comments-reopen-all").disabled = !resolved;
  $<HTMLButtonElement>("copy-comments").disabled = !shown.length;
  $<HTMLButtonElement>("comments-drop-all").disabled = !shown.length;
  // Resolve / Reopen only where they can do something.
  $("comments-resolve-all").classList.toggle("hidden", commentFilter === "resolved");
  $("comments-reopen-all").classList.toggle("hidden", commentFilter === "open" || commentFilter === "outdated");
}

$("comments-resolve-all").addEventListener("click", () => setCommentsResolved(commentsShown, true));
$("comments-reopen-all").addEventListener("click", () => setCommentsResolved(commentsShown, false));
$("comments-drop-all").addEventListener("click", () => {
  const name = filterName();
  dropComments(commentsShown, name ? `(all ${name} comments shown)` : "(all comments in this repository)").catch(showError);
});

async function renderCommentsPanel() {
  const r = repo;
  if (!r) return;
  const all = loadComments(r.root);
  // Where each comment's line is now (null = outdated: the line's text is gone).
  const paths = [...new Set(all.map((c) => c.path))];
  const contents = new Map(
    await Promise.all(paths.map(async (p) => [p, await r.readWorktree(p).catch(() => null)] as const)),
  );
  if (repo !== r) return;
  const located = all.map((c) => {
    const text = contents.get(c.path);
    return { c, line: text == null ? null : locate(text.split(/\r?\n/), c) };
  });
  const show = located.filter(({ c, line }) =>
    commentFilter === "all"
      ? true
      : commentFilter === "resolved"
        ? c.resolved
        : commentFilter === "outdated"
          ? !c.resolved && line === null
          : !c.resolved && line !== null,
  );

  const byPath = new Map<string, typeof show>();
  for (const x of show.sort((a, b) => a.c.path.localeCompare(b.c.path) || (a.line ?? a.c.line) - (b.line ?? b.c.line))) {
    byPath.set(x.c.path, [...(byPath.get(x.c.path) ?? []), x]);
  }

  commentsShown = show.map((x) => x.c);
  renderCommentActions();

  const rows: HTMLElement[] = [];
  for (const [path, items] of byPath) {
    const fileComments = items.map((x) => x.c);
    const openHere = fileComments.filter((c) => !c.resolved);
    rows.push(
      sectionHead(
        path,
        items.length,
        ...(openHere.length ? [iconBtn("✓", "Resolve this file's comments shown", () => setCommentsResolved(openHere, true))] : []),
        iconBtn("🗑", "Delete this file's comments shown", () => dropComments(fileComments, `in ${path}`).catch(showError)),
      ),
    );
    for (const { c, line } of items) {
      const outdated = line === null;
      rows.push(
        h(
          "div",
          {
            class: `comment-row${c.resolved ? " resolved" : ""}${outdated ? " outdated" : ""}`,
            title: `${c.text}\n\n${outdated ? "Outdated: the commented line is no longer in the file" : `Line ${line}`}`,
            onclick: () => openComment(c, line).catch(showError),
          },
          h(
            "div",
            { class: "top" },
            h("span", { class: "ln" }, outdated ? "gone" : `L${line}`),
            h("span", { class: "text" }, c.text.split("\n")[0]),
            h(
              "span",
              { class: "actions" },
              iconBtn(c.resolved ? "↺" : "✓", c.resolved ? "Reopen" : "Resolve", () =>
                updateComment(c.id, (x) => (x.resolved = !x.resolved)),
              ),
              iconBtn("✎", "Edit", () => editComment(c)),
              iconBtn("✕", "Delete", () => deleteComment(c)),
            ),
          ),
          h("div", { class: "anchor" }, c.anchor || "(empty line)"),
        ),
      );
    }
  }
  if (!rows.length) {
    rows.push(
      h(
        "div",
        { class: "empty" },
        all.length
          ? "No comments match this filter."
          : `No comments yet. In a diff, hover a line and click ＋ in the margin, right-click → Add comment, or press ${keys("Ctrl+Alt+M")}.`,
      ),
    );
  }
  $("comment-list").replaceChildren(...rows);
  updateCommentsTab();
}

document.querySelectorAll<HTMLElement>("#comment-filter button[data-filter]").forEach((b) =>
  b.addEventListener("click", () => {
    commentFilter = b.dataset.filter as CommentFilter;
    document.querySelectorAll<HTMLElement>("#comment-filter button[data-filter]").forEach((x) => x.classList.toggle("active", x === b));
    renderCommentsPanel().catch(showError);
  }),
);

// ---- copy for an LLM (export.ts) ----------------------------------------------
//
// Every "Copy … for LLM" action builds plain Markdown (repo + scope header,
// one fenced diff per file with its status, then that file's comments) and puts
// it on the clipboard. Data only: no prompt text is added.
//
// Kept local files are never part of a broad copy ("all", "unstaged"): they are
// often local secrets. They are copied only from the Kept local section itself.

const SECRET_NOTE = "Kept local files are left out";

function repoMeta(scope: string): string[] {
  const r = repo!;
  const s = status;
  const meta = [`Repository: ${projectName(r.root)} (${r.root})`];
  if (s) {
    if (!s.branch) meta.push("Branch: (detached HEAD)");
    else if (s.upstream) meta.push(`Branch: ${s.branch} (tracking ${s.upstream}, ahead ${s.ahead}, behind ${s.behind})`);
    else meta.push(`Branch: ${s.branch} (not published)`);
    if (s.oid) meta.push(`HEAD: ${s.oid.slice(0, 10)}`);
    if (s.operation) meta.push(`In progress: ${s.operation}`);
  }
  meta.push(`Scope: ${scope}`);
  return meta;
}

/** Every comment on these files, with its status and current line. */
async function commentsByPath(paths: string[]): Promise<Map<string, ExportComment[]>> {
  const r = repo!;
  const wanted = new Set(paths);
  const all = loadComments(r.root).filter((c) => wanted.has(c.path));
  const texts = new Map(
    await Promise.all([...new Set(all.map((c) => c.path))].map(async (p) => [p, await r.readWorktree(p).catch(() => null)] as const)),
  );
  const map = new Map<string, ExportComment[]>();
  for (const c of all) {
    const text = texts.get(c.path);
    const line = text == null ? null : locate(text.split(/\r?\n/), c);
    const entry: ExportComment = {
      line,
      status: c.resolved ? "resolved" : line === null ? "outdated" : "open",
      anchor: c.anchor,
      text: c.text,
    };
    map.set(c.path, [...(map.get(c.path) ?? []), entry]);
  }
  for (const list of map.values()) list.sort((a, b) => (a.line ?? 1e9) - (b.line ?? 1e9));
  return map;
}

async function stagedExport(files: FileChange[]): Promise<ExportFile[]> {
  if (!files.length) return [];
  const chunks = splitPatch(await repo!.diffPatch(true, pathsOf(files)));
  return files.map((f) => ({
    path: f.path,
    status: `${statusWord(f.staged)}${f.origPath ? ` (from ${f.origPath})` : ""} · staged`,
    patch: chunks.find((c) => c.path === f.path)?.text ?? "",
    comments: [],
  }));
}

async function unstagedExport(files: FileChange[], where = "unstaged"): Promise<ExportFile[]> {
  const r = repo!;
  const tracked = files.filter((f) => f.unstaged !== "U");
  const chunks = tracked.length ? splitPatch(await r.diffPatch(false, tracked.map((f) => f.path))) : [];
  const out: ExportFile[] = [];
  for (const f of files) {
    const patch =
      f.unstaged === "U"
        ? (splitPatch(await r.untrackedPatch(f.path))[0]?.text ?? "")
        : (chunks.find((c) => c.path === f.path)?.text ?? "");
    const letter = f.conflict ? "!" : f.unstaged;
    out.push({
      path: f.path,
      status: `${statusWord(letter)} · ${where}`,
      patch,
      note: patch ? undefined : "No text diff (binary file or file-mode change).",
      comments: [],
    });
  }
  return out;
}

/** Only a group's change blocks of each file (whole file when it is all in the group). */
async function groupExport(group: string | null, files: FileChange[], name: string): Promise<ExportFile[]> {
  const r = repo!;
  const out: ExportFile[] = [];
  for (const f of files) {
    const mine = blocksOf(f.path, group);
    const all = allBlocksOf(f.path);
    if (!all.length || mine.length === all.length || mine.some((b) => b.whole)) {
      out.push(...(await unstagedExport([f], `unstaged · group “${name}”`)));
      continue;
    }
    const index = (await r.showAsWorktree(`:${f.path}`)) ?? "";
    out.push({
      path: f.path,
      status: `${statusWord(f.unstaged)} · unstaged · group “${name}” (${mine.length} of ${all.length} change blocks)`,
      patch: blocksPatch(f.path, index, mine),
      note: "Only this group's change blocks; the file's other changes are left out.",
      comments: [],
    });
  }
  return out;
}

async function copyExport(
  scope: string,
  files: ExportFile[],
  opts: { title?: string; intro?: string; withComments?: boolean } = {},
) {
  if (!repo) return;
  if (!files.length) return setStatus(`Nothing to copy: ${scope} has no changes`, true);
  if (opts.withComments !== false) {
    const byPath = await commentsByPath(files.map((f) => f.path));
    for (const f of files) f.comments = byPath.get(f.path) ?? [];
  }
  const md = toMarkdown({ title: opts.title ?? `Changes in ${projectName(repo.root)}`, meta: repoMeta(scope), intro: opts.intro, files });
  const comments = files.reduce((n, f) => n + f.comments.length, 0);
  const summary = `${files.length} file(s)${comments ? `, ${comments} comment(s)` : ""} · ${(md.length / 1024).toFixed(1)} KB`;
  if (copyAsFile) {
    // A .md file on the clipboard: pasting into a chat attaches it instead of a wall of text.
    const name = exportFileName(scope);
    await invoke<string>("copy_as_file", { name, content: md });
    setStatus(`Copied as file ${name} (${summary}): paste with ${keys("Ctrl+V")} to attach it`);
  } else {
    await navigator.clipboard.writeText(md);
    setStatus(`Copied for LLM as text: ${summary}`);
  }
}

/** "Board.GenAI-group-wave-1-20261013-0912.md": repo, scope and time, file-name safe. */
function exportFileName(scope: string): string {
  const slug = (s: string) =>
    s
      .normalize("NFKD")
      .replace(/[^\w.\-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48)
      .toLowerCase();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const when = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  const repoName = projectName(repo!.root).replace(/[^\w.\-]+/g, "-");
  // Drop the "(Kept local files are left out)" style notes from the scope part.
  return `${repoName}-${slug(scope.replace(/\(.*?\)/g, ""))}-${when}.md`;
}

/**
 * Files can be put on the clipboard on Windows and macOS. On Linux it depends
 * on the desktop (X11/Wayland, file manager), so it always copies text there.
 */
const canCopyAsFile = !isLinux;

/** "Copy for LLM" puts a .md file on the clipboard (default) or the plain text. */
let copyAsFile = canCopyAsFile && settings.getItem("copyMode") !== "text";

function setCopyAsFile(on: boolean) {
  copyAsFile = on;
  settings.setItem("copyMode", on ? "file" : "text");
  setStatus(on ? "Copy for LLM now copies a .md file (pastes as an attachment)" : "Copy for LLM now copies plain text");
}

/** Runs a copy, reporting errors in the status bar. */
function copying(fn: () => Promise<unknown>) {
  fn().catch((e) => setStatus(`Copy failed: ${errorText(e)}`, true));
}

const changedFiles = () => status?.files ?? [];
const keptPathSet = () => new Set(repo ? loadKeptLocal(repo.root) : []);
const stagedNow = () => changedFiles().filter((f) => f.staged && !f.conflict);
const unstagedNow = () => {
  const kept = keptPathSet();
  return changedFiles().filter((f) => (f.unstaged || f.conflict) && !kept.has(f.path));
};

const copyStaged = () => copying(async () => copyExport("Staged changes", await stagedExport(stagedNow())));
const copyUnstaged = () =>
  copying(async () => copyExport(`Unstaged changes (${SECRET_NOTE})`, await unstagedExport(unstagedNow())));
const copyKept = () =>
  copying(async () => {
    const kept = keptPathSet();
    const files = changedFiles().filter((f) => f.unstaged && kept.has(f.path));
    return copyExport("Kept local files (never staged)", await unstagedExport(files, "kept local (never staged)"));
  });
const copyGroup = (group: string | null, name: string) =>
  copying(async () => {
    const files = unstagedNow().filter((f) => blocksOf(f.path, group).length || (group === null && !hunkMap.has(f.path)));
    return copyExport(`Group “${name}”`, await groupExport(group, files, name));
  });
const copyAll = () =>
  copying(async () =>
    copyExport(`All staged and unstaged changes (${SECRET_NOTE})`, [
      ...(await stagedExport(stagedNow())),
      ...(await unstagedExport(unstagedNow())),
    ]),
  );

/** One file, as shown in a given place. */
function copyFile(f: FileChange, where: "staged" | "unstaged" | "kept" | { group: string | null; name: string }) {
  copying(async () => {
    if (where === "staged") return copyExport(`File ${f.path} (staged)`, await stagedExport([f]));
    if (where === "unstaged") return copyExport(`File ${f.path} (unstaged)`, await unstagedExport([f]));
    if (where === "kept") return copyExport(`File ${f.path} (kept local)`, await unstagedExport([f], "kept local (never staged)"));
    return copyExport(`File ${f.path} (group “${where.name}”)`, await groupExport(where.group, [f], where.name));
  });
}

/** The toolbar button: the diff on screen, or everything when no file is selected. */
function copyCurrentView() {
  const t = target;
  if (!t || !repo) return copyAll();
  const file = changedFiles().find((f) => f.path === t.path);
  if (t.kind === "tree") {
    return copying(async () => {
      const patch = splitPatch(await repo!.revPatch(t.left, t.right, t.path))[0]?.text ?? "";
      return copyExport(`File ${t.path} in ${t.label}`, [{ path: t.path, status: `changed in ${t.label}`, patch, comments: [] }], {
        withComments: false,
      });
    });
  }
  if (t.kind === "vsref") {
    return copying(async () => {
      const r = repo!;
      // Not on that branch and not tracked here: show it as a new file.
      const notOnBranch = (await r.show(`${t.ref}:${t.path}`)) === null;
      const raw = notOnBranch && file?.unstaged === "U" ? await r.untrackedPatch(t.path) : await r.refWorktreePatch(t.ref, t.path);
      const patch = splitPatch(raw)[0]?.text ?? "";
      const status = notOnBranch ? `new compared with ${t.ref}` : `compared with ${t.ref} (that branch ↔ working tree)`;
      return copyExport(`File ${t.path} compared with ${t.ref}`, [{ path: t.path, status, patch, comments: [] }]);
    });
  }
  if (!file) return setStatus("This file has no changes to copy", true);
  if (t.kind === "index") return copyFile(file, "staged");
  if (t.kind === "blocks") {
    const name = t.group ? (currentGroups().find((g) => g.id === t.group)?.name ?? "group") : "Ungrouped";
    return copyFile(file, { group: t.group, name });
  }
  return copyFile(file, isKept(file.path) ? "kept" : "unstaged");
}

function copyCommit(c: Commit) {
  copying(async () => {
    const { header, patch } = await repo!.commitPatch(c.sha);
    const files = splitPatch(patch).map((ch) => ({ path: ch.path, status: "changed in this commit", patch: ch.text, comments: [] }));
    return copyExport(`Commit ${c.shortSha}`, files, {
      title: `Commit ${c.shortSha} in ${projectName(repo!.root)}`,
      intro: `${fenceFor(header)}\n${header}\n${fenceFor(header)}`,
      withComments: false,
    });
  });
}

/** The Comments tab: the comments matching the filter, with their code lines. */
function copyComments() {
  copying(async () => {
    const r = repo!;
    const byPath = await commentsByPath([...new Set(loadComments(r.root).map((c) => c.path))]);
    const keep = (c: ExportComment) =>
      commentFilter === "all" ? true : commentFilter === "outdated" ? c.status === "outdated" : c.status === commentFilter;
    const files: ExportFile[] = [...byPath]
      .map(([path, list]) => ({ path, status: "comments only (no diff)", patch: "", comments: list.filter(keep) }))
      .filter((f) => f.comments.length);
    if (!files.length) return setStatus(`Nothing to copy: no ${commentFilter === "all" ? "" : `${commentFilter} `}comments`, true);
    return copyExport(`Review comments (${commentFilter})`, files, {
      title: `Review comments in ${projectName(r.root)}`,
      withComments: false,
    });
  });
}

$("copy-btn").addEventListener("click", copyCurrentView);
$("copy-comments").addEventListener("click", copyComments);

// ---- Claude (claude.ts): optional, through the user's own `claude` CLI ----------
//
// Off until the user turns it on. Every request shows what will be sent (unless
// the user said not to ask), never includes Kept local or secret-looking files,
// and is refused when the text looks like it holds a key. Claude only answers:
// its groups, messages, comments and conflict resolutions are applied here,
// after the user accepts them, through the usual Git flow.

let claudeOn = loadFlag("claude", false);
let claudeAsk = loadFlag("claudeAsk", true);
let claudeModel = settings.getItem("claudeModel") ?? "";

const claudeDialog = $<HTMLDialogElement>("claude-dialog");
let claudeAnswer: ((choice: "ok" | "alt" | "cancel") => void) | null = null;

function claudeMode(mode: "send" | "waiting" | "result", opts: { ok?: string; alt?: string; cancel?: string } = {}) {
  claudeDialog.classList.remove("send", "waiting", "result");
  claudeDialog.classList.add(mode);
  claudeDialog.classList.toggle("has-alt", !!opts.alt);
  $("claude-ok").textContent = opts.ok ?? "OK";
  $("claude-alt").textContent = opts.alt ?? "";
  $("claude-cancel").textContent = opts.cancel ?? "Cancel";
  if (!claudeDialog.open) claudeDialog.showModal();
}

function claudeChoice(): Promise<"ok" | "alt" | "cancel"> {
  return new Promise((resolve) => (claudeAnswer = resolve));
}

function answerClaude(choice: "ok" | "alt" | "cancel") {
  const fn = claudeAnswer;
  claudeAnswer = null;
  fn?.(choice);
}

$("claude-ok").addEventListener("click", () => answerClaude("ok"));
$("claude-alt").addEventListener("click", () => answerClaude("alt"));
$("claude-cancel").addEventListener("click", () => answerClaude("cancel"));
claudeDialog.addEventListener("cancel", (e) => {
  e.preventDefault();
  answerClaude("cancel");
});

/**
 * Files whose text looks like it holds a key or token. Test data and examples
 * can look like that too, so the user decides: leave those files out (the
 * paths returned), send anyway (none returned), or cancel (null).
 */
async function screenSecrets(parts: { path: string; text: string }[]): Promise<Set<string> | null> {
  const hits = new Map<string, Set<string>>();
  for (const p of parts) {
    for (const kind of findSecrets(p.text)) hits.set(p.path, (hits.get(p.path) ?? new Set()).add(kind));
  }
  if (!hits.size) return new Set();
  const choice = await showClaudeResult(
    "These changes may contain secrets",
    [
      h("p", {}, "Some added lines look like a key or token. Test data and examples can look like that too: check before sending."),
      h("ul", {}, ...[...hits].map(([path, kinds]) => h("li", {}, h("code", {}, path), ` · ${[...kinds].join(", ")}`))),
      h("p", { class: "small muted" }, "To never send a file, right-click it → Keep local."),
    ],
    { ok: `Leave ${hits.size === 1 ? "it" : "them"} out`, alt: "Send anyway", cancel: "Cancel" },
  );
  claudeDialog.close();
  if (choice === "cancel") return null;
  return choice === "ok" ? new Set(hits.keys()) : new Set();
}

/**
 * Files Claude may see: never Hunkpad's folder, Kept local or secret-looking
 * files; files that seem to hold a key only if the user says so. Null = cancelled.
 */
async function claudeFiles(files: ExportFile[]): Promise<{ send: ExportFile[]; skipped: string[] } | null> {
  const skipped: string[] = [];
  const allowed = files.filter((f) => {
    const bad = isSecretPath(f.path) || isKept(f.path);
    if (bad) skipped.push(f.path);
    return !bad;
  });
  const leaveOut = await screenSecrets(allowed.map((f) => ({ path: f.path, text: f.patch })));
  if (!leaveOut) return null;
  skipped.push(...leaveOut);
  return { send: allowed.filter((f) => !leaveOut.has(f.path)), skipped };
}

/** Markdown of changes for a request (diffs, statuses, open comments). */
async function changesMarkdown(scope: string, files: ExportFile[], intro?: string): Promise<string> {
  const byPath = await commentsByPath(files.map((f) => f.path));
  for (const f of files) f.comments = (byPath.get(f.path) ?? []).filter((c) => c.status === "open");
  return toMarkdown({ title: `Changes in ${projectName(repo!.root)}`, meta: repoMeta(scope), intro, files });
}

/**
 * Sends one request: checks it, shows it (unless asked not to), waits with a
 * Cancel button, and returns Claude's answer, or null when cancelled or refused.
 * The dialog stays open (waiting) for the caller to show the result.
 */
async function askClaude(req: {
  title: string;
  summary: string;
  files: string[];
  skipped?: string[];
  prompt: string;
  system: string;
  schema: object;
}): Promise<unknown | null> {
  if (!repo) return null;
  const bytes = new TextEncoder().encode(req.prompt).length;
  if (bytes > MAX_PROMPT_BYTES) {
    await message(
      `This is too much to send at once (${(bytes / 1024).toFixed(0)} KB). Use a group, or stage fewer files, and try again.`,
      { title: "Hunkpad", kind: "warning" },
    );
    return null;
  }
  $("claude-title").textContent = req.title;
  $("claude-summary").textContent = `${req.summary} · ${(bytes / 1024).toFixed(1)} KB${claudeModel ? ` · model ${claudeModel}` : ""}`;
  $("claude-files").replaceChildren(
    ...req.files.map((p) => h("li", {}, p)),
    ...(req.skipped ?? []).map((p) => h("li", { class: "skipped", title: "Not sent: kept local or looks like a secret" }, p)),
  );
  $("claude-payload").textContent = req.prompt;
  $("claude-result").replaceChildren();
  const noAsk = $<HTMLInputElement>("claude-noask");
  noAsk.checked = false;
  if (claudeAsk) {
    claudeMode("send", { ok: "Send" });
    if ((await claudeChoice()) !== "ok") return void claudeDialog.close();
    if (noAsk.checked) {
      claudeAsk = false;
      saveFlag("claudeAsk", false);
    }
  }
  $("claude-wait-text").textContent = `${req.title.replace(/\?$/, "")}: waiting for Claude…`;
  claudeMode("waiting", { cancel: "Cancel" });
  const run = runClaude({ cwd: repo.root, system: req.system, prompt: req.prompt, schema: req.schema, model: claudeModel });
  const t0 = performance.now();
  const cancelled = claudeChoice().then((c) => {
    if (c === "cancel") run.cancel();
  });
  try {
    const answer = await run.result;
    setStatus(`Claude answered in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    return answer;
  } catch (e) {
    claudeDialog.close();
    if (e instanceof ClaudeCancelledError) {
      setStatus("Claude: cancelled");
      return null;
    }
    throw e;
  } finally {
    answerClaude("ok"); // settles the pending Cancel wait
    await cancelled;
  }
}

/** Shows a result; resolves with the button chosen ("cancel" = Close). */
function showClaudeResult(title: string, content: HTMLElement[], buttons: { ok: string; alt?: string; cancel?: string }) {
  $("claude-title").textContent = title;
  $("claude-summary").textContent = "";
  $("claude-result").replaceChildren(...content);
  claudeMode("result", { ok: buttons.ok, alt: buttons.alt, cancel: buttons.cancel ?? "Close" });
  return claudeChoice();
}

function markdownBlock(text: string): HTMLElement {
  const el = h("div", { class: "markdown-body" });
  el.innerHTML = markdownToHtml(text);
  return el;
}

/** Runs a Claude action, reporting failures in a dialog (with the CLI's own words). */
function claudeAction(fn: () => Promise<unknown>) {
  if (!repo) return;
  if (!claudeOn) return void enableClaude();
  fn().catch(async (e) => {
    if (claudeDialog.open) claudeDialog.close();
    setStatus(`Claude failed: ${errorText(e)}`, true);
    if (e instanceof ClaudeSignInError) {
      const go = await ask(`${errorText(e)}\n\nOpen a terminal to sign in? Then try again.`, {
        title: "Claude",
        kind: "warning",
        okLabel: "Sign in…",
        cancelLabel: "Close",
      });
      if (!go || !repo) return;
      await claudeSignIn(repo.root).catch(showError);
      setStatus("Finish signing in in the terminal window, then try again");
      return;
    }
    await message(errorText(e), { title: "Claude", kind: "error" });
  });
}

async function enableClaude() {
  const version = await claudeVersion().catch(() => null);
  if (!version) {
    await message(
      "Hunkpad's Claude features use the Claude Code command line (claude), which was not found.\n\n" +
        "Install it from claude.com/claude-code, run `claude` once in a terminal to sign in, then try again.",
      { title: "Claude", kind: "info" },
    );
    return;
  }
  const ok = await ask(
    `Turn on Claude features? (claude ${version.replace(/\s*\(.*\)$/, "")})\n\n` +
      "Hunkpad will send the diffs you choose to Claude through your own claude command line and its login. " +
      "You see what will be sent before each request. Kept local and secret-looking files are never sent.",
    { title: "Claude", okLabel: "Turn on" },
  );
  if (!ok) return;
  setClaudeOn(true);
}

function setClaudeOn(on: boolean) {
  claudeOn = on;
  saveFlag("claude", on);
  claudeMsgTitle();
  setStatus(on ? "Claude features on: ✨ in the commit box, ✨ on Unstaged, and the ⋯ menu" : "Claude features off");
  if (status) renderChanges();
}

async function setClaudeModel() {
  const value = await promptInput("Claude model: alias or name (empty = the claude CLI's default), e.g. opus, sonnet, haiku", claudeModel);
  if (value === null && !claudeModel) return;
  claudeModel = value ?? "";
  settings.setItem("claudeModel", claudeModel);
  setStatus(claudeModel ? `Claude model: ${claudeModel}` : "Claude model: the CLI's default");
}

// 1. Commit message: for the staged changes, else the unstaged ones (not Kept local).
function draftCommitMessage() {
  claudeAction(async () => {
    const staged = stagedNow();
    const files = staged.length ? await stagedExport(staged) : await unstagedExport(unstagedNow());
    if (!files.length) return setStatus("Nothing to describe: no changes", true);
    await draftMessageFor(staged.length ? "Staged changes" : "Unstaged changes", files, (msg) => {
      commitMsg.value = msg;
      commitMsg.focus();
    });
  });
}

/** Drafts a message for these changes and hands it to `use` (after the user accepts it). */
async function draftMessageFor(scope: string, all: ExportFile[], use: (message: string) => void) {
  const picked = await claudeFiles(all);
  if (!picked) return;
  const { send, skipped } = picked;
  if (!send.length) return setStatus("Nothing to send: only kept-local or secret-looking files changed", true);
  const r = repo!;
  const prompt = commitPrompt(await changesMarkdown(scope, send), await r.recentSubjects());
  const answer = await askClaude({
    title: "Draft a commit message with Claude?",
    summary: `${scope}: ${send.length} file(s)`,
    files: send.map((f) => f.path),
    skipped,
    prompt,
    system: COMMIT_SYSTEM,
    schema: COMMIT_SCHEMA,
  });
  if (answer === null) return;
  const msg = parseCommitMessage(answer);
  const box = h("textarea", { rows: 8 }) as HTMLTextAreaElement;
  box.value = msg;
  const choice = await showClaudeResult("Commit message from Claude", [box], { ok: "Use this message", cancel: "Discard" });
  claudeDialog.close();
  if (choice === "ok" && box.value.trim()) use(box.value.trim());
}

function draftGroupMessage(g: ChangeGroup) {
  claudeAction(async () => {
    const files = unstagedNow().filter((f) => blocksOf(f.path, g.id).length);
    if (!files.length) return setStatus(`“${g.name}” has no changes`, true);
    await draftMessageFor(`Group “${g.name}”`, await groupExport(g.id, files, g.name), (msg) => {
      updateGroups((groups) => groups.map((x) => (x.id === g.id ? { ...x, message: msg } : x)));
      setStatus(`Message saved for “${g.name}”: Commit this group to use it`);
    });
  });
}

// 2. Organize: Claude splits the change blocks (the ungrouped ones, when groups exist) into groups.
async function blocksToOrganize(r: Repo): Promise<Hunk[]> {
  const files = unstagedNow().filter((f) => !f.conflict && !isSecretPath(f.path));
  const wanted = new Set(files.map((f) => f.path));
  if (loadGroups(r.root).length) {
    return [...hunkMap.entries()].filter(([p]) => wanted.has(p)).flatMap(([, list]) => list.filter((x) => x.group === null).map((x) => x.hunk));
  }
  const parsed = parseDiffU0(await r.diffU0()).filter((hk) => wanted.has(hk.path));
  for (const f of files) if (f.unstaged === "U") parsed.push(wholeFileHunk(f.path, "untracked"));
  return parsed;
}

async function blockText(r: Repo, hk: Hunk): Promise<string> {
  if (hk.whole === "binary") return "(binary file changed)";
  if (hk.whole === "untracked") {
    const patch = splitPatch(await r.untrackedPatch(hk.path))[0]?.text ?? "";
    return `(new file)\n${patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).join("\n")}`;
  }
  return [
    `@@ -${hk.oldStart},${hk.oldCount} +${hk.newStart},${hk.newCount} @@`,
    ...hk.removed.map((l) => `-${l}`),
    ...hk.added.map((l) => `+${l}`),
  ].join("\n");
}

function organizeWithClaude() {
  claudeAction(async () => {
    const r = repo!;
    if (status?.operation) return setStatus(`Finish or abort the ${status.operation} first`, true);
    const found = await blocksToOrganize(r);
    const texts = await Promise.all(found.map((hk) => blockText(r, hk)));
    const leaveOut = await screenSecrets(found.map((hk, i) => ({ path: hk.path, text: texts[i] })));
    if (!leaveOut) return;
    const keep = found.map((hk) => !leaveOut.has(hk.path));
    const hunks = found.filter((_, i) => keep[i]);
    if (hunks.length < 2) return setStatus("Nothing to organize: fewer than two ungrouped changes", true);
    const blocks: PlanBlock[] = texts.filter((_, i) => keep[i]).map((text, i) => ({ id: `b${i + 1}`, path: hunks[i].path, text }));
    const skipped = [...unstagedNow().filter((f) => isSecretPath(f.path)).map((f) => f.path), ...leaveOut];
    const answer = await askClaude({
      title: "Organize changes into groups with Claude?",
      summary: `${blocks.length} change blocks in ${new Set(blocks.map((b) => b.path)).size} file(s)`,
      files: [...new Set(blocks.map((b) => b.path))],
      skipped,
      prompt: organizePrompt(blocks, await r.recentSubjects()),
      system: ORGANIZE_SYSTEM,
      schema: ORGANIZE_SCHEMA,
    });
    if (answer === null) return;
    const plan = parseGroupPlan(answer, blocks.map((b) => b.id));
    const byId = new Map(blocks.map((b, i) => [b.id, hunks[i]]));

    // Preview: each group with its message and files; untick to leave a group out.
    const picks = plan.groups.map(() => true);
    const rows = plan.groups.map((g, i) => {
      const box = h("input", { type: "checkbox", checked: true, onchange: () => (picks[i] = box.checked) }) as HTMLInputElement;
      const files = [...new Set(g.blocks.map((id) => byId.get(id)!.path))];
      return h(
        "div",
        { class: "plan-group" },
        h("label", {}, box, `${g.name} · ${g.blocks.length} change(s)`),
        h("div", { class: "plan-files" }, files.join(", ")),
        g.message ? h("pre", {}, g.message) : null,
      );
    });
    const note = plan.unplaced.length
      ? h("p", { class: "small muted" }, `${plan.unplaced.length} change(s) not placed by Claude stay Ungrouped.`)
      : null;
    const choice = await showClaudeResult(
      `Claude suggests ${plan.groups.length} group(s)`,
      [...rows, note ?? h("span", {}), h("p", { class: "small muted" }, "Groups are local to this machine. You can still drag changes between them, rename them, or delete them.")],
      { ok: "Create groups", cancel: "Discard" },
    );
    claudeDialog.close();
    if (choice !== "ok") return;

    const chosen = plan.groups.filter((_, i) => picks[i]);
    if (!chosen.length) return;
    const made = chosen.map((g) => ({ id: newUserId(), name: g.name, files: [] as string[], ...(g.message ? { message: g.message } : {}) }));
    saveGroups(r.root, [...loadGroups(r.root), ...made]);
    const groupOf = new Map<Hunk, string | null>(hunks.map((hk) => [hk, null]));
    chosen.forEach((g, i) => g.blocks.forEach((id) => groupOf.set(byId.get(id)!, made[i].id)));
    const state = loadHunkState(r.root);
    const others = state.hunks.filter((a) => !hunks.some((hk) => sameHunk(a, hk)));
    saveHunkState(r.root, { active: state.active, hunks: [...others, ...hunks.map((hk) => assignmentOf(hk, groupOf.get(hk) ?? null))] });
    setStatus(`Created ${made.length} group(s) from Claude's suggestion`);
    await refresh();
  });
}

// 3. Review: Claude's findings become review comments (Comments tab).
function reviewWithClaude() {
  claudeAction(async () => {
    const r = repo!;
    const staged = await stagedExport(stagedNow());
    const unstaged = await unstagedExport(unstagedNow().filter((f) => !f.conflict));
    const picked = await claudeFiles([...staged, ...unstaged].filter((f) => f.patch));
    if (!picked) return;
    const { send, skipped } = picked;
    if (!send.length) return setStatus("Nothing to review: no changes", true);
    const answer = await askClaude({
      title: "Review my changes with Claude?",
      summary: `Staged and unstaged changes: ${new Set(send.map((f) => f.path)).size} file(s)`,
      files: [...new Set(send.map((f) => f.path))],
      skipped,
      prompt: reviewPrompt(await changesMarkdown("Staged and unstaged changes", send)),
      system: REVIEW_SYSTEM,
      schema: REVIEW_SCHEMA,
    });
    if (answer === null) return;
    const texts = new Map<string, string[]>();
    for (const p of new Set(send.map((f) => f.path))) {
      const text = await r.readWorktree(p).catch(() => null);
      if (text !== null) texts.set(p, text.split(/\r?\n/));
    }
    const findings = parseFindings(answer, new Map([...texts].map(([p, lines]) => [p, lines.length])));
    claudeDialog.close();
    if (!findings.length) return setStatus("Claude's review: no problems found");
    const list = loadComments(r.root);
    const now = Date.now();
    for (const f of findings) {
      const anchor = texts.get(f.path)![f.line - 1]?.trim() ?? "";
      list.push({ id: newCommentId(), path: f.path, line: f.line, anchor, text: `Claude: ${f.comment}`, created: now, resolved: false });
    }
    saveComments(r.root, list);
    commentsChanged();
    setStatus(`Claude's review: ${findings.length} comment(s) added (Comments tab)`);
    await showTab("comments");
  });
}

/** Text to copy (or use), in an editable box, with a Markdown preview. */
async function showClaudeText(title: string, text: { title: string; body: string }, copyLabel: string) {
  const full = `${text.title}\n\n${text.body}`;
  const choice = await showClaudeResult(title, [h("h3", {}, text.title), markdownBlock(text.body)], {
    ok: copyLabel,
    alt: "Copy as Markdown",
  });
  claudeDialog.close();
  if (choice === "ok") {
    await navigator.clipboard.writeText(full);
    setStatus("Copied");
  } else if (choice === "alt") {
    await navigator.clipboard.writeText(`# ${text.title}\n\n${text.body}`);
    setStatus("Copied as Markdown");
  }
}

// 4. Pull request description for the current branch against a base branch.
function describeBranchWithClaude() {
  claudeAction(async () => {
    const r = repo!;
    const s = status!;
    if (!s.branch) return setStatus("Check out a branch first (HEAD is detached)", true);
    const guess = compareRef ?? (await r.defaultRemoteBranch()) ?? s.upstream ?? "main";
    const base = await promptInput(`Describe “${s.branch}” for a pull request into (base branch)`, guess);
    if (!base) return;
    if (!(await r.isCommit(base))) return setStatus(`“${base}” is not a branch, tag or commit`, true);
    const commits = await r.commitsSince(base);
    if (!commits.length) return setStatus(`“${s.branch}” has no commits that are not on ${base}`, true);
    const files = splitPatch(await r.branchPatch(base)).map((c) => ({ path: c.path, status: `changed since ${base}`, patch: c.text, comments: [] }));
    const picked = await claudeFiles(files);
    if (!picked) return;
    const { send, skipped } = picked;
    const changes = toMarkdown({ title: `${s.branch} compared with ${base}`, meta: repoMeta(`Branch ${s.branch} since ${base}`), files: send });
    const answer = await askClaude({
      title: "Describe this branch for a pull request?",
      summary: `${commits.length} commit(s), ${send.length} file(s) since ${base}`,
      files: send.map((f) => f.path),
      skipped,
      prompt: prPrompt(base, s.branch, commits.join("\n"), changes),
      system: PR_SYSTEM,
      schema: TEXT_SCHEMA,
    });
    if (answer === null) return;
    await showClaudeText(`Pull request: ${s.branch} → ${base}`, parseText(answer), "Copy title + description");
  });
}

// 5. Explain a commit (History tab).
function explainCommitWithClaude(c: Commit) {
  claudeAction(async () => {
    const r = repo!;
    const { header, patch } = await r.commitPatch(c.sha);
    const files = splitPatch(patch).map((ch) => ({ path: ch.path, status: "changed in this commit", patch: ch.text, comments: [] }));
    const picked = await claudeFiles(files);
    if (!picked) return;
    const { send, skipped } = picked;
    const changes = toMarkdown({
      title: `Commit ${c.shortSha} in ${projectName(r.root)}`,
      meta: [`Repository: ${projectName(r.root)}`],
      intro: `${fenceFor(header)}\n${header}\n${fenceFor(header)}`,
      files: send,
    });
    const answer = await askClaude({
      title: `Explain commit ${c.shortSha} with Claude?`,
      summary: `${send.length} file(s)`,
      files: send.map((f) => f.path),
      skipped,
      prompt: explainPrompt(changes),
      system: EXPLAIN_SYSTEM,
      schema: TEXT_SCHEMA,
    });
    if (answer === null) return;
    await showClaudeText(`Commit ${c.shortSha}`, parseText(answer), "Copy");
  });
}

// 6. Merge conflicts: Claude proposes the resolved file; applied only when accepted.
function resolveConflictWithClaude(f: FileChange) {
  claudeAction(async () => {
    const r = repo!;
    if (isSecretPath(f.path)) return setStatus(`${f.path} looks like a secret file: not sent to Claude`, true);
    const original = await r.readWorktree(f.path);
    if (original === null) return setStatus(`${f.path} is not a text file in the work tree`, true);
    if (!hasConflictMarkers(original)) return setStatus(`${f.path} has no conflict markers left`, true);
    const leaveOut = await screenSecrets([{ path: f.path, text: original }]);
    if (!leaveOut || leaveOut.size) return;
    const answer = await askClaude({
      title: `Resolve the conflicts in ${f.path} with Claude?`,
      summary: `1 file${status?.operation ? ` · ${status.operation} in progress` : ""}`,
      files: [f.path],
      prompt: conflictPrompt(f.path, status?.operation ?? null, original),
      system: CONFLICT_SYSTEM,
      schema: CONFLICT_SCHEMA,
    });
    if (answer === null) return;
    const { content, explanation } = parseResolution(answer, original);
    const choice = await showClaudeResult(
      `Suggested resolution for ${f.path}`,
      [
        markdownBlock(explanation || "_No explanation given._"),
        h("details", {}, h("summary", { class: "small" }, "Show the resolved file"), h("pre", {}, content)),
        h("p", { class: "small muted" }, "Applying writes the file only; it stays conflicted until you review the diff and Mark resolved (+)."),
      ],
      { ok: "Apply to file", cancel: "Discard" },
    );
    claudeDialog.close();
    if (choice !== "ok") return;
    await r.writeWorktree(f.path, content);
    setStatus(`Claude's resolution written to ${f.path}: review it, then Mark resolved (+). To start over: git checkout -m -- ${f.path}`);
    await refresh();
    await showDiff({ kind: "worktree", path: f.path, conflict: true });
  });
}

/** The ✨ in the commit box is always there; while Claude is off it offers to turn it on. */
function claudeMsgTitle() {
  $("claude-msg").title = claudeOn
    ? "Draft the message with Claude, from the staged changes (or, with nothing staged, the unstaged ones)"
    : "Draft the message with Claude (click to turn on the Claude features)";
}
claudeMsgTitle();
$("claude-msg").addEventListener("click", draftCommitMessage);

function claudeMenu(): MenuItem[] {
  if (!claudeOn) return [{ label: "Claude features…", run: () => enableClaude().catch(showError) }];
  return [
    { label: "✨ Claude: organize changes into groups", run: organizeWithClaude },
    { label: "✨ Claude: review my changes", run: reviewWithClaude },
    { label: "✨ Claude: describe this branch for a pull request…", run: describeBranchWithClaude },
    { label: `Claude: ${claudeAsk ? "✓ " : ""}ask before sending`, run: () => saveFlag("claudeAsk", (claudeAsk = !claudeAsk)) },
    { label: `Claude model: ${claudeModel || "CLI default"}…`, run: () => setClaudeModel().catch(showError) },
    { label: "Turn off Claude features", run: () => setClaudeOn(false) },
  ];
}

// ---- overview of all changes ----------------------------------------------

const OV_MAX_LINES = 300; // per file; the full diff is one click away
const OV_MAX_UNTRACKED = 30;
let overviewToken = 0;

/** Scrolls the diff editor to a line and puts the cursor there. */
function revealLine(line: number, side: "original" | "modified") {
  const editor = side === "original" ? diffEditor.getOriginalEditor() : diffEditor.getModifiedEditor();
  editor.revealLineInCenter(line);
  editor.setPosition({ lineNumber: line, column: 1 });
  editor.focus();
}

function overviewFile(f: PatchFile, staged: boolean): HTMLElement {
  const fileStatus = status?.files.find((x) => x.path === f.path);
  const t: DiffTarget = staged
    ? { kind: "index", path: f.path, origPath: f.oldPath }
    : { kind: "worktree", path: f.path, conflict: !!fileStatus?.conflict };
  const open = (line?: number, side: "original" | "modified" = "modified") =>
    showDiff(t)
      .then(() => line && revealLine(line, side))
      .catch(showError);

  const letter = (staged ? fileStatus?.staged : fileStatus?.unstaged) ?? (fileStatus?.conflict ? "!" : "");
  const slash = f.path.lastIndexOf("/");
  const head = h(
    "div",
    { class: "ov-file-head", title: "Open this file's diff", onclick: () => open() },
    h("span", { class: `status ${letter}` }, letter),
    h("span", { class: "name" }, `${f.oldPath ? `${f.oldPath} → ` : ""}${f.path.slice(slash + 1)}`),
    h("span", { class: "dir" }, slash >= 0 ? f.path.slice(0, slash) : ""),
    h("span", { class: "ov-stat" }, h("span", { class: "a" }, `+${f.added}`), h("span", { class: "r" }, `−${f.removed}`)),
  );

  const body: HTMLElement[] = [];
  if (f.binary) body.push(h("div", { class: "ov-note" }, "Binary file"));
  let shown = 0;
  const total = f.hunks.reduce((n, hk) => n + hk.lines.length, 0);
  for (const hk of f.hunks) {
    if (shown >= OV_MAX_LINES) break;
    const first = hk.lines.find((l) => l.newNo !== null)?.newNo ?? hk.lines[0]?.oldNo ?? 1;
    body.push(h("div", { class: "ov-hunk-head" }, `Line ${first}${hk.context ? `  ·  ${hk.context}` : ""}`));
    for (const ln of hk.lines) {
      if (shown++ >= OV_MAX_LINES) break;
      // A removed line only exists on the left side of the diff.
      const onclick = () => (ln.newNo !== null ? open(ln.newNo, "modified") : open(ln.oldNo ?? 1, "original"));
      body.push(
        h(
          "div",
          { class: `ov-line${ln.kind === "+" ? " add" : ln.kind === "-" ? " del" : ""}`, onclick },
          h("span", { class: "ln" }, ln.oldNo === null ? "" : String(ln.oldNo)),
          h("span", { class: "ln" }, ln.newNo === null ? "" : String(ln.newNo)),
          h("span", { class: "tx" }, `${ln.kind}${ln.text}`),
        ),
      );
    }
  }
  if (total > OV_MAX_LINES) {
    body.push(
      h(
        "div",
        { class: "ov-note" },
        `… ${total - OV_MAX_LINES} more lines. `,
        h("a", { onclick: () => open() }, "Open the full diff"),
      ),
    );
  }
  return h("div", { class: "ov-file" }, head, ...body);
}

/** Every changed file with only its changed chunks, shown when no file is selected. */
async function renderOverview() {
  const el = $("overview");
  const r = repo;
  if (!r || target) {
    el.classList.add("hidden");
    return;
  }
  const token = ++overviewToken;
  const untrackedPaths = (status?.files ?? []).filter((f) => f.unstaged === "U").map((f) => f.path);
  const [stagedOut, unstagedOut, untracked] = await Promise.all([
    r.diffPatch(true),
    r.diffPatch(false),
    Promise.all(
      untrackedPaths
        .slice(0, OV_MAX_UNTRACKED)
        .map(async (p) => untrackedPatch(p, await r.readWorktree(p).catch(() => null), OV_MAX_LINES)),
    ),
  ]);
  if (token !== overviewToken || repo !== r || target) return; // superseded

  const staged = parsePatch(stagedOut);
  const kept = new Set(loadKeptLocal(r.root));
  const allUnstaged = [...parsePatch(unstagedOut), ...untracked];
  const unstaged = allUnstaged.filter((f) => !kept.has(f.path));
  const keptFiles = allUnstaged.filter((f) => kept.has(f.path));
  const nodes: HTMLElement[] = [];
  const section = (title: string, files: PatchFile[], isStaged: boolean, empty: string) => {
    nodes.push(h("div", { class: "ov-section" }, `${title} · ${files.length} file${files.length === 1 ? "" : "s"}`));
    nodes.push(...files.map((f) => overviewFile(f, isStaged)));
    if (!files.length) nodes.push(h("div", { class: "ov-note" }, empty));
  };
  section("Staged", staged, true, "Nothing staged.");
  section("Unstaged", unstaged, false, "No unstaged changes.");
  if (keptFiles.length) section("Kept local (never staged)", keptFiles, false, "");
  if (untrackedPaths.length > OV_MAX_UNTRACKED) {
    nodes.push(h("div", { class: "ov-note" }, `${untrackedPaths.length - OV_MAX_UNTRACKED} more new files not shown here.`));
  }

  const scroll = el.scrollTop;
  el.replaceChildren(...nodes);
  el.scrollTop = scroll;
  el.classList.remove("hidden");
  $("placeholder").classList.add("hidden");
}

$("overview-btn").addEventListener("click", clearDiff);

// ---- compare with a branch ---------------------------------------------------
//
// While a compare ref is set, every changed file opens as "<ref> ↔ your file on
// disk". The pill in the toolbar shows it and turns it off.

let compareRef: string | null = null;

function loadRecentCompares(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem("recentCompares") ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function rememberCompare(ref: string) {
  const list = [ref, ...loadRecentCompares().filter((r) => r !== ref)].slice(0, 6);
  try {
    localStorage.setItem("recentCompares", JSON.stringify(list));
  } catch {
    // just won't be remembered
  }
}

/** The plain diff target for a path (what clicking it would open without compare). */
function baseTargetFor(path: string): DiffTarget {
  const f = status?.files.find((x) => x.path === path);
  if (f && !f.unstaged && f.staged) return { kind: "index", path, origPath: f.origPath };
  return { kind: "worktree", path, conflict: !!f?.conflict };
}

async function setCompare(ref: string | null) {
  const r = repo;
  if (!r) return;
  if (ref && !(await r.isCommit(ref))) {
    setStatus(`“${ref}” is not a branch, tag or commit in this repository`, true);
    return;
  }
  compareRef = ref;
  if (ref) rememberCompare(ref);
  setStatus(ref ? `Comparing files with ${ref}: click a changed file` : "Back to showing your changes");
  renderComparePill();
  const t = target;
  if (t && t.kind !== "tree") await showDiff(t.kind === "vsref" ? baseTargetFor(t.path) : t);
}

function renderComparePill() {
  const pill = $("compare-pill");
  pill.classList.toggle("hidden", !compareRef);
  pill.textContent = compareRef ? `⇄ vs ${compareRef}  ✕` : "";
  pill.title = compareRef ? `Files open compared with ${compareRef}. Click to stop comparing.` : "";
}

$("compare-pill").addEventListener("click", () => setCompare(null).catch(showError));

async function pickCompareRef() {
  const ref = await promptInput("Compare with which branch, tag or commit? (e.g. origin/dev)", compareRef ?? "origin/");
  if (ref) await setCompare(ref);
}

function compareMenu(): MenuItem[] {
  const s = status;
  const mark = (ref: string | null) => (compareRef === ref ? "✓ " : "");
  const items: MenuItem[] = [{ label: `${mark(null)}My changes (no branch)`, run: () => setCompare(null).catch(showError) }];
  if (s?.upstream) items.push({ label: `${mark(s.upstream)}Upstream: ${s.upstream}`, run: () => setCompare(s.upstream).catch(showError) });
  const recent = loadRecentCompares().filter((r) => r !== s?.upstream);
  if (recent.length) {
    items.push("-", ...recent.map((ref): MenuItem => ({ label: `${mark(ref)}${ref}`, run: () => setCompare(ref).catch(showError) })));
  }
  items.push("-", { label: "Other branch, tag or commit…", run: () => pickCompareRef().catch(showError) });
  return items;
}

const targetKey = (t: DiffTarget | null) =>
  !t
    ? ""
    : t.kind === "tree"
      ? `tree:${t.left}:${t.right}:${t.path}`
      : t.kind === "blocks"
        ? `blocks:${t.group}:${t.path}`
        : t.kind === "vsref"
          ? t.fromKey // keeps the row it was opened from highlighted
          : `${t.kind}:${t.path}`;

/** Change blocks under the cursor / selection in a "blocks" view. */
function pickBlocks(): Hunk[] | null {
  const t = target;
  if (t?.kind !== "blocks") return null;
  // The whole file is this group's: every block counts as picked.
  if (!sides?.blocks) return blocksOf(t.path, t.group);
  const selections = diffEditor.getModifiedEditor().getSelections() ?? [];
  const hit = sides.blocks.filter(({ hunk, range: [start, end] }) => {
    const last = hunk.newCount === 0 ? start + 1 : end; // a deletion sits between two lines
    return selections.some((s) => s.startLineNumber <= last && s.endLineNumber >= start);
  });
  if (!hit.length) {
    setStatus("Place the cursor in a change block, or select lines, first", true);
    return null;
  }
  return hit.map((b) => b.hunk);
}

function markSelected() {
  const key = targetKey(target);
  document.querySelectorAll<HTMLElement>("[data-target]").forEach((el) => {
    el.classList.toggle("selected", el.dataset.target === key);
  });
}

/** Changes under the cursor or selection in the right-hand editor. */
function pickChanges(): { selected: LineChange[]; rest: LineChange[] } | null {
  if (!sides || sides.binary || sides.lossy) {
    setStatus("Line-level actions are not available for binary or non-UTF-8 files", true);
    return null;
  }
  const all = diffEditor.getLineChanges() ?? [];
  const selections = diffEditor.getModifiedEditor().getSelections() ?? [];
  const selected: LineChange[] = [];
  const rest: LineChange[] = [];
  for (const c of all) {
    const start = c.modifiedStartLineNumber;
    const end = c.modifiedEndLineNumber || start;
    const hit = selections.some((s) => s.startLineNumber <= end && s.endLineNumber >= start);
    (hit ? selected : rest).push(c);
  }
  if (!selected.length) {
    setStatus("Place the cursor in a change, or select lines, first", true);
    return null;
  }
  return { selected, rest };
}

function stageSelected() {
  const t = target;
  const picked = pickChanges();
  if (!repo || !sides || !picked || t?.kind !== "worktree") return;
  const content = applyLineChanges(sides.original, sides.modified, picked.selected);
  act("Stage selected lines", () => repo!.setIndexContent(t.path, content));
}

function revertSelected() {
  const t = target;
  const picked = pickChanges();
  if (!repo || !sides || !picked || t?.kind !== "worktree") return;
  const content = applyLineChanges(sides.original, sides.modified, picked.rest);
  act("Revert selected lines", () => repo!.writeWorktree(t.path, content));
}

function unstageSelected() {
  const t = target;
  const picked = pickChanges();
  if (!repo || !sides || !picked || t?.kind !== "index") return;
  const content = applyLineChanges(sides.original, sides.modified, picked.rest);
  act("Unstage selected lines", () => repo!.setIndexContent(t.path, content));
}

function renderDiffActions() {
  const bar = $("diff-actions");
  bar.replaceChildren();
  renderComparePill();
  const t = target;
  if (!t || !status) return;
  const file = status.files.find((f) => f.path === t.path);
  const btn = (label: string, title: string, run: () => void) => h("button", { title, onclick: run }, label);
  if (showsMarkdown())
    bar.append(
      mdPreviewOn
        ? btn("⇆ Diff", "Show the changes instead of the rendered file", toggleMarkdownPreview)
        : btn("👁 Preview", "Show the Markdown rendered", toggleMarkdownPreview),
    );
  // "Compare with" applies to a current file (not history diffs or conflicts).
  if (t.kind === "vsref" || t.kind === "index" || t.kind === "blocks" || (t.kind === "worktree" && !t.conflict)) {
    const compare = h("button", { title: "Compare this file with your changes, the upstream branch or another branch" }, "⇄ Compare ▾");
    compare.addEventListener("click", (e) => {
      e.stopPropagation();
      const rect = compare.getBoundingClientRect();
      showMenu(rect.left, rect.bottom, compareMenu());
    });
    bar.append(compare);
  }
  if (t.kind === "vsref") return; // a comparison: nothing to stage or revert from here
  if (t.kind === "worktree" && t.conflict && file) {
    bar.append(
      btn("Accept current", "Keep our version of the whole file", () => acceptConflict(file, "ours")),
      btn("Accept incoming", "Take their version of the whole file", () => acceptConflict(file, "theirs")),
      btn("Mark resolved", "Stage the file as it is now", () => act("Mark resolved", () => repo!.stage([t.path]))),
    );
  } else if (t.kind === "worktree" && file && isKept(t.path)) {
    bar.append(
      btn("Revert selection", "Discard the changes under the cursor/selection", revertSelected),
      btn("Discard file", "Discard all changes in this file", () => discard([file])),
      btn("Stop keeping local", "Move the file back to Unstaged", () => stopKeepingLocal(t.path)),
    );
  } else if (t.kind === "worktree" && file) {
    bar.append(
      btn("Stage selection", "Stage the changes under the cursor/selection", stageSelected),
      btn("Revert selection", "Discard the changes under the cursor/selection", revertSelected),
      btn("Stage file", "Stage the whole file", () => act("Stage", () => repo!.stage([t.path]))),
      btn("Discard file", "Discard all changes in this file", () => discard([file])),
    );
  } else if (t.kind === "blocks" && file) {
    const moveBtn = h("button", { title: "Move the change block under the cursor to another group" }, "Move change ▾");
    moveBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const blocks = pickBlocks();
      if (!blocks) return;
      const r = moveBtn.getBoundingClientRect();
      showMenu(r.left, r.bottom, moveBlocksMenu(blocks, t.group));
    });
    bar.append(
      moveBtn,
      btn("Stage change", "Stage the change block under the cursor", () => {
        const b = pickBlocks();
        if (b) stageBlocks(t.path, b);
      }),
      btn("Revert change", "Discard the change block under the cursor", () => {
        const b = pickBlocks();
        if (b) discardBlocks(t.path, b);
      }),
    );
  } else if (t.kind === "index" && file) {
    bar.append(
      btn("Unstage selection", "Unstage the changes under the cursor/selection", unstageSelected),
      btn("Unstage file", "Unstage the whole file", () => unstage([file])),
    );
  }
}

// ---- repository state -----------------------------------------------------

let repo: Repo | null = null;
let status: RepoStatus | null = null;
let headSignature = "";

type Tab = "changes" | "history" | "branches" | "stashes" | "comments";
let activeTab: Tab = "changes";

// ---- repository tabs ------------------------------------------------------
//
// Each open repository is a tab. Tabs, names and colours are stored only in
// the app's own storage (see projects.ts); nothing is written inside repos.

let openTabs: string[] = [];

/** What a tab remembers while another one is active. */
interface TabState {
  message: string;
  amend: boolean;
  sideTab: Tab;
  target: DiffTarget | null;
}
const tabStates = new Map<string, TabState>();

const projectName = (root: string) => findProject(root)?.name ?? root.split("/").pop() ?? root;

function persistTabs() {
  saveUserTabs(activeUserId, openTabs, repo?.root ?? null);
}

// ---- Git users ------------------------------------------------------------

let gitUsers: GitUser[] = [];
let activeUserId = "";

const activeUser = () => gitUsers.find((u) => u.id === activeUserId) ?? gitUsers[0];

/** `-c` settings that make commits use the user's identity, without touching repo config. */
function identityConfig(u: GitUser): string[] {
  return u.authorName && u.authorEmail ? ["-c", `user.name=${u.authorName}`, "-c", `user.email=${u.authorEmail}`] : [];
}

/** The global identity (`git config --global`), shown for users that do not set their own. */
let globalIdentity = { name: "", email: "" };

async function loadGlobalIdentity() {
  const [name, email] = await Promise.all([globalConfig("user.name"), globalConfig("user.email")]);
  globalIdentity = { name, email };
}

/** The identity a user commits with, resolving "use global" to the actual values. */
const effectiveIdentity = (u: GitUser) =>
  u.authorEmail
    ? { name: u.authorName, email: u.authorEmail, global: false }
    : { ...globalIdentity, global: true };

function identityText(u: GitUser): string {
  const id = effectiveIdentity(u);
  if (!id.email) return "No identity set (global Git config is empty)";
  return `${id.name} <${id.email}>${id.global ? " (global Git identity)" : ""}`;
}

/** Shows the effective commit identity under the Commit button. */
async function updateCommitAs() {
  const el = $("commit-as");
  const r = repo;
  if (!r) return el.replaceChildren();
  const [name, email] = await Promise.all([r.configValue("user.name"), r.configValue("user.email")]);
  if (repo !== r) return;
  const u = activeUser();
  el.classList.toggle("err", !name || !email);
  el.textContent =
    name && email
      ? `Committing as ${name} <${email}> · ${u.label}`
      : `No commit identity: right-click "${u.label}" → Edit to set one`;
  el.title = el.textContent;
}

function saveUserList() {
  saveUsers(gitUsers, activeUserId);
}

/** Switches the repo row to another user's tabs. */
async function switchUser(id: string) {
  if (id === activeUserId) return;
  saveTabState();
  persistTabs();
  activeUserId = id;
  saveUserList();
  const tabs = loadUserTabs(id);
  openTabs = tabs.paths;
  loadTabsData();
  const next = tabs.active ?? openTabs[0];
  if (!next) return showNoRepo();
  try {
    await openRepo(next);
  } catch (e) {
    showError(e);
    showNoRepo();
  }
}

const userDialog = $<HTMLDialogElement>("user-dialog");
const userLabel = $<HTMLInputElement>("user-label");
const userName = $<HTMLInputElement>("user-name");
const userEmail = $<HTMLInputElement>("user-email");
const userError = $("user-error");
$("user-cancel").addEventListener("click", () => userDialog.close("cancel"));

// Keep the dialog open until the input is valid.
userDialog.querySelector("form")!.addEventListener("submit", (e) => {
  const name = userName.value.trim();
  const email = userEmail.value.trim();
  let error = "";
  if (!userLabel.value.trim()) error = "Enter a tab label.";
  else if (!!name !== !!email) error = "Fill in both name and email, or leave both empty.";
  else if (email && !/^[^\s@]+@[^\s@]+$/.test(email)) error = "Enter a valid email address.";
  userError.textContent = error;
  if (error) e.preventDefault();
});
for (const input of [userLabel, userName, userEmail]) input.addEventListener("input", () => (userError.textContent = ""));

async function globalConfig(key: string): Promise<string> {
  const out = await runGit(".", ["config", "--global", "--get", key], { quiet: true, allowFail: true });
  return out.code === 0 ? out.stdout.trim() : "";
}

/** Opens the user dialog; resolves with the edited user, or null if cancelled. */
async function editUserDialog(existing?: GitUser): Promise<GitUser | null> {
  $("user-dialog-title").textContent = existing ? `Edit ${existing.label}` : "New Git user";
  userLabel.value = existing?.label ?? "";
  // A new user starts from the global identity, ready to be changed.
  await loadGlobalIdentity();
  userName.value = existing ? existing.authorName : globalIdentity.name;
  userEmail.value = existing ? existing.authorEmail : globalIdentity.email;
  // An empty field means "global": show what that resolves to.
  userName.placeholder = globalIdentity.name ? `${globalIdentity.name} (global)` : "";
  userEmail.placeholder = globalIdentity.email ? `${globalIdentity.email} (global)` : "";
  userError.textContent = "";
  userDialog.returnValue = "";
  userDialog.showModal();
  userLabel.focus();
  await new Promise((resolve) => userDialog.addEventListener("close", resolve, { once: true }));
  if (userDialog.returnValue !== "ok") return null;
  return {
    id: existing?.id ?? newUserId(),
    label: userLabel.value.trim(),
    authorName: userName.value.trim(),
    authorEmail: userEmail.value.trim(),
    color: existing?.color ?? null,
  };
}

function applyUserChange(u: GitUser) {
  gitUsers = gitUsers.map((x) => (x.id === u.id ? u : x));
  saveUserList();
  if (u.id === activeUserId && repo) {
    repo.config = identityConfig(u);
    updateCommitAs().catch(showError);
  }
  renderTabs();
}

async function addUser() {
  const u = await editUserDialog();
  if (!u) return;
  gitUsers.push(u);
  saveUserList();
  await switchUser(u.id);
  renderTabs();
}

async function deleteUser(u: GitUser) {
  if (gitUsers.length === 1) return setStatus("The last Git user cannot be deleted", true);
  const count = u.id === activeUserId ? openTabs.length : loadUserTabs(u.id).paths.length;
  const tabs = count ? ` Its ${count} repository tab(s) will be closed (the repositories are not touched).` : "";
  if (!(await confirmAction(`Delete Git user "${u.label}"?${tabs}`))) return;
  if (u.id === activeUserId) await switchUser(gitUsers.find((x) => x.id !== u.id)!.id);
  gitUsers = gitUsers.filter((x) => x.id !== u.id);
  deleteUserTabs(u.id);
  saveUserList();
  renderTabs();
}

function userMenu(u: GitUser): MenuItem[] {
  return [
    { label: "Edit…", run: async () => {
      const edited = await editUserDialog(u);
      if (edited) applyUserChange(edited);
    } },
    "-",
    ...REPO_COLORS.map((c): MenuItem => ({
      label: `${c.name}${u.color?.toLowerCase() === c.value.toLowerCase() ? "  ✓" : ""}`,
      color: c.value,
      run: () => applyUserChange({ ...u, color: c.value }),
    })),
    { label: "No colour", run: () => applyUserChange({ ...u, color: null }) },
    "-",
    { label: "Delete…", run: () => deleteUser(u) },
  ];
}

function renderUsers() {
  $("user-tabs").replaceChildren(
    ...gitUsers.map((u) => {
      const active = u.id === activeUserId;
      const count = active ? openTabs.length : loadUserTabs(u.id).paths.length;
      const el = h(
        "div",
        {
          class: `user-tab${active ? " active" : ""}`,
          title: `${identityText(u)}\nDouble-click or right-click to edit`,
          onclick: () => !active && switchUser(u.id).catch(showError),
          ondblclick: async () => {
            const edited = await editUserDialog(u);
            if (edited) applyUserChange(edited);
          },
        },
        h("span", { class: "name" }, u.label),
        h(
          "span",
          { class: "identity" },
          effectiveIdentity(u).email || "no identity",
          effectiveIdentity(u).global && h("span", { class: "global" }, " · global"),
        ),
        h("span", { class: "count" }, String(count)),
      );
      if (u.color) el.style.setProperty("--tab-color", u.color);
      return withContextMenu(el, () => userMenu(u));
    }),
  );
}

$("add-user").addEventListener("click", () => addUser().catch(showError));

function saveTabState() {
  if (!repo) return;
  tabStates.set(repo.root.toLowerCase(), {
    message: commitMsg.value,
    amend: amendBox.checked,
    sideTab: activeTab,
    target,
  });
}

// ---- retro loading screen ---------------------------------------------------

let loaderTimer: number | undefined;
let loaderCount = 0;

/** Shows the loader only if loading takes a moment, so quick switches don't flicker. */
function showLoader(name: string) {
  loaderCount++;
  $("loader-name").textContent = name;
  clearTimeout(loaderTimer);
  loaderTimer = window.setTimeout(() => $("loader").classList.remove("hidden"), 120);
}

function hideLoader() {
  if (--loaderCount > 0) return; // another load is still running
  loaderCount = 0;
  clearTimeout(loaderTimer);
  $("loader").classList.add("hidden");
}

/** Opens `path` in its tab (creating the tab if needed) and makes it active. */
async function openRepo(path: string) {
  const name = findProject(path)?.name ?? path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
  showLoader(name);
  try {
    await openRepoNow(path);
  } finally {
    hideLoader();
  }
}

async function openRepoNow(path: string) {
  const r = await Repo.open(path);
  await loadRepoData(r.root); // its .hunkpad data, before anything renders
  saveTabState();
  // A repository belongs to one Git user: if another user has it, switch to that user.
  const owner = gitUsers.find(
    (u) => u.id !== activeUserId && loadUserTabs(u.id).paths.some((p) => samePath(p, r.root)),
  );
  if (owner) {
    persistTabs();
    activeUserId = owner.id;
    saveUserList();
    openTabs = loadUserTabs(owner.id).paths;
    setStatus(`${projectName(r.root)} is under ${owner.label}: switched to it`);
  }
  if (!openTabs.some((t) => samePath(t, r.root))) openTabs.push(r.root);
  r.config = identityConfig(activeUser());
  lastInGroup.set(pathKey(groupOf(r.root)), r.root);
  if (!samePath(groupOf(r.root), r.root)) await loadRepoData(groupOf(r.root)).catch(() => null); // the repository's colour

  repo = r;
  status = null;
  headSignature = "";
  commits = [];
  expanded = null;
  expandedStash = null;
  branchFilter.value = "";
  clearDiff();

  const saved = tabStates.get(r.root.toLowerCase());
  commitMsg.value = saved?.message ?? "";
  amendBox.checked = saved?.amend ?? false;
  target = saved?.target ?? null; // re-shown by refresh() if still valid

  touchProject(r.root, r.name);
  const main = groupOf(r.root);
  document.title = `Hunkpad — ${projectName(main)}${samePath(main, r.root) ? "" : ` ⎇ ${folderName(r.root)}`}`;
  document.body.classList.add("has-repo");
  renderTabs();
  persistTabs();
  worktrees = [];
  // A linked worktree's index and HEAD are outside its folder: watch them too.
  const dirs = await r.gitDirs();
  await invoke("watch_repo", { repo: r.root, gitDir: dirs?.gitDir ?? null, commonDir: dirs?.commonDir ?? null });
  await showTab(saved?.sideTab ?? "changes");
  updateCommitAs().catch(showError);
  await refresh();
}

/** Back to the empty state: no tab active. */
function showNoRepo() {
  saveTabState();
  repo = null;
  status = null;
  clearDiff();
  commitMsg.value = "";
  amendBox.checked = false;
  for (const id of ["changes-list", "panel-history", "branch-list", "panel-stashes"]) $(id).replaceChildren();
  $("op-banner").classList.add("hidden");
  $("commit-as").replaceChildren();
  $("branch-btn").classList.add("hidden");
  $("sync-btn").classList.add("hidden");
  document.title = "Hunkpad";
  document.body.classList.remove("has-repo");
  invoke("unwatch_repo").catch(showError);
  renderTabs();
  persistTabs();
}

function closeTab(root: string) {
  const i = openTabs.findIndex((t) => samePath(t, root));
  if (i < 0) return;
  openTabs.splice(i, 1);
  tabStates.delete(root.toLowerCase());
  // The repository's tab keeps its place while another of its worktrees is open.
  const sibling = openTabs.findIndex((t) => samePath(groupOf(t), groupOf(root)));
  if (sibling > i) openTabs.splice(i, 0, ...openTabs.splice(sibling, 1));
  if (repo && samePath(repo.root, root)) {
    // Another open worktree of the same repository, else the neighbour, like a browser does.
    const next =
      openTabs.find((t) => samePath(groupOf(t), groupOf(root))) ?? openTabs[Math.min(i, openTabs.length - 1)];
    repo = null;
    if (next) openRepo(next).catch(showError);
    else showNoRepo();
  }
  renderTabs();
  persistTabs();
}

/** Ctrl+Tab goes from repository to repository (to the worktree last used in each). */
function cycleTab(step: number) {
  const groups = tabGroups();
  if (groups.length < 2 || !repo) return;
  const i = groups.findIndex((g) => samePath(g.main, groupOf(repo!.root)));
  openRepo(groupTarget(groups[(i + step + groups.length) % groups.length])).catch(showError);
}

function pickCustomColor(root: string) {
  const input = h("input", { type: "color", value: repoColor(root) ?? "#4c8eda", class: "hidden" });
  input.addEventListener("input", () => {
    setRepoColor(root, input.value);
    renderTabs();
  });
  input.addEventListener("change", () => input.remove());
  document.body.append(input);
  input.click();
}

/** A repository tab's menu: `root` is the main work tree, `members` its open worktree tabs. */
function tabMenu(root: string, members: string[]): MenuItem[] {
  const current = repoColor(root);
  return [
    ...REPO_COLORS.map(
      (c): MenuItem => ({
        label: `${c.name}${current?.toLowerCase() === c.value.toLowerCase() ? "  ✓" : ""}`,
        color: c.value,
        run: () => {
          setRepoColor(root, c.value);
          renderTabs();
        },
      }),
    ),
    { label: "Custom colour…", run: () => pickCustomColor(root) },
    {
      label: "No colour",
      run: () => {
        setRepoColor(root, null);
        renderTabs();
      },
    },
    "-",
    {
      label: "Rename…",
      run: async () => {
        const name = await promptInput("Tab name", projectName(root));
        if (!name) return;
        updateProject(root, { name });
        renderTabs();
        if (repo && samePath(repo.root, root)) document.title = `Hunkpad — ${name}`;
      },
    },
    { label: "Copy path", run: () => navigator.clipboard.writeText(root) },
    ...gitUsers
      .filter((u) => u.id !== activeUserId)
      .map((u): MenuItem => ({
        label: `Move to ${u.label}`,
        run: () => {
          const tabs = loadUserTabs(u.id);
          const add = members.filter((m) => !tabs.paths.some((p) => samePath(p, m)));
          saveUserTabs(u.id, [...tabs.paths, ...add], tabs.active ?? members[0]);
          closeGroup(members);
          setStatus(`${projectName(root)} moved to ${u.label}`);
        },
      })),
    "-",
    { label: members.length > 1 ? `Close (${members.length} worktrees)` : "Close", run: () => closeGroup(members) },
    {
      label: "Close others",
      run: () => {
        const keep = members.some((m) => repo && samePath(m, repo.root)) ? repo!.root : members[0];
        for (const t of openTabs.filter((t) => !members.some((m) => samePath(m, t)))) closeTab(t);
        if (!repo || !samePath(repo.root, keep)) openRepo(keep).catch(showError);
      },
    },
  ];
}

/** Frames the area below the tabs in the active repository's colour. */
function applyRepoColor() {
  const color = repo ? repoColor(groupOf(repo.root)) : null;
  document.body.classList.toggle("repo-colored", !!color);
  if (color) document.body.style.setProperty("--repo-color", color);
  else document.body.style.removeProperty("--repo-color");
}

// One tab per repository: the open worktrees of a repository share its tab,
// and the worktree bar below the tabs switches between them.

/** The main work tree of `root` (itself, unless it is a known linked worktree). */
const groupOf = (root: string) => worktreeMain.get(pathKey(root)) ?? root;

/** Open tabs grouped by repository, in the order each repository was first opened. */
function tabGroups(): { main: string; members: string[] }[] {
  const groups: { main: string; members: string[] }[] = [];
  for (const t of openTabs) {
    const main = groupOf(t);
    const g = groups.find((x) => samePath(x.main, main));
    if (g) g.members.push(t);
    else groups.push({ main, members: [t] });
  }
  return groups;
}

/** Each repository's worktree last shown (by pathKey of its main work tree). */
const lastInGroup = new Map<string, string>();

function groupTarget(g: { main: string; members: string[] }): string {
  const last = lastInGroup.get(pathKey(g.main));
  return g.members.find((m) => last && samePath(m, last)) ?? g.members[0];
}

/** Closes a repository's tab: all its open worktrees at once. */
function closeGroup(members: string[]) {
  const inGroup = (t: string) => members.some((m) => samePath(m, t));
  const index = tabGroups().findIndex((g) => g.members.some(inGroup));
  openTabs = openTabs.filter((t) => !inGroup(t));
  for (const m of members) tabStates.delete(m.toLowerCase());
  if (repo && inGroup(repo.root)) {
    // Activate the neighbouring repository, like a browser does.
    const rest = tabGroups();
    const next = rest[Math.min(index, rest.length - 1)];
    repo = null;
    if (next) openRepo(groupTarget(next)).catch(showError);
    else showNoRepo();
  }
  renderTabs();
  persistTabs();
}

function renderTabs() {
  applyRepoColor();
  renderUsers();
  renderScripts();
  renderWorktreeBar();
  $("repo-tabs").replaceChildren(
    ...tabGroups().map((g) => {
      const { main, members } = g;
      const active = !!repo && members.some((m) => samePath(m, repo!.root));
      const color = repoColor(main);
      const shown = active ? repo!.root : groupTarget(g);
      const branchNote = !samePath(shown, main) ? `\nShowing the worktree ${shown}` : "";
      const tab = h(
        "div",
        {
          class: `repo-tab${active ? " active" : ""}${color ? " colored" : ""}`,
          title: `${main}${branchNote}\nRight-click for colour and more`,
          onclick: () => !active && openRepo(groupTarget(g)).catch(showError),
          onauxclick: (e: MouseEvent) => e.button === 1 && closeGroup(members),
        },
        h("span", { class: "dot" }),
        h("span", { class: "name" }, projectName(main)),
        members.length > 1 ? h("span", { class: "wt", title: `${members.length} worktrees open` }, `⎇${members.length}`) : null,
        iconBtn("✕", members.length > 1 ? `Close this repository's ${members.length} worktree tabs` : keys("Close tab (Ctrl+W)"), () => closeGroup(members)),
      );
      if (color) tab.style.setProperty("--tab-color", color);
      return withContextMenu(tab, () => tabMenu(main, members));
    }),
  );
}

/** Under the tabs, for a repository with linked worktrees: one button per worktree. */
function renderWorktreeBar() {
  const bar = $("worktree-bar");
  const r = repo;
  const list = r && worktrees.length > 1 ? worktrees : [];
  bar.classList.toggle("hidden", !list.length);
  $("worktree-tabs").replaceChildren(
    ...list.map((w) => {
      const current = samePath(w.path, r!.root);
      const tab = openTabs.find((t) => samePath(t, w.path));
      const label = w.branch ?? `detached ${w.sha.slice(0, 7)}`;
      const el = h(
        "div",
        {
          class: `wt-tab${current ? " active" : ""}${tab ? " open" : ""}${w.prunable ? " missing" : ""}`,
          title: `${w.path}${w.main ? "\nMain worktree" : ""}${w.prunable ? "\nFolder missing: prune it from the Branches tab" : ""}${current ? "" : "\nClick to switch to it"}`,
          onclick: () => !current && openWorktree(w),
        },
        h("span", { class: "name" }, label),
        tab && !current ? iconBtn("✕", "Close this worktree's tab (the folder stays)", () => closeTab(tab)) : null,
      );
      return withContextMenu(el, () => worktreeMenu(w));
    }),
  );
}
$("add-worktree").addEventListener("click", () => newWorktreeFlow().catch(showError));
$("worktree-setup-btn").addEventListener("click", () => editSetup(mainPath()).catch(showError));

let refreshing: Promise<void> | null = null;
let refreshAgain = false;

/** Reloads status and the visible views. Coalesces overlapping calls. */
async function refresh(): Promise<void> {
  if (refreshing) {
    refreshAgain = true;
    return refreshing;
  }
  refreshing = (async () => {
    do {
      refreshAgain = false;
      await refreshOnce();
    } while (refreshAgain);
  })().finally(() => (refreshing = null));
  return refreshing;
}

async function refreshOnce() {
  if (!repo) return;
  const r = repo;
  const [s, wts] = await Promise.all([r.status(), r.worktrees()]);
  if (repo !== r) return; // switched tab meanwhile; the next pass handles the new one
  status = s;
  worktrees = wts;
  const main = wts.find((w) => w.main);
  if (noteWorktrees(wts) && main) await loadRepoData(main.path).catch(() => null);
  renderTabs();
  if (viewMode === "time") await loadFileTimes(r, s);
  await loadBlocks(r, s);
  if (repo !== r) return;
  const sig = `${status.oid}|${status.branch}`;
  const headMoved = sig !== headSignature;
  headSignature = sig;

  renderHeader();
  renderChanges();
  if (activeTab === "history" && (headMoved || !commits.length)) await loadHistory(true);
  if (activeTab === "branches") await loadBranches();
  if (activeTab === "stashes") await loadStashes();
  if (activeTab === "comments") await renderCommentsPanel();
  updateCommentsTab();

  const t = target;
  if (!t) return renderOverview();
  if (t.kind === "tree") return showDiff(t);
  if (t.kind === "blocks") return blocksOf(t.path, t.group).length ? showDiff(t) : clearDiff();
  // A comparison stays open even with no local changes left: it can still differ from the branch.
  if (t.kind === "vsref") return showDiff(t);
  const file = status.files.find((f) => f.path === t.path);
  const stillThere =
    file &&
    (t.kind === "index" ? !!file.staged : t.conflict ? !!file.conflict : !!file.unstaged && !file.conflict);
  if (stillThere) await showDiff(t);
  else clearDiff();
}

function renderHeader() {
  const s = status!;
  const branchBtn = $("branch-btn");
  branchBtn.classList.remove("hidden");
  branchBtn.textContent = `⎇ ${s.branch ?? `detached @ ${s.oid?.slice(0, 7) ?? "?"}`}`;
  const sync = $("sync-btn");
  sync.classList.toggle("hidden", !s.upstream);
  sync.textContent = `↓${s.behind} ↑${s.ahead}`;
  sync.title = `Synchronize with ${s.upstream}: pull, then push`;
  $("push-btn").textContent = s.upstream || !s.branch ? "Push" : "Publish";
}

// ---- Changes tab ----------------------------------------------------------

const commitMsg = $<HTMLTextAreaElement>("commit-msg");
const amendBox = $<HTMLInputElement>("amend-box");

const pathsOf = (files: FileChange[]) => files.flatMap((f) => (f.origPath ? [f.path, f.origPath] : [f.path]));

function unstage(files: FileChange[]) {
  act("Unstage", () => repo!.unstage(pathsOf(files), !status?.oid));
}

async function discard(files: FileChange[]) {
  if (!files.length) return;
  const untracked = files.filter((f) => f.unstaged === "U");
  const tracked = files.filter((f) => f.unstaged !== "U");
  const what = files.length === 1 ? files[0].path : `${files.length} files`;
  const extra = untracked.length ? " Untracked files will be deleted." : "";
  if (!(await confirmAction(`Discard all changes in ${what}?${extra} This cannot be undone.`))) return;
  act("Discard", () => repo!.discard(tracked.map((f) => f.path), untracked.map((f) => f.path)));
}

function acceptConflict(file: FileChange, side: "ours" | "theirs") {
  act(side === "ours" ? "Accept current" : "Accept incoming", () => repo!.acceptConflict(file.path, side));
}

function sectionHead(title: string, count: number, ...actions: HTMLElement[]) {
  return h("div", { class: "section-head" }, h("span", { class: "spacer" }, `${title} (${count})`), ...actions);
}

function fileItem(
  path: string,
  statusLetter: string,
  statusClass: string,
  t: DiffTarget,
  actions: HTMLElement[],
  menu?: () => MenuItem[],
) {
  const slash = path.lastIndexOf("/");
  const el = h(
    "div",
    { class: "item", title: path, onclick: () => showDiff(t).catch(showError) },
    h("span", { class: `status ${statusClass}` }, statusLetter),
    h("span", { class: "name" }, path.slice(slash + 1)),
    h("span", { class: "dir" }, slash >= 0 ? path.slice(0, slash) : ""),
    h("span", { class: "actions" }, ...actions),
  );
  el.dataset.target = targetKey(t);
  return menu ? withContextMenu(el, menu) : el;
}

function renderChanges() {
  const s = status!;
  const r = repo!;

  const banner = $("op-banner");
  banner.replaceChildren();
  banner.classList.toggle("hidden", !s.operation);
  if (s.operation) {
    const op = s.operation;
    banner.append(
      h("span", { class: "spacer" }, `${op[0].toUpperCase()}${op.slice(1)} in progress`),
      h("button", { onclick: () => act(`Continue ${op}`, () => r.continueOperation(op)) }, "Continue"),
    );
    if (op === "rebase") banner.append(h("button", { onclick: () => act("Skip commit", () => r.skipRebaseStep()) }, "Skip"));
    banner.append(h("button", { onclick: () => act(`Abort ${op}`, () => r.abortOperation(op)) }, "Abort"));
  }

  const conflicts = s.files.filter((f) => f.conflict);
  const staged = s.files.filter((f) => f.staged && !f.conflict);
  const unstagedAll = s.files.filter((f) => f.unstaged && !f.conflict);
  const list = $("changes-list");
  list.replaceChildren();

  if (conflicts.length) {
    list.append(
      sectionHead("Merge changes", conflicts.length),
      ...conflicts.map((f) =>
        fileItem(f.path, "!", "conflict", { kind: "worktree", path: f.path, conflict: true }, [
          iconBtn("◀", "Accept current (ours)", () => acceptConflict(f, "ours")),
          iconBtn("▶", "Accept incoming (theirs)", () => acceptConflict(f, "theirs")),
          ...(claudeOn ? [iconBtn("✨", "Suggest a resolution with Claude", () => resolveConflictWithClaude(f))] : []),
          iconBtn("+", "Mark resolved (stage)", () => act("Mark resolved", () => r.stage([f.path]))),
        ]),
      ),
    );
  }

  // Two roots, always shown: what Git will commit (Staged) and what it will not yet (Unstaged).
  list.append(
    rootHead("Staged", staged.length, "staged", iconBtn("⧉", "Copy diff + comments (Markdown, for an LLM)", copyStaged), iconBtn("−", "Unstage all", () => unstage(staged))),
  );
  if (!collapsedNodes.has("root|staged")) {
    if (staged.length) list.append(...arrange(staged, (f) => stagedItem(f), "staged"));
    else list.append(h("div", { class: "empty indent" }, "Nothing staged."));
  }

  // Unstaged: with local groups, every change *block* belongs to one group
  // (see hunks.ts); a file shows up in each group that owns some of its blocks.
  // Files "Kept local" are listed apart and left out of every stage/discard-all.
  const groups = loadGroups(r.root);
  const active = loadHunkState(r.root).active;
  const keptPaths = loadKeptLocal(r.root);
  const kept = new Set(keptPaths);
  const keptFiles = unstagedAll.filter((f) => kept.has(f.path));
  const unstaged = unstagedAll.filter((f) => !kept.has(f.path));
  list.append(
    rootHead(
      "Unstaged",
      unstaged.length, // kept-local files are counted under their own root
      "unstaged",
      iconBtn("⧉", "Copy diff + comments (Markdown, for an LLM)", copyUnstaged),
      ...(claudeOn ? [iconBtn("✨", "Organize into groups with Claude", organizeWithClaude)] : []),
      iconBtn("⊞", "New group (becomes the active group)", () => newGroup()),
      iconBtn("↶", "Discard all unstaged changes", () => discard(unstaged)),
      iconBtn("+", "Stage all unstaged changes", () => act("Stage all", () => r.stage(pathsOf(unstaged)))),
    ),
  );

  if (!collapsedNodes.has("root|unstaged")) {
    if (!groups.length) {
      list.append(...arrange(unstaged, (f) => unstagedItem(r, f), "ungrouped"));
      if (!unstaged.length) list.append(h("div", { class: "empty indent" }, "No unstaged changes."));
    } else {
      for (const g of groups) {
        const files = unstaged.filter((f) => blocksOf(f.path, g.id).length);
        list.append(groupHead(g, files, active === g.id));
        if (g.collapsed) continue;
        list.append(...nested(arrange(files, (f) => blockFileRow(r, f, g.id), `group:${g.id}`)));
        if (!files.length) {
          list.append(h("div", { class: "empty indent" }, "No changes: drag changes here, or set this group active and edit."));
        }
      }
      // Files without block information (e.g. only the file mode changed) count as ungrouped.
      const ungrouped = unstaged.filter((f) => blocksOf(f.path, null).length || !hunkMap.has(f.path));
      list.append(ungroupedHead(ungrouped, active === null));
      list.append(...nested(arrange(ungrouped, (f) => blockFileRow(r, f, null), "ungrouped")));
    }
  }

  // Third root, always shown next to Staged and Unstaged.
  const hasData = hasRepoData(r.root);
  list.append(keptHead(keptPaths.length + (hasData ? 1 : 0)));
  if (!collapsedNodes.has("root|kept")) {
    // Hunkpad's own folder: always kept local (it ignores itself for Git).
    if (hasData) list.append(dataFolderRow());
    list.append(...arrange(keptFiles, (f) => keptRow(f), "kept"));
    // Still kept, but no changes right now: listed so they can be removed.
    const idle = keptPaths.filter((p) => !keptFiles.some((f) => f.path === p));
    list.append(...idle.map(keptIdleRow));
    if (!keptPaths.length && !hasData) {
      list.append(
        h("div", { class: "empty indent" }, "Nothing kept local. Right-click a changed file → Keep local, or drag it here."),
      );
    }
  }
  markSelected();
}

// ---- Kept local (never staged; projects.ts) ---------------------------------

const isKept = (path: string) =>
  !!repo && (path.startsWith(`${DATA_DIR}/`) || loadKeptLocal(repo.root).includes(path));

/** The permanent row for .hunkpad/: Hunkpad's data folder, never committed. */
function dataFolderRow() {
  return h(
    "div",
    {
      class: "item kept idle",
      title:
        `${DATA_DIR}/ holds this repository's Hunkpad data (colour, groups, Kept local, scripts).\n` +
        `Its own ${DATA_DIR}/.gitignore ("*") makes Git ignore the whole folder: always kept local, never committed.`,
    },
    h("span", { class: "status" }, "🔒"),
    h("span", { class: "name" }, `${DATA_DIR}/`),
    h("span", { class: "dir" }, "Hunkpad data · ignored by Git"),
  );
}

function keepLocal(paths: string[]) {
  if (!repo) return;
  saveKeptLocal(repo.root, [...loadKeptLocal(repo.root), ...paths]);
  setStatus(`Kept local (never staged): ${paths.join(", ")}`);
  refresh().catch(showError);
}

function stopKeepingLocal(path: string) {
  if (!repo) return;
  saveKeptLocal(repo.root, loadKeptLocal(repo.root).filter((p) => p !== path));
  setStatus(`${path} is back in Unstaged`);
  refresh().catch(showError);
}

const KEPT_TITLE =
  "Kept local: changes that stay on this machine and are never staged or committed by Hunkpad " +
  "(e.g. local settings). Unlike .gitignore, nothing is written to the repository; " +
  "a file stays here until you remove it.";

function keptHead(count: number) {
  // Same look and collapse behaviour as the Staged / Unstaged roots.
  const head = rootHead("🔒 Kept local", count, "kept", iconBtn("⧉", "Copy diff + comments (Markdown, for an LLM)", copyKept));
  head.title = KEPT_TITLE;
  // Dropping a file row here keeps that file local.
  head.addEventListener("dragover", (e) => {
    if (!e.dataTransfer?.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    head.classList.add("drop");
  });
  head.addEventListener("dragleave", () => head.classList.remove("drop"));
  head.addEventListener("drop", (e) => {
    e.preventDefault();
    head.classList.remove("drop");
    const data = e.dataTransfer?.getData(DRAG_TYPE);
    if (data) keepLocal([(JSON.parse(data) as { path: string }).path]);
  });
  return head;
}

function keptRow(f: FileChange) {
  const row = fileItem(
    f.path,
    f.unstaged!,
    f.unstaged!,
    { kind: "worktree", path: f.path, conflict: false },
    [
      iconBtn("↩", "Stop keeping local (back to Unstaged)", () => stopKeepingLocal(f.path)),
      iconBtn("↶", "Discard changes", () => discard([f])),
    ],
    () => [
      { label: "Stop keeping local", run: () => stopKeepingLocal(f.path) },
      { label: "Copy diff + comments (for LLM)", run: () => copyFile(f, "kept") },
      { label: "Discard changes…", run: () => discard([f]) },
      ...fileMenu(f.path),
    ],
  );
  row.classList.add("kept");
  return row;
}

function keptIdleRow(path: string) {
  const slash = path.lastIndexOf("/");
  return h(
    "div",
    { class: "item kept idle", title: `${path}\nKept local, no changes right now` },
    h("span", { class: "status" }, "·"),
    h("span", { class: "name" }, path.slice(slash + 1)),
    h("span", { class: "dir" }, slash >= 0 ? path.slice(0, slash) : ""),
    h("span", { class: "actions" }, iconBtn("✕", "Remove from Kept local", () => stopKeepingLocal(path))),
  );
}

/** Marks rows as one level deeper (under a group or "Ungrouped"). */
const nested = (rows: HTMLElement[]) => rows.map((row) => (row.classList.add("nested"), row));

/** A top-level section (Staged / Unstaged): always shown, collapsible. */
function rootHead(title: string, count: number, key: string, ...actions: HTMLElement[]) {
  const nodeKey = `root|${key}`;
  const collapsed = collapsedNodes.has(nodeKey);
  return h(
    "div",
    {
      class: "section-head root-head",
      onclick: () => {
        if (collapsed) collapsedNodes.delete(nodeKey);
        else collapsedNodes.add(nodeKey);
        renderChanges();
      },
    },
    h("span", { class: "chevron" }, collapsed ? "▸" : "▾"),
    h("span", { class: "spacer" }, `${title} (${count})`),
    ...actions,
  );
}

function stagedItem(f: FileChange) {
  return fileItem(
    f.path,
    f.staged!,
    f.staged!,
    { kind: "index", path: f.path, origPath: f.origPath },
    [iconBtn("−", "Unstage", () => unstage([f]))],
    () => [
      { label: "Unstage", run: () => unstage([f]) },
      { label: "Copy diff + comments (for LLM)", run: () => copyFile(f, "staged") },
      {
        label: "Unstage and keep local",
        run: () =>
          act("Keep local", async () => {
            await repo!.unstage(pathsOf([f]), !status?.oid);
            keepLocal([f.path]);
          }),
      },
      ...fileMenu(f.path),
    ],
  );
}

/** A whole-file unstaged row (used when there are no groups). */
function unstagedItem(r: Repo, f: FileChange) {
  return draggableBlocks(fileItem(
    f.path,
    f.unstaged!,
    f.unstaged!,
    { kind: "worktree", path: f.path, conflict: false },
    [
      iconBtn("↶", "Discard changes", () => discard([f])),
      iconBtn("+", "Stage", () => act("Stage", () => r.stage([f.path]))),
    ],
    () => [
      { label: "Stage", run: () => act("Stage", () => r.stage([f.path])) },
      { label: "Discard changes", run: () => discard([f]) },
      { label: "Keep local (never stage)", run: () => keepLocal([f.path]) },
      { label: "Copy diff + comments (for LLM)", run: () => copyFile(f, "unstaged") },
      ...fileMenu(f.path),
    ],
  ), f.path, null);
}

function fileMenu(path: string): MenuItem[] {
  return ["-", { label: "Copy path", run: () => navigator.clipboard.writeText(path) }];
}

async function commit() {
  if (!repo || !status) return;
  const r = repo;
  const s = status;
  const message = commitMsg.value.trim();
  const amend = amendBox.checked;
  const done = () => {
    commitMsg.value = "";
    amendBox.checked = false;
  };

  if (s.operation === "merge" && !message) {
    return act("Commit merge", async () => {
      await r.continueOperation("merge");
      done();
    });
  }
  if (!message) {
    setStatus("Enter a commit message", true);
    commitMsg.focus();
    return;
  }
  const hasStaged = s.files.some((f) => f.staged && !f.conflict);
  if (!hasStaged && !amend) {
    const unstaged = s.files.filter((f) => f.unstaged && !f.conflict && !isKept(f.path));
    if (!unstaged.length) return setStatus("Nothing to commit", true);
    if (!(await ask("There are no staged changes. Stage all changes (except Kept local) and commit them?", { title: "Hunkpad" }))) return;
    return act("Commit", async () => {
      await r.stage(pathsOf(unstaged));
      await r.commit(message, false);
      done();
    });
  }
  return act(amend ? "Amend commit" : "Commit", async () => {
    await r.commit(message, amend);
    done();
  });
}

$("commit-btn").addEventListener("click", () => commit());
commitMsg.addEventListener("keydown", (e) => {
  if (primaryKey(e) && e.key === "Enter") {
    e.preventDefault();
    commit();
  }
});
amendBox.addEventListener("change", async () => {
  if (amendBox.checked && repo && !commitMsg.value.trim()) commitMsg.value = await repo.lastCommitMessage();
});

// ---- change groups: block level, local only (hunks.ts, projects.ts) --------
//
// Like IntelliJ's partial changelists: each unstaged change block belongs to a
// group; new blocks go to the active group. Stored only in the app.

/** Current unstaged blocks per file, each with its group (null = Ungrouped). */
let hunkMap = new Map<string, { hunk: Hunk; group: string | null }[]>();

const blocksOf = (path: string, group: string | null) =>
  (hunkMap.get(path) ?? []).filter((x) => x.group === group).map((x) => x.hunk);
const allBlocksOf = (path: string) => (hunkMap.get(path) ?? []).map((x) => x.hunk);
const lossy = (...texts: string[]) => texts.some((t) => t.includes("�") || t.includes("\0"));

/** Recomputes the blocks and follows each one to its group (only when groups exist). */
async function loadBlocks(r: Repo, s: RepoStatus) {
  const groups = loadGroups(r.root);
  if (!groups.length) {
    hunkMap = new Map();
    return;
  }
  const kept = new Set(loadKeptLocal(r.root));
  const unstaged = s.files.filter((f) => f.unstaged && !f.conflict && !kept.has(f.path));
  const wanted = new Set(unstaged.map((f) => f.path));
  const parsed = parseDiffU0(await r.diffU0()).filter((h) => wanted.has(h.path));
  for (const f of unstaged) if (f.unstaged === "U") parsed.push(wholeFileHunk(f.path, "untracked"));
  if (repo !== r) return;

  const state = loadHunkState(r.root);
  const valid = new Set(groups.map((g) => g.id));
  const active = state.active && valid.has(state.active) ? state.active : null;
  // Groups from the earlier file-level version: their files' blocks start in them.
  const legacy = new Map(groups.flatMap((g) => g.files.map((p): [string, string] => [p, g.id])));

  const byPath = new Map<string, Hunk[]>();
  for (const hk of parsed) byPath.set(hk.path, [...(byPath.get(hk.path) ?? []), hk]);
  const map = new Map<string, { hunk: Hunk; group: string | null }[]>();
  const next: HunkAssignment[] = [];
  for (const [path, hunks] of byPath) {
    const stored = state.hunks.filter((a) => a.path === path);
    const resolved = stored.length
      ? resolveGroups(hunks, stored, active)
      : hunks.map(() => legacy.get(path) ?? active);
    const groupsOfHunks = resolved.map((g) => (g && valid.has(g) ? g : null));
    map.set(path, hunks.map((hunk, i) => ({ hunk, group: groupsOfHunks[i] })));
    next.push(...hunks.map((hk, i) => assignmentOf(hk, groupsOfHunks[i])));
  }
  if (legacy.size) saveGroups(r.root, groups.map((g) => ({ ...g, files: [] })));
  saveHunkState(r.root, { active, hunks: next });
  hunkMap = map;
}

function setActiveGroup(id: string | null) {
  if (!repo) return;
  saveHunkState(repo.root, { ...loadHunkState(repo.root), active: id });
  renderChanges();
}

/** Moves blocks to a group (null = Ungrouped). */
function assignBlocks(blocks: Hunk[], to: string | null) {
  if (!repo || !blocks.length) return;
  const state = loadHunkState(repo.root);
  for (const a of state.hunks) if (blocks.some((b) => sameHunk(a, b))) a.group = to;
  saveHunkState(repo.root, state);
  refresh().catch(showError);
}

async function newGroup(onCreated?: (id: string) => void) {
  const name = await promptInput("Group name", defaultGroupName());
  if (!name || !repo) return;
  const id = newUserId();
  saveGroups(repo.root, [...loadGroups(repo.root), { id, name, files: [] }]);
  if (onCreated) onCreated(id);
  else setActiveGroup(id); // a group made from the ⊞ button is where the next edits go
  refresh().catch(showError);
}

function updateGroups(fn: (groups: ChangeGroup[]) => ChangeGroup[]) {
  if (!repo) return;
  saveGroups(repo.root, fn(loadGroups(repo.root)));
  if (status) renderChanges();
}

function deleteGroup(g: ChangeGroup) {
  if (!repo) return;
  const state = loadHunkState(repo.root);
  for (const a of state.hunks) if (a.group === g.id) a.group = null;
  if (state.active === g.id) state.active = null;
  saveHunkState(repo.root, state);
  updateGroups((groups) => groups.filter((x) => x.id !== g.id));
  refresh().catch(showError);
}

function moveBlocksMenu(blocks: Hunk[], current: string | null): MenuItem[] {
  return [
    ...currentGroups()
      .filter((g) => g.id !== current)
      .map((g): MenuItem => ({ label: `Move to “${g.name}”`, run: () => assignBlocks(blocks, g.id) })),
    ...(current !== null ? [{ label: "Move to Ungrouped", run: () => assignBlocks(blocks, null) }] : []),
    { label: "Move to new group…", run: () => newGroup((id) => assignBlocks(blocks, id)) },
  ];
}

const currentGroups = () => (repo ? loadGroups(repo.root) : []);

async function readSidesForBlocks(r: Repo, path: string) {
  const index = (await r.showAsWorktree(`:${path}`)) ?? "";
  const work = (await r.readWorktree(path)) ?? "";
  if (lossy(index, work)) throw new Error(`${path} is binary or not UTF-8: use whole-file actions`);
  return { index, work };
}

/** All of the file's blocks (or an unsplittable one): stage/discard it as a whole file. */
const isWholeFile = (path: string, blocks: Hunk[]) =>
  blocks.length === allBlocksOf(path).length || blocks.some((b) => b.whole);

/**
 * Stages blocks of many files with at most two Git commands, so a group is not
 * one approval per file: whole files → one `git add`; partial files → their new
 * versions are prepared quietly, then written with one `update-index --index-info`.
 */
async function stageBlocksBatch(r: Repo, files: [string, Hunk[]][]) {
  const whole: string[] = [];
  const partial: IndexEntry[] = [];
  for (const [path, blocks] of files) {
    if (!blocks.length) continue;
    if (isWholeFile(path, blocks)) {
      whole.push(path);
      continue;
    }
    const { index, work } = await readSidesForBlocks(r, path);
    partial.push(await r.blobFor(path, applyLineChanges(index, work, blocks.map(toLineChange))));
  }
  if (whole.length) await r.stage(whole);
  if (partial.length) await r.setIndexEntries(partial);
}

/**
 * Reverts blocks of many files: whole tracked files → one `git restore`, whole
 * new files → one `git clean`; partial files are rewritten directly (no Git command).
 */
async function discardBlocksBatch(r: Repo, files: [string, Hunk[]][]) {
  const tracked: string[] = [];
  const untracked: string[] = [];
  for (const [path, blocks] of files) {
    if (!blocks.length) continue;
    if (isWholeFile(path, blocks)) {
      (status?.files.find((f) => f.path === path)?.unstaged === "U" ? untracked : tracked).push(path);
      continue;
    }
    const keep = allBlocksOf(path).filter((b) => !blocks.includes(b));
    const { index, work } = await readSidesForBlocks(r, path);
    await r.writeWorktree(path, applyLineChanges(index, work, keep.map(toLineChange)));
  }
  await r.discard(tracked, untracked);
}

const stageBlocksRaw = (r: Repo, path: string, blocks: Hunk[]) => stageBlocksBatch(r, [[path, blocks]]);
const discardBlocksRaw = (r: Repo, path: string, blocks: Hunk[]) => discardBlocksBatch(r, [[path, blocks]]);

function stageBlocks(path: string, blocks: Hunk[]) {
  act("Stage changes", () => stageBlocksRaw(repo!, path, blocks));
}

async function discardBlocks(path: string, blocks: Hunk[]) {
  const n = blocks.length;
  if (!(await confirmAction(`Discard ${n} change block${n === 1 ? "" : "s"} in ${path}? This cannot be undone.`))) return;
  act("Discard changes", () => discardBlocksRaw(repo!, path, blocks));
}

/** Files with blocks in group `g`, with those blocks. */
function groupFiles(g: string | null): [string, Hunk[]][] {
  return [...hunkMap.keys()].map((p): [string, Hunk[]] => [p, blocksOf(p, g)]).filter(([, b]) => b.length);
}

async function commitGroup(g: ChangeGroup) {
  const r = repo;
  if (!r || !status) return;
  if (status.operation) return setStatus(`Finish or abort the ${status.operation} before committing a group`, true);
  const files = groupFiles(g.id);
  if (!files.length) return setStatus(`“${g.name}” has no changes to commit`, true);
  const typed = commitMsg.value.trim();
  let message = typed;
  if (!message && g.message) {
    const use = await ask(`Commit “${g.name}” with this message?\n\n${g.message}`, {
      title: "Hunkpad",
      okLabel: "Commit",
      cancelLabel: "Edit first",
    });
    if (!use) {
      commitMsg.value = g.message;
      commitMsg.focus();
      return setStatus(`Edit the message, then choose Commit this group (✓) again`);
    }
    message = g.message;
  }
  message ||= (await promptInput(`Commit message for “${g.name}”`, g.name)) ?? "";
  if (!message) return;
  if ((await commitGroupNow(g, files, message)) === "done" && typed) commitMsg.value = "";
}

/** Commits exactly the group's blocks with `message` (a temporary index), then deletes the group. */
async function commitGroupNow(g: ChangeGroup, files: [string, Hunk[]][], message: string): Promise<Outcome> {
  const r = repo!;
  const unborn = !status?.oid;
  return act(`Commit “${g.name}”`, async () => {
    const entries: CommitEntry[] = [];
    for (const [path, blocks] of files) {
      const whole = blocks.length === allBlocksOf(path).length || blocks.some((b) => b.whole);
      if (whole) {
        const deleted = status?.files.find((f) => f.path === path)?.unstaged === "D";
        entries.push(deleted ? { path, deleted: true } : { path });
      } else {
        const { index, work } = await readSidesForBlocks(r, path);
        entries.push({ path, content: applyLineChanges(index, work, blocks.map(toLineChange)) });
      }
    }
    await r.commitEntries(message, entries, unborn);
    deleteGroup(g);
  });
}

async function stageGroup(g: string | null): Promise<Outcome> {
  const files = groupFiles(g);
  return act("Stage group", () => stageBlocksBatch(repo!, files));
}

async function discardGroup(g: string | null, name: string) {
  const files = groupFiles(g);
  const n = files.reduce((sum, [, b]) => sum + b.length, 0);
  if (!n) return;
  if (!(await confirmAction(`Discard ${n} change block(s) of “${name}” in ${files.length} file(s)? This cannot be undone.`))) return;
  await act("Discard group", () => discardBlocksBatch(repo!, files));
}

function groupHeadMenu(g: ChangeGroup, isActive: boolean): MenuItem[] {
  return [
    isActive
      ? { label: "Active: new changes go here", run: () => {} }
      : { label: "Set as active (new changes go here)", run: () => setActiveGroup(g.id) },
    "-",
    { label: "Commit this group…", run: () => commitGroup(g) },
    ...(claudeOn ? [{ label: "✨ Draft commit message with Claude", run: () => draftGroupMessage(g) }] : []),
    { label: "Copy diff + comments (for LLM)", run: () => copyGroup(g.id, g.name) },
    { label: "Stage this group", run: () => stageGroup(g.id) },
    { label: "Discard this group’s changes…", run: () => discardGroup(g.id, g.name) },
    "-",
    {
      label: "Rename…",
      run: async () => {
        const name = await promptInput("Group name", g.name);
        if (name) updateGroups((groups) => groups.map((x) => (x.id === g.id ? { ...x, name } : x)));
      },
    },
    { label: "Delete group (changes move to Ungrouped)", run: () => deleteGroup(g) },
  ];
}

const blockCount = (files: FileChange[], g: string | null) =>
  files.reduce((n, f) => n + blocksOf(f.path, g).length, 0);

function groupHead(g: ChangeGroup, files: FileChange[], isActive: boolean) {
  const blocks = blockCount(files, g.id);
  const head = h(
    "div",
    {
      class: `section-head group-head child-head${isActive ? " active-group" : ""}`,
      title:
        "Local group: only on this machine, never committed or pushed." +
        (isActive ? "\nActive: new change blocks go here." : "\nRight-click → Set as active to send new changes here."),
      onclick: () => updateGroups((groups) => groups.map((x) => (x.id === g.id ? { ...x, collapsed: !x.collapsed } : x))),
    },
    h("span", { class: "chevron" }, g.collapsed ? "▸" : "▾"),
    h(
      "span",
      { class: "spacer" },
      isActive ? h("span", { class: "active-dot", title: "Active group" }, "● ") : null,
      `${g.name} (${files.length})`,
      blocks !== files.length ? h("span", { class: "muted" }, ` · ${blocks} changes`) : null,
    ),
    iconBtn("✓", "Commit only this group’s changes (staged parts of the same files are included)", () => commitGroup(g)),
    iconBtn("↶", "Discard this group’s changes", () => discardGroup(g.id, g.name)),
    iconBtn("+", "Stage this group’s changes", () => stageGroup(g.id)),
    menuButton(() => groupHeadMenu(g, isActive)),
  );
  return withContextMenu(dropTarget(head, g.id), () => groupHeadMenu(g, isActive));
}

function ungroupedHead(files: FileChange[], isActive: boolean) {
  const menu = (): MenuItem[] => [
    isActive
      ? { label: "Active: new changes go here", run: () => {} }
      : { label: "Set as active (new changes go here)", run: () => setActiveGroup(null) },
    "-",
    { label: "Stage these changes", run: () => stageGroup(null) },
    { label: "Copy diff + comments (for LLM)", run: () => copyGroup(null, "Ungrouped") },
    { label: "Discard these changes…", run: () => discardGroup(null, "Ungrouped") },
  ];
  const head = sectionHead(
    "Ungrouped",
    files.length,
    iconBtn("↶", "Discard these changes", () => discardGroup(null, "Ungrouped")),
    iconBtn("+", "Stage these changes", () => stageGroup(null)),
    menuButton(menu),
  );
  head.classList.add("child-head");
  if (isActive) head.firstElementChild!.prepend(h("span", { class: "active-dot", title: "Active group" }, "● "));
  return withContextMenu(dropTarget(head, null), menu);
}

/** A file row inside a group: only that group's blocks of the file. */
function blockFileRow(r: Repo, f: FileChange, group: string | null) {
  const all = allBlocksOf(f.path);
  if (!all.length) return unstagedItem(r, f); // no block information
  const mine = blocksOf(f.path, group);
  const row = fileItem(
    f.path,
    f.unstaged!,
    f.unstaged!,
    { kind: "blocks", path: f.path, group },
    [
      iconBtn("↶", "Discard these changes", () => discardBlocks(f.path, mine)),
      iconBtn("+", "Stage these changes", () => stageBlocks(f.path, mine)),
    ],
    () => [
      { label: "Stage these changes", run: () => stageBlocks(f.path, mine) },
      { label: "Discard these changes…", run: () => discardBlocks(f.path, mine) },
      "-",
      ...moveBlocksMenu(mine, group),
      "-",
      { label: "Keep local (never stage the whole file)", run: () => keepLocal([f.path]) },
      {
        label: "Copy diff + comments (for LLM)",
        run: () => copyFile(f, { group, name: group ? (currentGroups().find((g) => g.id === group)?.name ?? "group") : "Ungrouped" }),
      },
      ...fileMenu(f.path),
    ],
  );
  if (mine.length < all.length) {
    const part = h(
      "span",
      { class: "part", title: `${mine.length} of ${all.length} change blocks of this file are in this group` },
      `${mine.length}/${all.length}`,
    );
    row.insertBefore(part, row.querySelector(".actions"));
  }
  return draggableBlocks(row, f.path, group);
}

const DRAG_TYPE = "application/x-hunkpad-blocks";

/** Dragging a row carries that row's blocks (one file, one group). */
function draggableBlocks<T extends HTMLElement>(el: T, path: string, group: string | null): T {
  el.draggable = true;
  el.addEventListener("dragstart", (e) => {
    e.dataTransfer!.setData(DRAG_TYPE, JSON.stringify({ path, group }));
    e.dataTransfer!.effectAllowed = "move";
  });
  return el;
}

/** A group header that accepts dropped rows (groupId null = Ungrouped). */
function dropTarget<T extends HTMLElement>(el: T, groupId: string | null): T {
  el.addEventListener("dragover", (e) => {
    if (!e.dataTransfer?.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    el.classList.add("drop");
  });
  el.addEventListener("dragleave", () => el.classList.remove("drop"));
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    el.classList.remove("drop");
    const data = e.dataTransfer?.getData(DRAG_TYPE);
    if (!data) return;
    const { path, group } = JSON.parse(data) as { path: string; group: string | null };
    if (group !== groupId) assignBlocks(blocksOf(path, group), groupId);
  });
  return el;
}

// ---- view mode: list / folders / time --------------------------------------
//
// Arranges the files *inside* each section; it never changes which local change
// group a file belongs to.

type ViewMode = "list" | "folder" | "time";

function loadViewMode(): ViewMode {
  try {
    const v = settings.getItem("viewMode");
    return v === "folder" || v === "time" ? v : "list";
  } catch {
    return "list";
  }
}

let viewMode: ViewMode = loadViewMode();
/** Collapsed folder / time-bucket rows, keyed by section + node. In memory only. */
const collapsedNodes = new Set<string>();
/** Last-modified time per path (ms), null = file missing (deleted). */
let fileTimes = new Map<string, number | null>();

async function loadFileTimes(r: Repo, s: RepoStatus) {
  const paths = s.files.map((f) => f.path);
  const times = await invoke<(number | null)[]>("file_times", { repo: r.root, paths });
  if (repo === r) fileTimes = new Map(paths.map((p, i) => [p, times[i]]));
}

async function setViewMode(mode: ViewMode) {
  viewMode = mode;
  try {
    settings.setItem("viewMode", mode);
  } catch {
    // just won't be remembered
  }
  document.querySelectorAll<HTMLElement>("#view-mode button").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  if (repo && status) {
    if (mode === "time") await loadFileTimes(repo, status);
    renderChanges();
  }
}

document.querySelectorAll<HTMLElement>("#view-mode button").forEach((b) =>
  b.addEventListener("click", () => setViewMode(b.dataset.mode as ViewMode).catch(showError)),
);
document.querySelectorAll<HTMLElement>("#view-mode button").forEach((b) => b.classList.toggle("active", b.dataset.mode === viewMode));

// Time buckets age while the window is open: re-sort every minute.
setInterval(() => viewMode === "time" && repo && status && renderChanges(), 60_000);

function subHead(label: string, count: number, key: string, depth: number, title = "") {
  const collapsed = collapsedNodes.has(key);
  const el = h(
    "div",
    {
      class: "sub-head",
      title: title || label,
      onclick: () => {
        if (collapsed) collapsedNodes.delete(key);
        else collapsedNodes.add(key);
        renderChanges();
      },
    },
    h("span", { class: "chevron" }, collapsed ? "▸" : "▾"),
    h("span", { class: "name" }, label),
    h("span", { class: "count" }, String(count)),
  );
  el.style.paddingLeft = `${10 + depth * 14}px`;
  return el;
}

/** Indents a file row in a tree and drops its folder text (the tree shows it). */
function indentRow(row: HTMLElement, depth: number, hideDir: boolean) {
  row.style.paddingLeft = `${10 + depth * 14}px`;
  if (hideDir) row.querySelector(".dir")!.textContent = "";
  return row;
}

/** Lays out one section's files according to the view mode. */
function arrange(files: FileChange[], makeRow: (f: FileChange) => HTMLElement, section: string): HTMLElement[] {
  if (viewMode === "folder") return folderTree(files, makeRow, section);
  if (viewMode === "time") return timeBuckets(files, makeRow, section);
  return files.map(makeRow);
}

interface FolderNode {
  name: string;
  path: string;
  folders: Map<string, FolderNode>;
  files: FileChange[];
}

function folderTree(files: FileChange[], makeRow: (f: FileChange) => HTMLElement, section: string): HTMLElement[] {
  const root: FolderNode = { name: "", path: "", folders: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    parts.pop();
    let node = root;
    for (const part of parts) {
      const path = node.path ? `${node.path}/${part}` : part;
      if (!node.folders.has(part)) node.folders.set(part, { name: part, path, folders: new Map(), files: [] });
      node = node.folders.get(part)!;
    }
    node.files.push(f);
  }

  // Compact chains of single-child folders: "source/BoardGenAI/McpServer" is one row.
  const compact = (node: FolderNode): FolderNode => {
    let n = node;
    while (n.files.length === 0 && n.folders.size === 1) {
      const only = [...n.folders.values()][0];
      n = { ...only, name: `${n.name}/${only.name}` };
    }
    return { ...n, folders: new Map([...n.folders].map(([k, child]) => [k, compact(child)])) };
  };
  const count = (node: FolderNode): number =>
    node.files.length + [...node.folders.values()].reduce((n, c) => n + count(c), 0);

  const rows: HTMLElement[] = [];
  const walk = (node: FolderNode, depth: number) => {
    const folders = [...node.folders.values()].map(compact).sort((a, b) => a.name.localeCompare(b.name));
    for (const child of folders) {
      const key = `${section}|dir|${child.path}`;
      rows.push(subHead(child.name, count(child), key, depth, child.path));
      if (!collapsedNodes.has(key)) walk(child, depth + 1);
    }
    for (const f of [...node.files].sort((a, b) => a.path.localeCompare(b.path))) {
      rows.push(indentRow(makeRow(f), depth, true));
    }
  };
  // The root is never a row itself; its children (compacted) are the top level.
  walk(root, 0);
  return rows;
}

const MINUTE = 60_000;

function timeBucket(ms: number | null | undefined, now: number): string {
  if (ms === null || ms === undefined) return "Deleted / no date";
  const age = now - ms;
  if (age < 5 * MINUTE) return "Last 5 minutes";
  if (age < 30 * MINUTE) return "Last 30 minutes";
  if (age < 60 * MINUTE) return "Last hour";
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (ms >= startOfToday) return "Today";
  if (ms >= startOfToday - 24 * 60 * MINUTE) return "Yesterday";
  if (ms >= startOfToday - 7 * 24 * 60 * MINUTE) return "Last 7 days";
  return "Older";
}

const BUCKET_ORDER = [
  "Last 5 minutes",
  "Last 30 minutes",
  "Last hour",
  "Today",
  "Yesterday",
  "Last 7 days",
  "Older",
  "Deleted / no date",
];

function shortAge(ms: number, now: number): string {
  const min = Math.max(0, Math.round((now - ms) / MINUTE));
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  if (min < 24 * 60) return `${Math.round(min / 60)}h`;
  return `${Math.round(min / (24 * 60))}d`;
}

function timeBuckets(files: FileChange[], makeRow: (f: FileChange) => HTMLElement, section: string): HTMLElement[] {
  const now = Date.now();
  const buckets = new Map<string, FileChange[]>();
  for (const f of files) {
    const b = timeBucket(fileTimes.get(f.path), now);
    buckets.set(b, [...(buckets.get(b) ?? []), f]);
  }
  const rows: HTMLElement[] = [];
  for (const name of BUCKET_ORDER) {
    const list = buckets.get(name);
    if (!list) continue;
    const key = `${section}|time|${name}`;
    rows.push(subHead(name, list.length, key, 0));
    if (collapsedNodes.has(key)) continue;
    // Newest first inside a bucket.
    list.sort((a, b) => (fileTimes.get(b.path) ?? 0) - (fileTimes.get(a.path) ?? 0));
    for (const f of list) {
      const row = indentRow(makeRow(f), 1, false);
      const ms = fileTimes.get(f.path);
      if (ms) {
        const age = h("span", { class: "age", title: new Date(ms).toLocaleString() }, shortAge(ms, now));
        row.insertBefore(age, row.querySelector(".actions"));
      }
      rows.push(row);
    }
  }
  return rows;
}

// ---- commit / stash file lists (shared) -----------------------------------

const detailsCache = new Map<string, { message: string; files: ChangedFile[] }>();

async function changeList(left: string, right: string, label: string, message: string | null) {
  const key = `${left}..${right}`;
  let data = detailsCache.get(key);
  if (!data) {
    const files = await repo!.changedFiles(left, right);
    data = { message: message ?? "", files };
    // Commit SHAs are immutable; stash refs (stash@{n}) are not, so only cache SHAs.
    if (/^[0-9a-f]{40}$/.test(right)) detailsCache.set(key, data);
  }
  return h(
    "div",
    { class: "details" },
    data.message && h("pre", {}, data.message),
    ...data.files.map((f) =>
      fileItem(f.path, f.status, f.status, { kind: "tree", left, right, path: f.path, origPath: f.origPath, label }, []),
    ),
    !data.files.length && h("div", { class: "empty" }, "No file changes."),
  );
}

// ---- History tab ----------------------------------------------------------

const PAGE = 200;
let commits: Commit[] = [];
let historyDone = false;
let expanded: string | null = null;

async function loadHistory(reset: boolean) {
  if (!repo) return;
  const more = await repo.log(reset ? 0 : commits.length, PAGE);
  commits = reset ? more : commits.concat(more);
  historyDone = more.length < PAGE;
  await renderHistory();
}

function commitMenu(c: Commit): MenuItem[] {
  const r = repo!;
  return [
    { label: "Checkout (detached)", run: () => checkoutAct(c.shortSha, () => r.checkoutDetached(c.sha)) },
    { label: "New worktree here…", run: () => newWorktreeFlow({ base: c.shortSha }).catch(showError) },
    {
      label: "Create branch here…",
      run: async () => {
        const name = await promptInput(`New branch at ${c.shortSha}`);
        if (name) act("Create branch", () => r.createBranch(name, c.sha));
      },
    },
    {
      label: "Create tag here…",
      run: async () => {
        const name = await promptInput(`Tag name for ${c.shortSha}`);
        if (name) act("Create tag", () => r.createTag(name, null, c.sha));
      },
    },
    "-",
    { label: "Cherry-pick", run: () => act("Cherry-pick", () => r.cherryPick(c.sha)) },
    { label: "Revert", run: () => act("Revert", () => r.revert(c.sha)) },
    "-",
    { label: "Reset to here (soft)", run: () => act("Reset", () => r.reset(c.sha, "soft")) },
    { label: "Reset to here (mixed)", run: () => act("Reset", () => r.reset(c.sha, "mixed")) },
    {
      label: "Reset to here (hard)…",
      run: async () => {
        if (await confirmAction(`Reset hard to ${c.shortSha}? Uncommitted changes will be lost.`))
          act("Reset", () => r.reset(c.sha, "hard"));
      },
    },
    "-",
    { label: "Copy commit for LLM (message + diff)", run: () => copyCommit(c) },
    ...(claudeOn ? [{ label: "✨ Explain with Claude", run: () => explainCommitWithClaude(c) }] : []),
    { label: "Copy SHA", run: () => navigator.clipboard.writeText(c.sha) },
  ];
}

async function renderHistory() {
  const panel = $("panel-history");
  const scroll = panel.scrollTop;
  const rows: HTMLElement[] = [];
  for (const c of commits) {
    const isOpen = expanded === c.sha;
    rows.push(
      withContextMenu(
        h(
          "div",
          {
            class: `commit${isOpen ? " expanded" : ""}`,
            title: c.subject,
            onclick: () => {
              expanded = isOpen ? null : c.sha;
              renderHistory().catch(showError);
            },
          },
          h("div", { class: "row" }, h("span", { class: "subject spacer" }, c.subject), menuButton(() => commitMenu(c))),
          h(
            "div",
            { class: "meta" },
            h("span", {}, c.shortSha),
            h("span", {}, c.author),
            h("span", {}, c.date.toLocaleString()),
            ...c.refs
              .split(", ")
              .filter(Boolean)
              .map((ref) => h("span", { class: "badge" }, ref.replace("HEAD -> ", "⎇ "))),
          ),
        ),
        () => commitMenu(c),
      ),
    );
    if (isOpen) {
      const left = c.parents[0] ?? EMPTY_TREE;
      rows.push(await changeList(left, c.sha, c.shortSha, await repo!.commitMessage(c.sha)));
    }
  }
  if (!commits.length) rows.push(h("div", { class: "empty" }, "No commits yet."));
  if (!historyDone)
    rows.push(h("button", { class: "more", onclick: () => loadHistory(false).catch(showError) }, "Load more"));
  panel.replaceChildren(...rows);
  panel.scrollTop = scroll;
  markSelected();
}

// ---- Branches tab ---------------------------------------------------------

const checkoutAutostash = $<HTMLInputElement>("checkout-autostash");
checkoutAutostash.checked = loadFlag("checkoutAutostash", true);
checkoutAutostash.addEventListener("change", () => saveFlag("checkoutAutostash", checkoutAutostash.checked));

/** A checkout, wrapped in the auto-stash when that option is on. */
function checkoutAct(name: string, run: () => Promise<void>) {
  const r = repo!;
  const label = `Checkout ${name}`;
  if (!checkoutAutostash.checked) return act(label, run);
  return act(label, async () => {
    const { conflicted } = await r.withAutostash(name, run);
    if (conflicted)
      throw new Error(
        `Switched to ${name}, but your uncommitted changes conflict with it: they are applied with conflict markers and also kept in the stash “hunkpad autostash: ${name}”. Resolve the conflicts, then drop that stash.`,
      );
  });
}

async function checkoutRef(ref: Ref, refs: Ref[]) {
  const r = repo!;
  if (ref.kind === "local") return checkoutAct(ref.name, () => r.checkout(ref.name));
  if (ref.kind === "tag") return checkoutAct(ref.name, () => r.checkoutDetached(ref.name));
  // Remote branch: switch to the local one if it exists, else create a tracking branch.
  const localName = ref.name.slice(ref.name.indexOf("/") + 1);
  const local = refs.find((x) => x.kind === "local" && x.name === localName);
  return checkoutAct(localName, () => (local ? r.checkout(localName) : r.checkoutTracking(ref.name)));
}

function refMenu(ref: Ref, refs: Ref[]): MenuItem[] {
  const r = repo!;
  const fav = favouriteRefs(r.root).has(refKey(ref));
  const items: MenuItem[] = [
    { label: fav ? "Remove from favourites" : "Add to favourites", run: () => toggleFavouriteRef(ref) },
    "-",
  ];
  const elsewhere = ref.kind === "local" ? worktreeWith(ref.name) : undefined;
  if (elsewhere) items.push({ label: `Open its worktree (${folderName(elsewhere.path)})`, run: () => openWorktree(elsewhere) });
  else if (!ref.current) items.push({ label: "Checkout", run: () => checkoutRef(ref, refs) });
  if (!ref.current && !elsewhere) items.push({ label: "New worktree from this…", run: () => newWorktreeFor(ref).catch(showError) });
  if (!ref.current && ref.kind !== "tag") {
    items.push(
      { label: "Compare my files with this", run: () => setCompare(ref.name).catch(showError) },
      { label: "Merge into current branch", run: () => act(`Merge ${ref.name}`, () => r.merge(ref.name)) },
      { label: "Rebase current branch onto this…", run: () => rebaseOnto(ref).catch(showError) },
    );
  }
  items.push({
    label: "Create branch from here…",
    run: async () => {
      const name = await promptInput(`New branch from ${ref.name}`);
      if (name) act("Create branch", () => r.createBranch(name, ref.name));
    },
  });
  if (ref.kind === "local") {
    items.push(
      "-",
      {
        label: "Rename…",
        run: async () => {
          const name = await promptInput(`Rename ${ref.name}`, ref.name);
          if (name && name !== ref.name) act("Rename branch", () => r.renameBranch(ref.name, name));
        },
      },
    );
    if (!ref.current) {
      items.push(
        { label: "Delete", run: () => act(`Delete ${ref.name}`, () => r.deleteBranch(ref.name, false)) },
        {
          label: "Force delete…",
          run: async () => {
            if (await confirmAction(`Force delete ${ref.name}? Unmerged commits will be lost.`))
              act(`Delete ${ref.name}`, () => r.deleteBranch(ref.name, true));
          },
        },
      );
    }
  } else if (ref.kind === "remote") {
    items.push("-", {
      label: "Delete remote branch…",
      run: async () => {
        if (await confirmAction(`Delete ${ref.name} on the remote?`))
          act(`Delete ${ref.name}`, () => r.deleteRemoteBranch(ref.name));
      },
    });
  } else {
    items.push(
      "-",
      { label: "Push tag", run: () => act(`Push ${ref.name}`, () => r.pushTag(ref.name)) },
      { label: "Delete tag", run: () => act(`Delete ${ref.name}`, () => r.deleteTag(ref.name)) },
    );
  }
  items.push("-", { label: "Copy name", run: () => navigator.clipboard.writeText(ref.name) });
  return items;
}

// ---- rebase onto a branch (with fetch / auto-stash options) -----------------

function loadFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

function saveFlag(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    // just won't be remembered
  }
}

const rebaseDialog = $<HTMLDialogElement>("rebase-dialog");
const rebaseFetch = $<HTMLInputElement>("rebase-fetch");
const rebaseAutostash = $<HTMLInputElement>("rebase-autostash");
let answerRebase: ((go: boolean) => void) | null = null;

$("rebase-go").addEventListener("click", () => {
  answerRebase?.(true);
  rebaseDialog.close();
});
$("rebase-cancel").addEventListener("click", () => {
  answerRebase?.(false);
  rebaseDialog.close();
});
rebaseDialog.addEventListener("cancel", () => answerRebase?.(false));

/**
 * Rebases the current branch onto `ref`. For a remote branch, "Fetch first" makes
 * it the same as `git pull --rebase <remote> <branch>`; "Auto-stash" uses Git's
 * --autostash so uncommitted changes are put aside and restored.
 */
async function rebaseOnto(ref: Ref) {
  const r = repo;
  const s = status;
  if (!r || !s) return;
  if (!s.branch) return setStatus("Check out a branch first: a detached HEAD cannot be rebased this way", true);
  const remote = ref.kind === "remote";
  const dirty = s.files.filter((f) => f.staged || f.unstaged || f.conflict).length;
  const preview = await r.rebasePreview(ref.name);

  $("rebase-title").textContent = `Rebase ${s.branch} onto ${ref.name}`;
  const lines = [
    `Your branch's ${preview.replay} commit(s) not in ${ref.name} will be replayed on top of it.`,
    dirty ? `${dirty} file(s) have uncommitted changes.` : "No uncommitted changes.",
  ];
  if (remote) lines.push(`With “Fetch first” this is the same as: git pull --rebase ${ref.name.replace("/", " ")}`);
  $("rebase-info").textContent = lines.join("\n");
  $("rebase-info").style.whiteSpace = "pre-wrap";
  $("rebase-fetch-row").classList.toggle("hidden", !remote);
  $("rebase-fetch-label").textContent = `Fetch ${ref.name} first (get its latest commits)`;
  rebaseFetch.checked = loadFlag("rebaseFetch", true);
  rebaseAutostash.checked = loadFlag("rebaseAutostash", true);
  const warnings: string[] = [];
  if (preview.pushed) {
    warnings.push(
      `⚠ ${preview.pushed} of these commits are already pushed: the rebase rewrites them, so the next push must be a force push (⋯ → Force push with lease).`,
    );
  }
  const updateWarning = () => {
    const stash = dirty && !rebaseAutostash.checked ? [`Git will refuse to start: ${dirty} file(s) have uncommitted changes. Tick Auto-stash, or commit/stash them first.`] : [];
    $("rebase-warning").textContent = [...warnings, ...stash].join("\n");
    $("rebase-warning").style.whiteSpace = "pre-wrap";
  };
  rebaseAutostash.onchange = updateWarning;
  updateWarning();

  rebaseDialog.showModal();
  $("rebase-go").focus();
  const go = await new Promise<boolean>((resolve) => (answerRebase = resolve));
  answerRebase = null;
  if (!go) return;

  const fetchFirst = remote && rebaseFetch.checked;
  const autostash = rebaseAutostash.checked;
  if (remote) saveFlag("rebaseFetch", fetchFirst);
  saveFlag("rebaseAutostash", autostash);
  await act(`Rebase onto ${ref.name}`, async () => {
    if (fetchFirst) await r.fetchRemoteBranch(ref.name);
    await r.rebase(ref.name, { autostash });
  });
  if (activeTab === "branches") await loadBranches();
}

async function newBranch() {
  const name = await promptInput("New branch name (from current HEAD)");
  if (name) act("Create branch", () => repo!.createBranch(name));
}

async function newTag() {
  const name = await promptInput("New tag name (at current HEAD)");
  if (!name) return;
  const message = await promptInput("Tag message (OK with empty = lightweight tag)");
  act("Create tag", () => repo!.createTag(name, message));
}

const branchFilter = $<HTMLInputElement>("branch-filter");
let branchRefs: Ref[] = [];

const refKey = (ref: Ref) => `${ref.kind}:${ref.name}`;

function toggleFavouriteRef(ref: Ref) {
  toggleFavourite(repo!.root, refKey(ref));
  renderBranches();
}

/** Refs matching the filter: every word must appear in the name, in any order. */
function filteredRefs(): Ref[] {
  const words = branchFilter.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return branchRefs.filter((r) => words.every((w) => r.name.toLowerCase().includes(w)));
}

let branchRemotes: Remote[] = [];

async function loadBranches() {
  if (!repo) return;
  [branchRefs, branchRemotes, worktrees] = await Promise.all([repo.refs(), repo.remoteList(), repo.worktrees()]);
  renderBranches();
}

function remoteRow(rm: Remote) {
  const url = rm.pushUrl && rm.pushUrl !== rm.fetchUrl ? `${rm.fetchUrl}  (push: ${rm.pushUrl})` : rm.fetchUrl;
  return withContextMenu(
    h(
      "div",
      { class: "item", title: `${rm.name}\n${url}\nRight-click for fetch, URL, rename, remove` },
      h("span", { class: "status" }, "⇅"),
      h("span", { class: "name" }, rm.name),
      h("span", { class: "dir" }, url),
      h("span", { class: "actions" }, menuButton(() => remoteMenu(rm))),
    ),
    () => remoteMenu(rm),
  );
}

function renderBranches() {
  if (!repo) return;
  const refs = branchRefs;
  const favourites = favouriteRefs(repo.root);
  const filtering = branchFilter.value.trim() !== "";
  const panel = $("panel-branches");
  const scroll = panel.scrollTop;

  const item = (ref: Ref) => {
    const fav = favourites.has(refKey(ref));
    const elsewhere = ref.kind === "local" ? worktreeWith(ref.name) : undefined;
    return withContextMenu(
      h(
        "div",
        {
          class: `item${ref.current ? " current" : ""}`,
          title: elsewhere
            ? `Checked out in the worktree ${elsewhere.path}: double-click to open it`
            : ref.kind === "local" ? "Double-click to check out" : ref.name,
          ondblclick: () => (elsewhere ? openWorktree(elsewhere) : !ref.current && checkoutRef(ref, refs)),
        },
        h("span", { class: "status" }, ref.current ? "✓" : ""),
        h(
          "span",
          { class: `star${fav ? "" : " off"}` },
          iconBtn(fav ? "★" : "☆", fav ? "Remove from favourites" : "Add to favourites", () => toggleFavouriteRef(ref)),
        ),
        h("span", { class: "name" }, ref.name),
        h(
          "span",
          { class: "dir" },
          [elsewhere ? `⎇ ${folderName(elsewhere.path)}` : "", ref.upstream ? `→ ${ref.upstream}` : ref.sha].filter(Boolean).join("  "),
        ),
        h("span", { class: "actions" }, menuButton(() => refMenu(ref, refs))),
      ),
      () => refMenu(ref, refs),
    );
  };

  const visible = filteredRefs();
  const favs = visible.filter((r) => favourites.has(refKey(r)));
  const group = (kind: Ref["kind"]) => visible.filter((r) => r.kind === kind && !favourites.has(refKey(r)));
  const local = group("local");
  const remote = group("remote");
  const tags = group("tag");
  // While filtering, hide empty groups so the matches stand out.
  const section = (title: string, list: Ref[], ...actions: HTMLElement[]) =>
    filtering && !list.length ? [] : [sectionHead(title, list.length, ...actions), ...list.map(item)];

  const words = branchFilter.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const wts = worktrees.filter((w) => words.every((x) => `${w.branch ?? ""} ${w.path}`.toLowerCase().includes(x)));
  const worktreeActions = [
    iconBtn("⚙", "Worktree setup: files to copy and a command to run in each new worktree", () => editSetup(mainPath()).catch(showError)),
    iconBtn("+", "New worktree…", () => newWorktreeFlow().catch(showError)),
    ...(worktrees.some((w) => w.prunable)
      ? [iconBtn("Prune", "Forget worktrees whose folder was deleted", () => act("Prune worktrees", () => repo!.pruneWorktrees()))]
      : []),
  ];

  $("branch-list").replaceChildren(
    ...(favs.length ? [sectionHead("Favourites", favs.length), ...favs.map(item)] : []),
    ...(filtering && !wts.length ? [] : [sectionHead("Worktrees", wts.length, ...worktreeActions), ...wts.map(worktreeRow)]),
    ...section("Branches", local, iconBtn("+", "New branch", newBranch)),
    ...section("Remote branches", remote),
    ...section("Tags", tags, iconBtn("+", "New tag", newTag)),
    ...(filtering && !visible.length ? [h("div", { class: "empty" }, "No matching branches or tags.")] : []),
    // Remotes are not filtered: there are only a few, and they are needed to push.
    sectionHead("Remotes", branchRemotes.length, iconBtn("+", "Add remote…", () => addRemoteFlow().catch(showError))),
    ...branchRemotes.map(remoteRow),
    ...(branchRemotes.length
      ? []
      : [h("div", { class: "empty indent" }, "No remote yet: + to add one (e.g. your GitHub repository).")]),
  );
  panel.scrollTop = scroll;
}

branchFilter.addEventListener("input", renderBranches);
branchFilter.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && branchFilter.value) {
    e.stopPropagation();
    branchFilter.value = "";
    renderBranches();
  } else if (e.key === "Enter") {
    // Enter checks out the match when the filter has narrowed it to one.
    const matches = filteredRefs().filter((r) => !r.current);
    if (matches.length === 1) checkoutRef(matches[0], branchRefs);
    else setStatus(`${matches.length} matches: narrow the filter to one to check it out with Enter`);
  }
});

// ---- worktrees --------------------------------------------------------------
//
// A linked worktree (git worktree add) is another folder of the repository with
// its own branch checked out. It opens in a tab of its own, like any repository;
// the Branches tab lists the active repository's worktrees.

/** The active repository's worktrees, the main one first (reloaded with its status). */
let worktrees: Worktree[] = [];
/** Linked worktrees seen so far (by pathKey) → their main work tree, for grouping tabs (saved in the settings). */
const WORKTREE_MAIN_KEY = "worktreeMain";
const worktreeMain = new Map<string, string>(
  (() => {
    try {
      return Object.entries(JSON.parse(settings.getItem(WORKTREE_MAIN_KEY) ?? "{}") as Record<string, string>);
    } catch {
      return [];
    }
  })(),
);

/** Remembers which folders are linked worktrees; true when that is news (tabs need re-rendering). */
function noteWorktrees(list: Worktree[]): boolean {
  const main = list.find((w) => w.main);
  let changed = false;
  for (const w of list) {
    if (w.main || !main || worktreeMain.get(pathKey(w.path)) === main.path) continue;
    worktreeMain.set(pathKey(w.path), main.path);
    changed = true;
  }
  if (changed) {
    // Keep only the worktrees still listed for this repository.
    for (const [k, v] of worktreeMain)
      if (samePath(v, main!.path) && !list.some((w) => pathKey(w.path) === k)) worktreeMain.delete(k);
    settings.setItem(WORKTREE_MAIN_KEY, JSON.stringify(Object.fromEntries(worktreeMain)));
  }
  return changed;
}

const folderName = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? p;

/** Another worktree that has `branch` checked out (Git allows a branch in one worktree only). */
function worktreeWith(branch: string): Worktree | undefined {
  return worktrees.find((w) => w.branch === branch && !(repo && samePath(w.path, repo.root)));
}

function openWorktree(w: Worktree) {
  if (w.prunable) return setStatus(`The folder of this worktree is gone: ${w.path}. Prune to forget it.`, true);
  openRepo(w.path).catch(handleOpenError);
}

/** The main work tree's repository, to run worktree commands from outside the one they change. */
async function mainWorktreeRepo(): Promise<Repo> {
  const main = worktrees.find((w) => w.main);
  return !main || samePath(main.path, repo!.root) ? repo! : Repo.open(main.path);
}

/** Leaves `w`'s tab before its folder is moved or deleted; true when it was open. */
async function closeWorktreeTab(w: Worktree): Promise<boolean> {
  const tab = openTabs.find((t) => samePath(t, w.path));
  if (!tab) return false;
  const main = worktrees.find((x) => x.main);
  if (repo && samePath(repo.root, w.path) && main) await openRepo(main.path);
  closeTab(tab);
  return true;
}

async function removeWorktreeFlow(w: Worktree) {
  // Uncommitted work in it is lost with the folder: say so, and only then force.
  const files = w.prunable ? 0 : ((await Repo.open(w.path).then((x) => x.status()).catch(() => null))?.files.length ?? 0);
  const what = w.branch ? `The branch ${w.branch} stays.` : "Its commits stay reachable only if a branch or tag points at them.";
  const warning = files ? `\n\n⚠ ${files} file(s) there have uncommitted changes or are untracked: they will be lost.` : "";
  if (!(await confirmAction(`Remove the worktree ${w.path}? Its folder is deleted. ${what}${warning}`))) return;
  const runner = await mainWorktreeRepo();
  await closeWorktreeTab(w);
  const outcome = await act(`Remove worktree ${folderName(w.path)}`, () => runner.removeWorktree(w.path, files > 0));
  if (outcome === "done") removeProject(w.path);
}

async function moveWorktreeFlow(w: Worktree) {
  const to = await promptInput("Move the worktree to (full path of a new folder)", w.path);
  if (!to || samePath(to, w.path)) return;
  const runner = await mainWorktreeRepo();
  const wasOpen = await closeWorktreeTab(w);
  const outcome = await act(`Move worktree ${folderName(w.path)}`, () => runner.moveWorktree(w.path, to));
  if (wasOpen) await openRepo(outcome === "done" ? to : w.path).catch(handleOpenError);
}

function worktreeMenu(w: Worktree): MenuItem[] {
  const r = repo!;
  const current = samePath(w.path, r.root);
  const locked = w.locked !== null;
  const items: MenuItem[] = [];
  if (!current) items.push({ label: "Open in a tab", run: () => openWorktree(w) });
  items.push(
    { label: "Copy path", run: () => navigator.clipboard.writeText(w.path) },
    {
      label: "Open terminal here",
      run: () => invoke("open_terminal", { cwd: w.path }).catch((e) => setStatus(`Could not open a terminal: ${errorText(e)}`, true)),
    },
  );
  if (!w.main && !w.prunable) items.push({ label: "Run setup", run: () => runSetup(w.path).catch(showError) });
  items.push({ label: "Worktree setup…", run: () => editSetup(mainPath()).catch(showError) });
  if (!w.main) {
    items.push(
      "-",
      locked
        ? { label: "Unlock", run: () => act("Unlock worktree", () => r.unlockWorktree(w.path)) }
        : { label: "Lock (keep it from being pruned)", run: () => act("Lock worktree", () => r.lockWorktree(w.path, "")) },
    );
    if (!locked && !w.prunable) items.push({ label: "Move…", run: () => moveWorktreeFlow(w).catch(showError) });
    if (!locked) items.push({ label: "Remove…", run: () => removeWorktreeFlow(w).catch(showError) });
  }
  return items;
}

function worktreeRow(w: Worktree) {
  const current = samePath(w.path, repo!.root);
  const label = w.bare ? "(bare)" : (w.branch ?? `(detached at ${w.sha.slice(0, 7)})`);
  const flags = [
    w.main ? "main" : "",
    w.locked !== null ? `locked${w.locked ? `: ${w.locked}` : ""}` : "",
    w.prunable ? "folder missing" : "",
  ].filter(Boolean);
  return withContextMenu(
    h(
      "div",
      {
        class: `item${current ? " current" : ""}`,
        title: `${w.path}${flags.length ? `\n${flags.join(", ")}` : ""}${current ? "" : "\nDouble-click to open in a tab"}`,
        ondblclick: () => !current && openWorktree(w),
      },
      h("span", { class: "status" }, current ? "✓" : "⎇"),
      h("span", { class: "name" }, label),
      h("span", { class: "dir" }, [...flags, w.path].join(" · ")),
      h("span", { class: "actions" }, menuButton(() => worktreeMenu(w))),
    ),
    () => worktreeMenu(w),
  );
}

const worktreeDialog = $<HTMLDialogElement>("worktree-dialog");
const wtBranch = $<HTMLInputElement>("worktree-branch");
const wtBase = $<HTMLInputElement>("worktree-base");
const wtPath = $<HTMLInputElement>("worktree-path");
const wtOpen = $<HTMLInputElement>("worktree-open");
const wtSetupBox = $<HTMLInputElement>("worktree-setup");
/** The setup the dialog will run (shown next to its checkbox). */
let wtSetup: WorktreeSetup | null = null;
let wtPathEdited = false;
let wtLocal = new Set<string>();
let wtRemote = new Set<string>();
let answerWorktree: ((go: boolean) => void) | null = null;

type WorktreeAdd = Parameters<Repo["addWorktree"]>[1];

/** What the dialog's fields ask for: the `git worktree add` options, in words, and any error. */
function worktreePlan(): { opts: WorktreeAdd; plan: string; error: string } {
  const branch = wtBranch.value.trim();
  const base = wtBase.value.trim();
  if (branch && wtLocal.has(branch)) {
    const other = worktrees.find((w) => w.branch === branch);
    return {
      opts: { ref: branch },
      plan: `Checks out the existing branch ${branch}.`,
      error: other ? `${branch} is already checked out in ${other.path}: a branch can be in one worktree at a time.` : "",
    };
  }
  if (branch) {
    const track = wtRemote.has(base);
    return {
      opts: { newBranch: branch, ref: base || undefined, track },
      plan: `Creates the branch ${branch} from ${base || "HEAD"}${track ? `, tracking ${base}` : ""}.`,
      error: "",
    };
  }
  return { opts: { detach: true, ref: base || undefined }, plan: `No branch: detached at ${base || "HEAD"}.`, error: "" };
}

/** Next to the main work tree: `<parent>/<repo>-<branch>`. */
function suggestedWorktreePath(): string {
  const main = (worktrees.find((w) => w.main)?.path ?? repo!.root).replace(/[\\/]+$/, "");
  const name = (wtBranch.value.trim() || wtBase.value.trim() || "detached").replace(/[^\w.-]+/g, "-");
  return `${main.slice(0, Math.max(main.lastIndexOf("/"), main.lastIndexOf("\\")))}/${folderName(main)}-${name}`;
}

function updateWorktreeDialog() {
  const { plan, error } = worktreePlan();
  wtBase.disabled = wtLocal.has(wtBranch.value.trim());
  if (!wtPathEdited) wtPath.value = suggestedWorktreePath();
  $("worktree-plan").textContent = plan;
  $("worktree-error").textContent = error;
}

for (const input of [wtBranch, wtBase]) input.addEventListener("input", updateWorktreeDialog);
wtPath.addEventListener("input", () => {
  wtPathEdited = true;
  $("worktree-error").textContent = "";
});
$("worktree-browse").addEventListener("click", async () => {
  const dir = await open({ directory: true, title: "Create the worktree in which folder?" });
  if (typeof dir !== "string") return;
  wtPath.value = `${dir.replace(/[\\/]+$/, "")}/${folderName(suggestedWorktreePath())}`;
  wtPathEdited = true;
});
$("worktree-create").addEventListener("click", () => {
  const path = wtPath.value.trim();
  let error = worktreePlan().error;
  if (!error && !/^(\/|[A-Za-z]:[\\/]|\\\\)/.test(path)) error = "Enter the full path of a new folder.";
  $("worktree-error").textContent = error;
  if (error) return;
  answerWorktree?.(true);
  worktreeDialog.close();
});
$("worktree-cancel").addEventListener("click", () => {
  answerWorktree?.(false);
  worktreeDialog.close();
});
worktreeDialog.addEventListener("cancel", () => answerWorktree?.(false));
worktreeDialog.querySelector("form")!.addEventListener("submit", (e) => {
  e.preventDefault();
  $("worktree-create").click();
});

/** Asks for the branch, start point and folder, then creates the worktree (and opens it). */
async function newWorktreeFlow(preset: { branch?: string; base?: string } = {}) {
  const r = repo;
  if (!r) return;
  const [refs, list] = await Promise.all([r.refs(), r.worktrees()]);
  worktrees = list;
  wtLocal = new Set(refs.filter((x) => x.kind === "local").map((x) => x.name));
  wtRemote = new Set(refs.filter((x) => x.kind === "remote").map((x) => x.name));
  wtBranch.value = preset.branch ?? "";
  wtBase.value = preset.base ?? status?.branch ?? "";
  wtPathEdited = false;
  wtOpen.checked = loadFlag("worktreeOpen", true);
  wtSetup = await effectiveSetup(mainPath());
  wtSetupBox.checked = loadFlag("worktreeSetup", true);
  $("worktree-setup-summary").textContent = setupSummary(wtSetup);
  updateWorktreeDialog();
  worktreeDialog.showModal();
  wtBranch.focus();
  const go = await new Promise<boolean>((resolve) => (answerWorktree = resolve));
  answerWorktree = null;
  if (!go) return;
  const path = wtPath.value.trim();
  const openIt = wtOpen.checked;
  const setUp = wtSetupBox.checked && wtSetup;
  saveFlag("worktreeOpen", openIt);
  saveFlag("worktreeSetup", wtSetupBox.checked);
  const outcome = await act(`New worktree ${folderName(path)}`, () => r.addWorktree(path, worktreePlan().opts));
  if (outcome !== "done") return;
  if (setUp) {
    worktrees = await r.worktrees(); // its number, for the setup command's variables
    await runSetup(path, setUp);
  }
  if (openIt) await openRepo(path).catch(handleOpenError);
}

$("worktree-setup-edit").addEventListener("click", async () => {
  const next = await editSetup(mainPath());
  if (!next) return;
  wtSetup = next;
  $("worktree-setup-summary").textContent = setupSummary(next);
});

// ---- worktree setup: what a new worktree needs to run -----------------------
//
// Git puts only committed files in a new worktree. The setup copies the local
// files the code needs (e.g. .env) from the main work tree and runs a command
// there (pnpm install by default for a Node project). Saved per repository.

/** The repository's main work tree (where the setup copies from and is saved). */
const mainPath = () => worktrees.find((w) => w.main)?.path ?? groupOf(repo!.root);

/** The saved setup, or the suggested one: Kept local and common env files that exist, and pnpm install for Node. */
async function effectiveSetup(main: string): Promise<WorktreeSetup> {
  await loadRepoData(main).catch(() => null);
  const saved = loadWorktreeSetup(main);
  if (saved) return saved;
  const local = [...loadKeptLocal(main), ...COMMON_LOCAL_FILES].filter(
    (p) => p !== DATA_DIR && !p.startsWith(`${DATA_DIR}/`),
  );
  const candidates = [...new Set(local), "package.json"];
  const exists = await invoke<boolean[]>("paths_exist", { base: main, paths: candidates }).catch(() => [] as boolean[]);
  return {
    copy: candidates.slice(0, -1).filter((_, i) => exists[i]),
    command: exists[candidates.length - 1] ? "pnpm install" : "",
    basePort: null,
  };
}

function setupSummary(s: WorktreeSetup): string {
  const steps = [
    s.copy.length ? `copy ${s.copy.length === 1 ? s.copy[0] : `${s.copy.length} local files`}` : "",
    s.command ? `run ${s.command}` : "",
  ].filter(Boolean);
  return steps.join(", then ") || "nothing to do yet";
}

const setupDialog = $<HTMLDialogElement>("setup-dialog");
const setupCopy = $<HTMLTextAreaElement>("setup-copy");
const setupCommand = $<HTMLInputElement>("setup-command");
const setupPort = $<HTMLInputElement>("setup-port");
let answerSetup: ((ok: boolean) => void) | null = null;

/** Shows the repository's setup for editing; resolves the saved setup, or null when cancelled. */
async function editSetup(main: string): Promise<WorktreeSetup | null> {
  const s = await effectiveSetup(main);
  setupMain = main;
  $("setup-note").replaceChildren();
  setupCopy.value = s.copy.join("\n");
  setupCommand.value = s.command;
  setupPort.value = s.basePort ? String(s.basePort) : "";
  $("setup-error").textContent = "";
  setupDialog.showModal();
  setupCopy.focus();
  const ok = await new Promise<boolean>((resolve) => (answerSetup = resolve));
  answerSetup = null;
  if (!ok) return null;
  const next: WorktreeSetup = {
    copy: parseCopyList(setupCopy.value),
    command: setupCommand.value.trim(),
    basePort: setupPort.value ? Number(setupPort.value) : null,
  };
  saveWorktreeSetup(main, next);
  renderScripts();
  setStatus(`Worktree setup saved for ${projectName(main)}`);
  return next;
}

$("setup-save").addEventListener("click", () => {
  const bad = parseCopyList(setupCopy.value).filter((p) => !validCopyPath(p));
  const port = setupPort.value ? Number(setupPort.value) : null;
  let error = "";
  if (bad.length) error = `Use paths inside the repository, relative to its folder: ${bad.join(", ")}`;
  else if (port !== null && !(Number.isInteger(port) && port > 0 && port <= 65000)) error = "The base port is a whole number from 1 to 65000.";
  $("setup-error").textContent = error;
  if (error) return;
  answerSetup?.(true);
  setupDialog.close();
});
$("setup-cancel").addEventListener("click", () => {
  answerSetup?.(false);
  setupDialog.close();
});
setupDialog.addEventListener("cancel", () => answerSetup?.(false));
setupDialog.querySelector("form")!.addEventListener("submit", (e) => {
  e.preventDefault();
  $("setup-save").click();
});

interface SetupResult {
  copied: string[];
  /** Already in the worktree: not overwritten. */
  kept: string[];
  missing: string[];
  /** The command started in a new window, if any. */
  started: string | null;
}

/**
 * Prepares the worktree `path`: copies the local files from the main work tree,
 * then runs the command in a new window. Null when it failed (said in the status bar).
 */
async function runSetup(path: string, setup?: WorktreeSetup): Promise<SetupResult | null> {
  const main = mainPath();
  if (samePath(main, path)) {
    setStatus("The setup copies from the main folder into the other worktrees: nothing to do here", true);
    return null;
  }
  const s = setup ?? (await effectiveSetup(main));
  const result: SetupResult = { copied: [], kept: [], missing: [], started: null };
  const done: string[] = [];
  try {
    if (s.copy.length) {
      Object.assign(result, await invoke<Omit<SetupResult, "started">>("copy_into_worktree", { from: main, to: path, paths: s.copy }));
      done.push(`copied ${result.copied.length} file(s)${result.kept.length ? `, kept ${result.kept.length} already there` : ""}`);
      if (result.missing.length) done.push(`not in the main folder: ${result.missing.join(", ")}`);
    }
    if (s.command) {
      await invoke("launch_command", { cwd: path, command: s.command, env: envFor(path) });
      result.started = s.command;
      done.push(`running ${s.command} in a new window`);
    }
    setStatus(`Setup of ${folderName(path)}: ${done.join("; ") || "nothing to do (⚙ Worktree setup to add files or a command)"}`);
    return result;
  } catch (e) {
    setStatus(`Setup of ${folderName(path)} failed: ${errorText(e)}`, true);
    return null;
  }
}

/** The setup in words, for the approval Claude Code's changes need. */
function setupLines(s: WorktreeSetup): string {
  return [
    `• Copy from the main folder: ${s.copy.length ? s.copy.join(", ") : "nothing"}`,
    `• Then run: ${s.command || "nothing"}`,
    `• Base port: ${s.basePort ?? "none"}`,
  ].join("\n");
}

// ✨ Claude suggests the setup from the repository's file names and manifests
// (never the contents of untracked files); it fills the dialog, the user saves.
const MANIFEST = /(^|\/)(package\.json|pnpm-workspace\.yaml|pyproject\.toml|requirements[^/]*\.txt|Pipfile|Cargo\.toml|go\.mod|Gemfile|composer\.json|\.nvmrc|\.node-version|\.tool-versions|\.gitignore)$/;

let setupMain: string | null = null;

function suggestSetupWithClaude() {
  claudeAction(async () => {
    const main = setupMain ?? mainPath();
    const r = samePath(main, repo!.root) ? repo! : await Repo.open(main);
    const [tracked, allUntracked] = await Promise.all([r.trackedFiles(), r.untrackedPaths()]);
    const untracked = allUntracked.filter((p) => p !== `${DATA_DIR}/` && !p.startsWith(`${DATA_DIR}/`));
    const names = tracked.filter((p) => MANIFEST.test(p) && !p.includes("node_modules/") && !isSecretPath(p)).slice(0, 20);
    const read = await Promise.all(names.map(async (p) => ({ path: p, text: ((await r.readWorktree(p).catch(() => null)) ?? "").slice(0, 20_000) })));
    const leaveOut = await screenSecrets(read);
    if (!leaveOut) return;
    const manifests = read.filter((m) => !leaveOut.has(m.path));
    const port = setupPort.value ? Number(setupPort.value) : null;
    const answer = await askClaude({
      title: "Suggest the worktree setup with Claude?",
      summary: `${tracked.length} tracked and ${untracked.length} untracked names (no contents), ${manifests.length} manifest file(s)`,
      files: manifests.map((m) => m.path),
      skipped: [...leaveOut],
      prompt: setupPrompt({
        tracked,
        untracked,
        manifests,
        current: { copy: parseCopyList(setupCopy.value), command: setupCommand.value.trim(), basePort: port },
      }),
      system: SETUP_SYSTEM,
      schema: SETUP_SCHEMA,
    });
    if (claudeDialog.open) claudeDialog.close();
    if (answer === null) return;
    const s = parseSetupSuggestion(answer, untracked);
    setupCopy.value = s.copy.join("\n");
    setupCommand.value = s.command;
    setupPort.value = s.basePort ? String(s.basePort) : "";
    $("setup-note").replaceChildren(
      h("strong", {}, "Suggested by Claude: check it, then Save."),
      ...(s.explanation ? [markdownBlock(s.explanation)] : []),
    );
  });
}
$("setup-suggest").addEventListener("click", suggestSetupWithClaude);

/** From a branch or tag: a local branch is checked out, a remote one gets a local tracking branch. */
function newWorktreeFor(ref: Ref) {
  if (ref.kind === "local") return newWorktreeFlow({ branch: ref.name });
  if (ref.kind === "remote") return newWorktreeFlow({ branch: ref.name.slice(ref.name.indexOf("/") + 1), base: ref.name });
  return newWorktreeFlow({ branch: "", base: ref.name });
}

// ---- Stashes tab ----------------------------------------------------------

let expandedStash: string | null = null;

async function stashChanges(includeUntracked: boolean) {
  const message = await promptOptional(
    includeUntracked ? "Stash message, optional (including untracked files)" : "Stash message, optional",
  );
  if (message === null) return; // cancelled
  act(includeUntracked ? "Stash (with untracked)" : "Stash", () => repo!.stash(message || null, includeUntracked));
}

async function loadStashes() {
  if (!repo) return;
  const r = repo;
  const stashes = await r.stashes();
  const panel = $("panel-stashes");
  const rows: HTMLElement[] = [
    sectionHead(
      "Stashes",
      stashes.length,
      iconBtn("+", "Stash changes", () => stashChanges(false)),
      iconBtn("+U", "Stash changes including untracked files", () => stashChanges(true)),
    ),
  ];
  for (const st of stashes) rows.push(...(await stashRows(r, st)));
  if (!stashes.length) rows.push(h("div", { class: "empty" }, "No stashes."));
  panel.replaceChildren(...rows);
  markSelected();
}

async function stashRows(r: Repo, st: Stash): Promise<HTMLElement[]> {
  const isOpen = expandedStash === st.ref;
  const drop = async () => {
    if (await confirmAction(`Drop ${st.ref} (${st.message})?`)) act("Drop stash", () => r.stashDrop(st.ref));
  };
  const toggleFiles = () => {
    expandedStash = isOpen ? null : st.ref;
    loadStashes().catch(showError);
  };
  const menu = (): MenuItem[] => [
    { label: "Apply", run: () => act("Apply stash", () => r.stashApply(st.ref, false)) },
    { label: "Pop (apply and drop)", run: () => act("Pop stash", () => r.stashApply(st.ref, true)) },
    { label: isOpen ? "Hide files" : "Show files", run: toggleFiles },
    "-",
    { label: "Drop…", run: drop },
  ];
  const row = withContextMenu(h(
    "div",
    {
      class: `item${isOpen ? " selected" : ""}`,
      title: st.message,
      onclick: toggleFiles,
    },
    h("span", { class: "name spacer" }, st.message),
    st.untracked ? h("span", { class: "badge", title: "Includes untracked files" }, "+U") : null,
    h(
      "span",
      { class: "actions" },
      iconBtn("Apply", "Apply, keep the stash", () => act("Apply stash", () => r.stashApply(st.ref, false))),
      iconBtn("Pop", "Apply and drop the stash", () => act("Pop stash", () => r.stashApply(st.ref, true))),
      iconBtn("✕", "Drop the stash", drop),
    ),
  ), menu);
  if (!isOpen) return [row];
  // Tracked changes: the stash against its HEAD. Untracked files (stash -u) are
  // a separate third parent, so they get their own list.
  const tracked = await changeList(`${st.ref}^1`, st.ref, st.ref, null);
  if (!st.untracked) return [row, tracked];
  const untracked = await changeList(EMPTY_TREE, `${st.ref}^3`, `${st.ref} · untracked`, null);
  const onlyUntracked = !!tracked.querySelector(".empty");
  return [
    row,
    ...(onlyUntracked ? [] : [tracked]),
    h("div", { class: "sub-head stash-part" }, "Untracked files"),
    untracked,
  ];
}

// ---- tabs -----------------------------------------------------------------

async function showTab(tab: Tab) {
  activeTab = tab;
  document.querySelectorAll<HTMLElement>("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  for (const t of ["changes", "history", "branches", "stashes", "comments"] as Tab[]) {
    $(`panel-${t}`).classList.toggle("hidden", t !== tab);
  }
  if (!repo) return;
  if (tab === "history") await loadHistory(true);
  else if (tab === "branches") await loadBranches();
  else if (tab === "stashes") await loadStashes();
  else if (tab === "comments") await renderCommentsPanel();
}

document.querySelectorAll<HTMLElement>("#tabs button").forEach((b) =>
  b.addEventListener("click", () => showTab(b.dataset.tab as Tab).catch(showError)),
);

// ---- user scripts (row under the repo tabs; projects.ts) --------------------

const scriptDialog = $<HTMLDialogElement>("script-dialog");
const scriptName = $<HTMLInputElement>("script-name");
const scriptPath = $<HTMLInputElement>("script-path");
const scriptError = $("script-error");
const scriptNpmField = $("script-npm-field");
const scriptNpm = $<HTMLSelectElement>("script-npm");

// Scripts are saved once per repository (in its main work tree's data) and run
// in the active worktree: a saved path inside one work tree is moved to the same
// place in the active one (worktrees.ts).

/** Where a repository's scripts are saved: its main work tree. */
const scriptHome = (root: string) => groupOf(root);

/** A script and the work tree whose data holds it. */
interface ScriptEntry {
  s: UserScript;
  owner: string;
}

/** The repository's scripts, then any saved in this worktree alone (before scripts were shared). */
function scriptEntries(root: string): ScriptEntry[] {
  const home = scriptHome(root);
  const shared = loadScripts(home).map((s) => ({ s, owner: home }));
  return samePath(home, root) ? shared : [...shared, ...loadScripts(root).map((s) => ({ s, owner: root }))];
}

/** Variables for scripts and setup commands in `root`: its worktree number, and a port with a base port. */
function envFor(root: string): [string, string][] {
  const index = Math.max(0, worktrees.findIndex((w) => samePath(w.path, root)));
  const main = worktrees.find((w) => w.main)?.path ?? scriptHome(root);
  return worktreeEnv(index, root, loadWorktreeSetup(main)?.basePort ?? null);
}

/** The active repository's scripts as ▶ buttons. */
function renderScripts() {
  const box = $("script-buttons");
  const r = repo;
  if (!r) return box.replaceChildren();
  box.replaceChildren(
    ...scriptEntries(r.root).map((e) =>
      withContextMenu(
        h(
          "button",
          {
            title: `${e.s.npm ? `npm run ${e.s.npm}` : e.s.path}\nRuns in a new window, in the worktree you are on${
              samePath(e.owner, scriptHome(r.root)) ? "" : " (saved in this worktree only)"
            }\nRight-click to edit or remove`,
            onclick: () => runScript(e.s),
          },
          h("span", { class: "play" }, "▶"),
          e.s.name,
        ),
        () => scriptMenu(e),
      ),
    ),
  );
}

async function runScript(s: UserScript) {
  const r = repo;
  if (!r) return;
  try {
    const roots = [...worktrees.map((w) => w.path), scriptHome(r.root), r.root];
    let path = inWorktree(s.path, roots, r.root);
    let note = "";
    if (path !== s.path && !(await invoke<boolean>("is_file", { path }))) {
      // Not in this worktree (e.g. a script Git does not track): the saved one runs, here.
      if (s.npm) throw new Error(`this worktree has no ${path.slice(r.root.length + 1)}`);
      note = `, using ${s.path}`;
      path = s.path;
    }
    await invoke("launch_script", { cwd: r.root, script: path, npm: s.npm ?? null, env: envFor(r.root) });
    setStatus(`Started “${s.name}” in a new window (in ${folderName(r.root)}${note})`);
  } catch (e) {
    setStatus(`Could not start “${s.name}”: ${errorText(e)}`, true);
  }
}

function updateScripts(owner: string, fn: (scripts: UserScript[]) => UserScript[]) {
  saveScripts(owner, fn(loadScripts(owner)));
  renderScripts();
}

function scriptMenu({ s, owner }: ScriptEntry): MenuItem[] {
  return [
    { label: "Run", run: () => runScript(s) },
    {
      label: "Edit…",
      run: async () => {
        const edited = await scriptDialogFor(s);
        if (edited) updateScripts(owner, (list) => list.map((x) => (x.id === s.id ? edited : x)));
      },
    },
    { label: "Copy path", run: () => navigator.clipboard.writeText(s.path) },
    "-",
    {
      label: "Remove…",
      run: async () => {
        if (await confirmAction(`Remove the script “${s.name}” from this repository? The file itself is not deleted.`))
          updateScripts(owner, (list) => list.filter((x) => x.id !== s.id));
      },
    },
  ];
}

/** Add / edit dialog: name + where the script is. Resolves null when cancelled. */
async function scriptDialogFor(existing?: UserScript): Promise<UserScript | null> {
  $("script-dialog-title").textContent = existing ? `Edit “${existing.name}”` : "Add script";
  scriptName.value = existing?.name ?? "";
  scriptPath.value = existing?.path ?? "";
  scriptError.textContent = "";
  await refreshNpmScripts(existing?.npm);
  scriptDialog.returnValue = "";
  scriptDialog.showModal();
  (existing ? scriptName : scriptPath).focus();
  await new Promise((resolve) => scriptDialog.addEventListener("close", resolve, { once: true }));
  if (scriptDialog.returnValue !== "ok") return null;
  const s: UserScript = { id: existing?.id ?? newUserId(), name: scriptName.value.trim(), path: scriptPath.value.trim() };
  if (isPackageJson(s.path)) s.npm = scriptNpm.value;
  return s;
}

const isPackageJson = (path: string) => /(^|[\\/])package\.json$/.test(path);

/** When "Where it is" is a package.json, lists its scripts (keeping `selected`); otherwise hides the list. */
async function refreshNpmScripts(selected?: string) {
  const path = scriptPath.value.trim().replace(/^"(.*)"$/, "$1");
  let names: string[] = [];
  if (isPackageJson(path)) {
    // Unreadable: the list stays empty and Save says why.
    names = npmScriptNames(await invoke<string>("read_package_json", { path }).catch(() => ""));
  }
  scriptNpm.replaceChildren(...names.map((n) => h("option", { value: n }, n)));
  if (selected && names.includes(selected)) scriptNpm.value = selected;
  scriptNpmField.classList.toggle("hidden", !isPackageJson(path));
}

scriptPath.placeholder = isWindows ? "C:\\path\\to\\script.ps1" : "/path/to/script.sh";
$("script-help").textContent = isWindows
  ? "Runs in a new console window, in this repository's folder. .ps1 with PowerShell, .cmd/.bat with cmd, " +
    ".sh with Git Bash, .py with python, .js with node; other files with their Windows default program. " +
    "For a package.json, choose one of its scripts: it runs with npm run, in that folder."
  : `Runs in a new ${isMac ? "Terminal" : "terminal"} window, in this repository's folder. .sh with bash, ` +
    ".zsh with zsh, .py with python3, .js with node, .ps1 with pwsh; other files must be executable (chmod +x). " +
    "For a package.json, choose one of its scripts: it runs with npm run, in that folder.";

$("script-cancel").addEventListener("click", () => scriptDialog.close("cancel"));
for (const input of [scriptName, scriptPath]) input.addEventListener("input", () => (scriptError.textContent = ""));

$("script-browse").addEventListener("click", async () => {
  const file = await open({
    title: "Choose the script",
    defaultPath: repo?.root,
    filters: [
      {
        name: "Scripts, package.json",
        extensions: isWindows
          ? ["ps1", "cmd", "bat", "sh", "py", "js", "mjs", "exe", "json"]
          : ["sh", "bash", "zsh", "command", "py", "js", "mjs", "ps1", "json"],
      },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (typeof file !== "string") return;
  scriptPath.value = file;
  scriptError.textContent = "";
  await refreshNpmScripts();
  // Suggest a name from the npm script or the file name when none was typed.
  if (!scriptName.value.trim())
    scriptName.value = isPackageJson(file) ? scriptNpm.value : file.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, "");
});

// A typed or pasted path is checked once the field is left.
scriptPath.addEventListener("change", () => refreshNpmScripts(scriptNpm.value).catch(showError));
scriptNpm.addEventListener("change", () => {
  scriptError.textContent = "";
  // Follow the chosen script while the name is still a suggestion (empty or another script's name).
  const names = [...scriptNpm.options].map((o) => o.value);
  if (!scriptName.value.trim() || names.includes(scriptName.value.trim())) scriptName.value = scriptNpm.value;
});

// Save validates (the file must exist) before closing.
$("script-save").addEventListener("click", async () => {
  const name = scriptName.value.trim();
  const path = scriptPath.value.trim().replace(/^"(.*)"$/, "$1");
  scriptPath.value = path;
  if (!name) return void (scriptError.textContent = "Enter a name.");
  if (!path) return void (scriptError.textContent = "Choose where the script is.");
  if (!(await invoke<boolean>("is_file", { path }))) return void (scriptError.textContent = "No file at that path.");
  if (isPackageJson(path)) {
    await refreshNpmScripts(scriptNpm.value);
    if (!scriptNpm.value) return void (scriptError.textContent = "This package.json has no scripts.");
  }
  scriptDialog.close("ok");
});
// Enter in a field saves, like the other dialogs.
scriptDialog.querySelector("form")!.addEventListener("submit", (e) => {
  e.preventDefault();
  $("script-save").click();
});

$("qa-terminal").addEventListener("click", async () => {
  if (!repo) return;
  try {
    await invoke("open_terminal", { cwd: repo.root });
    setStatus(`Opened a terminal in ${repo.root}`);
  } catch (e) {
    setStatus(`Could not open a terminal: ${errorText(e)}`, true);
  }
});

$("qa-copy-path").addEventListener("click", async () => {
  if (!repo) return;
  // Git gives C:/x/y; Windows tools expect C:\x\y.
  const path = isWindows ? repo.root.replace(/\//g, "\\") : repo.root;
  try {
    await navigator.clipboard.writeText(path);
    setStatus(`Copied ${path}`);
  } catch (e) {
    setStatus(`Could not copy the path: ${errorText(e)}`, true);
  }
});

$("add-script").addEventListener("click", async () => {
  const s = await scriptDialogFor();
  if (s && repo) updateScripts(scriptHome(repo.root), (list) => [...list, s]);
});

// ---- projects picker ------------------------------------------------------

const projectsDialog = $<HTMLDialogElement>("projects-dialog");
const projectsFilter = $<HTMLInputElement>("projects-filter");
const projectsList = $("projects-list");
let pickerIndex = 0;

function filteredProjects(): Project[] {
  const q = projectsFilter.value.trim().toLowerCase();
  return listProjects().filter((p) => !q || p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q));
}

function highlightProject(i: number) {
  pickerIndex = i;
  projectsList.querySelectorAll<HTMLElement>("[data-index]").forEach((el) => {
    const on = Number(el.dataset.index) === i;
    el.classList.toggle("selected", on);
    if (on) el.scrollIntoView({ block: "nearest" });
  });
}

function renderProjects() {
  const list = filteredProjects();
  pickerIndex = Math.min(pickerIndex, Math.max(0, list.length - 1));
  const rows: HTMLElement[] = [];
  let group = "";
  list.forEach((p, i) => {
    const g = p.pinned ? "Pinned" : "Recent";
    if (g !== group) rows.push(h("div", { class: "section-head" }, (group = g)));
    const current = !!repo && repo.root.toLowerCase() === p.path.toLowerCase();
    const row = h(
      "div",
      {
        class: `item${current ? " current" : ""}`,
        title: p.path,
        onclick: () => openProject(p),
        onmousemove: () => pickerIndex !== i && highlightProject(i),
      },
      h("span", { class: "star" }, iconBtn(p.pinned ? "★" : "☆", p.pinned ? "Unpin" : "Pin", () => {
        updateProject(p.path, { pinned: !p.pinned });
        renderProjects();
      })),
      h("span", { class: "name" }, p.name),
      h("span", { class: "dir" }, p.path),
      h(
        "span",
        { class: "actions" },
        iconBtn("✎", "Rename", async () => {
          const name = await promptInput("Project name", p.name);
          if (!name) return;
          updateProject(p.path, { name });
          renderTabs();
          renderProjects();
        }),
        iconBtn("✕", "Remove from list", () => {
          removeProject(p.path);
          renderProjects();
        }),
      ),
    );
    row.dataset.index = String(i);
    rows.push(row);
  });
  if (!list.length) {
    rows.push(
      h("div", { class: "empty" }, projectsFilter.value ? "No matching projects." : "No projects yet. Open a folder to add it."),
    );
  }
  projectsList.replaceChildren(...rows);
  highlightProject(pickerIndex);
}

function showProjects() {
  projectsFilter.value = "";
  pickerIndex = 0;
  renderProjects();
  if (!projectsDialog.open) projectsDialog.showModal();
  projectsFilter.focus();
}

function openProject(p: Project) {
  projectsDialog.close();
  openRepo(p.path).catch((e) => {
    if (e instanceof NotARepoError) return handleOpenError(e);
    showError(e);
    setStatus(`Cannot open ${p.path}: ${errorText(e)}. Remove it from the list with ✕ (${keys("Ctrl+R")}).`, true);
  });
}

projectsFilter.addEventListener("input", () => {
  pickerIndex = 0;
  renderProjects();
});
projectsFilter.addEventListener("keydown", (e) => {
  const list = filteredProjects();
  if (e.key === "ArrowDown") {
    e.preventDefault();
    highlightProject(Math.min(pickerIndex + 1, list.length - 1));
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    highlightProject(Math.max(pickerIndex - 1, 0));
  } else if (e.key === "Enter" && list[pickerIndex]) {
    e.preventDefault();
    openProject(list[pickerIndex]);
  }
});
$("projects-open").addEventListener("click", () => {
  projectsDialog.close();
  pickRepo();
});
$("projects-clone").addEventListener("click", () => {
  projectsDialog.close();
  clone();
});
$("projects-close").addEventListener("click", () => projectsDialog.close());

// ---- search: file names (Ctrl+P), text (Ctrl+Shift+F), Ctrl+click on a word ----
//
// All on Git (search.ts): nothing is indexed, nothing stays in memory. A result
// opens the file on disk, whole, at the matching line.

type SearchMode = "files" | "text";

const searchDialog = $<HTMLDialogElement>("search-dialog");
const searchInput = $<HTMLInputElement>("search-input");
const searchResults = $("search-results");
const searchInfo = $("search-info");
let searchMode: SearchMode = "files";
const searchQueries: Record<SearchMode, string> = { files: "", text: "" };
const savedSearchOpts = (): TextSearchOptions => ({
  matchCase: loadFlag("searchMatchCase", false),
  wholeWord: loadFlag("searchWholeWord", false),
  regex: loadFlag("searchRegex", false),
});
let searchOpts = savedSearchOpts();
/** The repo's files, listed once each time the dialog opens. */
let searchFileList: { root: string; paths: Promise<string[]> } | null = null;
/** The selectable rows, in order: what Enter / a click opens. */
let searchRows: (() => void)[] = [];
let searchIndex = 0;
let searchSeq = 0;
let searchTimer: number | undefined;
let searchDirty = false;

/** `opts` (e.g. whole word for Ctrl+click) apply to this search only; the toggles' saved state stays. */
function showSearch(mode: SearchMode, query?: string, opts?: Partial<TextSearchOptions>) {
  if (!repo) return;
  if (searchDialog.open) searchQueries[searchMode] = searchInput.value;
  else searchFileList = null;
  searchMode = mode;
  searchOpts = { ...savedSearchOpts(), ...opts };
  searchInput.value = query ?? searchQueries[mode];
  renderSearchChrome();
  if (!searchDialog.open) searchDialog.showModal();
  searchInput.focus();
  searchInput.select();
  runSearch();
}

function renderSearchChrome() {
  searchDialog.classList.toggle("files", searchMode === "files");
  searchInput.placeholder =
    searchMode === "files" ? "Find a file by name…" : "Find text in all files (tracked and untracked)…";
  searchDialog.querySelectorAll<HTMLButtonElement>("#search-mode button").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === searchMode),
  );
  searchDialog.querySelectorAll<HTMLButtonElement>("#search-opts button").forEach((b) =>
    b.classList.toggle("active", searchOpts[b.dataset.opt as keyof TextSearchOptions]),
  );
}

function runSearch() {
  clearTimeout(searchTimer);
  searchDirty = false;
  (searchMode === "files" ? searchFiles() : searchText()).catch((e) => {
    searchRows = [];
    searchResults.replaceChildren();
    searchInfo.textContent = errorText(e);
  });
}

function highlightSearch(i: number) {
  searchIndex = i;
  searchResults.querySelectorAll<HTMLElement>("[data-index]").forEach((el) => {
    const on = Number(el.dataset.index) === i;
    el.classList.toggle("selected", on);
    if (on) el.scrollIntoView({ block: "nearest" });
  });
}

/** A selectable result row. */
function searchRow(cls: string, title: string, open: () => void, ...children: Child[]): HTMLElement {
  const i = searchRows.push(open) - 1;
  return h(
    "div",
    {
      class: cls,
      title,
      "data-index": i,
      onclick: open,
      onmousemove: () => searchIndex !== i && highlightSearch(i),
    },
    ...children,
  );
}

function showResults(rows: HTMLElement[]) {
  searchResults.replaceChildren(...rows);
  searchResults.scrollTop = 0;
  highlightSearch(0);
}

/** `text[from, to)` with the characters at `hits` in <mark>. */
function marked(text: string, from: number, to: number, hits: number[]): Child[] {
  const out: Child[] = [];
  const set = new Set(hits);
  let run = "";
  let inHit = false;
  const flush = () => {
    if (run) out.push(inHit ? h("mark", {}, run) : run);
    run = "";
  };
  for (let i = from; i < to; i++) {
    if (set.has(i) !== inHit) {
      flush();
      inHit = !inHit;
    }
    run += text[i];
  }
  flush();
  return out;
}

async function searchFiles() {
  const r = repo!;
  const seq = ++searchSeq;
  if (!searchFileList || searchFileList.root !== r.root) {
    searchInfo.textContent = "Listing files…";
    // Shared by the keystrokes typed meanwhile; a failure is not kept.
    const paths = r.listFiles().catch((e) => {
      searchFileList = null;
      throw e;
    });
    searchFileList = { root: r.root, paths };
  }
  const all = await searchFileList.paths;
  if (seq !== searchSeq) return;
  const ranked = rankFiles(searchInput.value, all, 100);
  searchRows = [];
  showResults(
    ranked.map((m) => {
      const slash = m.path.lastIndexOf("/") + 1;
      return searchRow(
        "item",
        m.path,
        () => openSearchResult(m.path),
        h("span", { class: "name" }, ...marked(m.path, slash, m.path.length, m.hits)),
        h("span", { class: "dir" }, ...marked(m.path, 0, slash, m.hits)),
      );
    }),
  );
  searchInfo.textContent = searchInput.value.trim()
    ? `${ranked.length === 100 ? "First 100" : ranked.length} of ${all.length} files`
    : `${all.length} files`;
}

async function searchText() {
  const r = repo!;
  const query = searchInput.value;
  const opts = { ...searchOpts };
  const seq = ++searchSeq;
  if (!query) {
    searchRows = [];
    searchResults.replaceChildren();
    searchInfo.textContent = "Type to search; Enter searches at once.";
    return;
  }
  searchInfo.textContent = "Searching…";
  const out = await r.grep(grepArgs(query, opts));
  if (seq !== searchSeq) return;
  const { matches, truncated } = parseGrep(out);
  const byFile = new Map<string, TextMatch[]>();
  for (const m of matches) byFile.set(m.path, [...(byFile.get(m.path) ?? []), m]);

  searchRows = [];
  const rows: HTMLElement[] = [];
  for (const [path, list] of byFile) {
    const slash = path.lastIndexOf("/") + 1;
    rows.push(
      h(
        "div",
        { class: "section-head", title: path, onclick: () => openSearchResult(path, list[0], query, opts) },
        h("span", {}, path.slice(slash)),
        h("span", { class: "dir" }, path.slice(0, slash)),
        h("span", { class: "spacer" }),
        h("span", { class: "count" }, String(list.length)),
      ),
    );
    for (const m of list)
      rows.push(
        searchRow(
          "item hit",
          `${path}:${m.line}`,
          () => openSearchResult(path, m, query, opts),
          h("span", { class: "ln" }, String(m.line)),
          h("span", { class: "line" }, ...hitLine(m, query, opts)),
        ),
      );
  }
  showResults(rows);
  searchInfo.textContent = !matches.length
    ? "No results"
    : truncated
      ? `First ${matches.length} results, in ${byFile.size} files: refine the search to see the rest`
      : `${matches.length} results in ${byFile.size} files`;
}

/** The matched line, trimmed, with the match in <mark>; long lines are cut around the match. */
function hitLine(m: TextMatch, query: string, opts: TextSearchOptions): Child[] {
  const text = m.text;
  const [start, end] = matchRange(text, query, opts, m.column - 1) ?? [m.column - 1, m.column - 1];
  let from = text.length - text.trimStart().length;
  if (start - from > 80) from = start - 40;
  const to = Math.min(text.length, Math.max(end, from + 400));
  return [text.slice(from, start), h("mark", {}, text.slice(start, end)), text.slice(end, to)];
}

/** Opens the file on disk (whole) and, for a text match, selects it. */
async function openSearchResult(path: string, m?: TextMatch, query?: string, opts?: TextSearchOptions) {
  searchDialog.close();
  const conflict = !!status?.files.find((f) => f.path === path)?.conflict;
  try {
    await showDiff({ kind: "worktree", path, conflict }, { wholeFile: true });
  } catch (e) {
    return showError(e);
  }
  if (!m) return;
  revealLine(m.line, "modified");
  const range = query && opts ? matchRange(m.text, query, opts, m.column - 1) : null;
  if (range) modifiedEditor.setSelection(new monaco.Range(m.line, range[0] + 1, m.line, range[1] + 1));
}

/** Ctrl+click / Shift+F12 on a word: every place it appears, as a whole word, matching case. */
function findReferences(word: string) {
  showSearch("text", word, { matchCase: true, wholeWord: true, regex: false });
}

searchInput.addEventListener("input", () => {
  if (searchMode === "files") return runSearch();
  searchDirty = true;
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(runSearch, 300);
});
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    highlightSearch(Math.min(searchIndex + 1, searchRows.length - 1));
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    highlightSearch(Math.max(searchIndex - 1, 0));
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (searchDirty) runSearch();
    else searchRows[searchIndex]?.();
  } else if (e.key === "Tab") {
    e.preventDefault();
    showSearch(searchMode === "files" ? "text" : "files");
  }
});
searchDialog.querySelectorAll<HTMLButtonElement>("#search-mode button").forEach((b) =>
  b.addEventListener("click", () => showSearch(b.dataset.mode as SearchMode)),
);
const searchFlagKeys: Record<keyof TextSearchOptions, string> = {
  matchCase: "searchMatchCase",
  wholeWord: "searchWholeWord",
  regex: "searchRegex",
};
searchDialog.querySelectorAll<HTMLButtonElement>("#search-opts button").forEach((b) =>
  b.addEventListener("click", () => {
    const key = b.dataset.opt as keyof TextSearchOptions;
    searchOpts[key] = !searchOpts[key];
    saveFlag(searchFlagKeys[key], searchOpts[key]);
    renderSearchChrome();
    searchInput.focus();
    runSearch();
  }),
);
$("search-close").addEventListener("click", () => searchDialog.close());
searchDialog.addEventListener("close", () => (searchQueries[searchMode] = searchInput.value));

// Ctrl+click on a word (either side of the diff) searches for it; holding Ctrl underlines it.
for (const ed of [diffEditor.getOriginalEditor(), modifiedEditor]) {
  const link = ed.createDecorationsCollection();
  const wordAt = (e: monaco.editor.IEditorMouseEvent) => {
    const p = e.target.position;
    if (!p || e.target.type !== monaco.editor.MouseTargetType.CONTENT_TEXT) return null;
    const w = ed.getModel()?.getWordAtPosition(p);
    return w ? { ...w, line: p.lineNumber } : null;
  };
  ed.onMouseMove((e) => {
    const w = primaryKey(e.event.browserEvent) ? wordAt(e) : null;
    if (!w) return link.clear();
    link.set([
      { range: new monaco.Range(w.line, w.startColumn, w.line, w.endColumn), options: { inlineClassName: "ctrl-link" } },
    ]);
  });
  ed.onMouseLeave(() => link.clear());
  window.addEventListener("keyup", () => link.clear());
  ed.onMouseDown((e) => {
    if (!primaryKey(e.event.browserEvent) || !e.event.leftButton) return;
    const w = wordAt(e);
    if (!w) return;
    e.event.preventDefault();
    link.clear();
    findReferences(w.word);
  });
  ed.addAction({
    id: "hunkpad.findReferences",
    label: "Find references (text search)",
    contextMenuGroupId: "navigation",
    contextMenuOrder: 1,
    keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.F12],
    run: (ed) => {
      const p = ed.getPosition();
      const w = p && ed.getModel()?.getWordAtPosition(p);
      if (w) findReferences(w.word);
    },
  });
}

/** The editor's selected text (one line), to search for. */
function editorSelection(): string | undefined {
  for (const ed of [modifiedEditor, diffEditor.getOriginalEditor()]) {
    if (!ed.hasTextFocus()) continue;
    const sel = ed.getSelection();
    const text = sel && !sel.isEmpty() ? ed.getModel()?.getValueInRange(sel) : undefined;
    if (text && !text.includes("\n")) return text;
  }
  return undefined;
}

// ---- header actions -------------------------------------------------------

async function pickRepo() {
  const dir = await open({ directory: true, title: "Open Git repository" });
  if (typeof dir === "string") await openRepo(dir).catch(handleOpenError);
}

/** Explains a failed open; for a non-repository folder, suggests repositories inside it. */
async function handleOpenError(e: unknown) {
  if (!(e instanceof NotARepoError)) return showError(e);
  const folder = e.path.replace(/\\/g, "/");
  setStatus(`Not opened: ${folder} is not a Git repository`, true);
  const children = await invoke<string[]>("find_child_repos", { path: e.path }).catch(() => [] as string[]);
  const title = "Not a Git repository";
  const intro = `"${folder}" is not a Git repository, so it was not opened.`;

  if (children.length === 1) {
    const child = children[0];
    const open = await ask(`${intro}\n\nIt contains one repository:\n${child}\n\nOpen that one instead?`, {
      title,
      kind: "warning",
      okLabel: "Open it",
      cancelLabel: "Cancel",
    });
    if (open) await openRepo(child).catch(handleOpenError);
  } else if (children.length > 1) {
    const names = children.slice(0, 12).map((c) => `•  ${c.split("/").pop()}`);
    if (children.length > 12) names.push(`…and ${children.length - 12} more`);
    await message(`${intro}\n\nIt contains ${children.length} repositories:\n${names.join("\n")}\n\nUse Open and pick one of them.`, {
      title,
      kind: "warning",
    });
  } else {
    await message(
      `${intro}\n\nThere is no .git folder here or in any parent folder. Pick the repository's root folder, or clone a repository from the ⋯ menu.`,
      { title, kind: "warning" },
    );
  }
}

async function clone() {
  const url = await promptInput("Repository URL to clone");
  if (!url) return;
  const parent = await open({ directory: true, title: "Clone into which folder?" });
  if (typeof parent !== "string") return;
  await act("Clone", async () => openRepo(await cloneRepo(parent, url)));
}

async function push(force = false) {
  const s = status;
  const r = repo;
  if (!r || !s) return;
  if (!s.branch) return setStatus("Cannot push a detached HEAD; create a branch first", true);
  // Nowhere to push yet: offer to add a remote first, then publish to it.
  if (!s.upstream && !(await r.remotes()).length) {
    if (!(await addRemoteFlow("This repository has no remote yet. Add one to push to:"))) return;
  }
  act(s.upstream ? (force ? "Force push" : "Push") : "Publish branch", () => r.push(!!s.upstream, force));
}

// ---- remotes --------------------------------------------------------------

const remoteDialog = $<HTMLDialogElement>("remote-dialog");
const remoteName = $<HTMLInputElement>("remote-name");
const remoteUrl = $<HTMLInputElement>("remote-url");
const remoteError = $("remote-error");
let answerRemote: ((v: { name: string; url: string; fetch: boolean } | null) => void) | null = null;

/** Add / edit dialog. `existing` edits that remote's URL (name shown read-only). */
async function remoteDialogFor(opts: { title: string; existing?: Remote }) {
  $("remote-dialog-title").textContent = opts.title;
  remoteName.value = opts.existing?.name ?? (branchRemoteNames.includes("origin") ? "" : "origin");
  remoteName.disabled = !!opts.existing;
  remoteUrl.value = opts.existing?.fetchUrl ?? "";
  $("remote-fetch-row").classList.toggle("hidden", !!opts.existing);
  remoteError.textContent = "";
  remoteDialog.showModal();
  (opts.existing || remoteName.value ? remoteUrl : remoteName).focus();
  const result = await new Promise<{ name: string; url: string; fetch: boolean } | null>((resolve) => (answerRemote = resolve));
  answerRemote = null;
  return result;
}

$("remote-save").addEventListener("click", () => {
  const name = remoteName.value.trim();
  const url = remoteUrl.value.trim().replace(/^"(.*)"$/, "$1");
  const taken = !remoteName.disabled && branchRemoteNames.includes(name);
  let error = "";
  if (!name) error = "Enter a name (usually origin).";
  else if (!/^[A-Za-z0-9._\-/]+$/.test(name) || name.startsWith("-")) error = "Use letters, digits, . _ - / only.";
  else if (taken) error = `A remote called “${name}” already exists.`;
  else if (!url) error = "Enter the repository URL.";
  remoteError.textContent = error;
  if (error) return;
  answerRemote?.({ name, url, fetch: $<HTMLInputElement>("remote-fetch").checked });
  remoteDialog.close();
});
$("remote-cancel").addEventListener("click", () => {
  answerRemote?.(null);
  remoteDialog.close();
});
remoteDialog.addEventListener("cancel", () => answerRemote?.(null));
remoteDialog.querySelector("form")!.addEventListener("submit", (e) => {
  e.preventDefault();
  $("remote-save").click();
});
for (const input of [remoteName, remoteUrl]) input.addEventListener("input", () => (remoteError.textContent = ""));

/** Names of the current repo's remotes (for the "already exists" check). */
let branchRemoteNames: string[] = [];

/** Asks for a remote and adds it (and fetches if wanted). Resolves true when added. */
async function addRemoteFlow(title = "Add remote"): Promise<boolean> {
  const r = repo;
  if (!r) return false;
  branchRemoteNames = await r.remotes();
  const v = await remoteDialogFor({ title });
  if (!v) return false;
  let added = false;
  await act(`Add remote ${v.name}`, async () => {
    await r.addRemote(v.name, v.url);
    added = true;
    if (v.fetch) await r.fetchRemote(v.name);
  });
  if (activeTab === "branches") await loadBranches();
  return added;
}

function remoteMenu(rm: Remote): MenuItem[] {
  const r = repo!;
  return [
    { label: `Fetch ${rm.name}`, run: () => act(`Fetch ${rm.name}`, () => r.fetchRemote(rm.name)) },
    { label: "Copy URL", run: () => navigator.clipboard.writeText(rm.fetchUrl) },
    { label: "Sign in…", run: () => signIn(rm).catch(showError) },
    "-",
    {
      label: "Change URL…",
      run: async () => {
        branchRemoteNames = await r.remotes();
        const v = await remoteDialogFor({ title: `Change URL of ${rm.name}`, existing: rm });
        if (v && v.url !== rm.fetchUrl) act(`Change URL of ${rm.name}`, () => r.setRemoteUrl(rm.name, v.url));
      },
    },
    {
      label: "Rename…",
      run: async () => {
        const name = await promptInput(`Rename remote ${rm.name}`, rm.name);
        if (name && name !== rm.name) act(`Rename remote ${rm.name}`, () => r.renameRemote(rm.name, name));
      },
    },
    "-",
    {
      label: "Remove…",
      run: async () => {
        if (await confirmAction(`Remove the remote “${rm.name}” (${rm.fetchUrl}) from this repository? Nothing is deleted on the server.`))
          act(`Remove remote ${rm.name}`, () => r.removeRemote(rm.name));
      },
    },
  ];
}

// ---- sign-in (HTTPS remotes; git.ts) ------------------------------------------

const signinDialog = $<HTMLDialogElement>("signin-dialog");
const signinAccount = $<HTMLInputElement>("signin-account");
const signinToken = $<HTMLInputElement>("signin-token");
const signinError = $("signin-error");
const TOKEN_PAGES = ["github.com", "gitlab.com"];
/** The server the open sign-in dialog is for. */
let signinHost = "";

/** The remote a push goes to: the upstream's, else origin, else the first. */
async function pushRemote(r: Repo): Promise<Remote | undefined> {
  const remotes = await r.remoteList();
  const upstream = status?.upstream ?? "";
  return (
    remotes.filter((rm) => upstream.startsWith(`${rm.name}/`)).sort((a, b) => b.name.length - a.name.length)[0] ??
    remotes.find((rm) => rm.name === "origin") ??
    remotes[0]
  );
}

/** Asks which account `rm` (default: the push remote) signs in with, and saves that login. */
async function signIn(rm?: Remote) {
  const r = repo;
  if (!r) return;
  rm ??= await pushRemote(r);
  if (!rm) return setStatus("This repository has no remote to sign in to", true);
  const url = rm.pushUrl || rm.fetchUrl;
  const t = credentialTarget(url);
  if (!t) return setStatus(`“${rm.name}” is not an HTTPS remote: SSH remotes sign in with an SSH key, set up outside Hunkpad`, true);
  if (!(await r.hasCredentialHelper()))
    return setStatus("Git has no credential helper to keep a login (credential.helper is not set): install Git Credential Manager", true);

  const { account, local } = await r.signInAccount(url);
  signinHost = t.host;
  $("signin-title").textContent = `Sign in to ${t.host}`;
  $("signin-where").textContent =
    `For this repository only, remote “${rm.name}” (${url}). ` +
    (account ? `It now signs in as ${account}.` : `It now uses the default login for ${t.host}.`);
  signinAccount.value = account;
  // An account written in the URL can only change with the URL.
  signinAccount.disabled = !!t.urlUser;
  signinAccount.title = t.urlUser ? "Named in the remote URL: change the URL to use another account" : "";
  signinAccount.placeholder = `Your ${t.host} username`;
  signinToken.value = "";
  $("signin-create").classList.toggle("hidden", !TOKEN_PAGES.includes(t.host));
  $("signin-default").classList.toggle("hidden", !local || !!t.urlUser);
  $("signin-help").textContent =
    `${t.host} does not take your account password here: use a personal access token, created while signed in to ` +
    `${t.host} as that account, with access to this repository` +
    (t.host === "github.com" ? " (classic token: the repo and workflow scopes; without workflow, pushes that change .github/workflows are refused)" : "") +
    ". It is kept by Git's credential helper (e.g. the macOS Keychain), not by Hunkpad.";
  signinError.textContent = "";
  signinDialog.returnValue = "";
  signinDialog.showModal();
  (signinAccount.disabled || signinAccount.value ? signinToken : signinAccount).focus();
  await new Promise((resolve) => signinDialog.addEventListener("close", resolve, { once: true }));

  const remote = rm.name;
  const name = signinAccount.value.trim();
  const token = signinToken.value.trim();
  signinToken.value = "";
  if (signinDialog.returnValue === "ok")
    await act(`Sign in to ${t.host} as ${name}`, () => r.signIn(remote, url, name, token));
  else if (signinDialog.returnValue === "default")
    await act(`Use the default ${t.host} account`, () => r.useDefaultAccount(url));
}

$("signin-save").addEventListener("click", () => {
  if (!signinAccount.value.trim()) return void (signinError.textContent = "Enter the account (username).");
  if (!signinToken.value.trim()) return void (signinError.textContent = "Paste an access token for that account.");
  signinDialog.close("ok");
});
$("signin-default").addEventListener("click", () => signinDialog.close("default"));
$("signin-cancel").addEventListener("click", () => signinDialog.close("cancel"));
$("signin-create").addEventListener("click", () => invoke("open_token_page", { host: signinHost }).catch(showError));
signinDialog.querySelector("form")!.addEventListener("submit", (e) => {
  e.preventDefault();
  $("signin-save").click();
});
for (const input of [signinAccount, signinToken]) input.addEventListener("input", () => (signinError.textContent = ""));

function moreMenu(): MenuItem[] {
  const items: MenuItem[] = [
    { label: keys("Projects…  (Ctrl+R)"), run: showProjects },
    { label: "Open repository…", run: pickRepo },
    { label: "Clone repository…", run: clone },
  ];
  if (!repo) return items;
  const r = repo;
  const pinned = findProject(r.root)?.pinned ?? false;
  return [
    ...items,
    { label: pinned ? "Unpin this project" : "Pin this project", run: () => updateProject(r.root, { pinned: !pinned }) },
    "-",
    { label: "Pull (rebase)", run: () => act("Pull (rebase)", () => r.pull(true, { autostash: pullAutostash })) },
    {
      label: "Force push (with lease)…",
      run: async () => {
        if (await confirmAction("Force push? Remote commits not present locally will be overwritten.")) push(true);
      },
    },
    "-",
    { label: "Add remote…", run: () => addRemoteFlow().catch(showError) },
    { label: "Sign in…", run: () => signIn().catch(showError) },
    { label: "New branch…", run: newBranch },
    { label: "New worktree…", run: () => newWorktreeFlow().catch(showError) },
    { label: "New tag…", run: newTag },
    { label: "Stash changes…", run: () => stashChanges(false) },
    { label: "Stash including untracked…", run: () => stashChanges(true) },
    "-",
    { label: "Undo last commit", run: () => act("Undo last commit", () => r.undoLastCommit()) },
    "-",
    {
      label: `${confirmGit ? "✓ " : ""}Ask before Git commands`,
      run: () => setConfirmGit(!confirmGit),
    },
    {
      label: `${pullAutostash ? "✓ " : ""}Auto-stash on pull`,
      run: () => setPullAutostash(!pullAutostash),
    },
    ...(canCopyAsFile
      ? [
          {
            label: copyAsFile ? "Copy for LLM as: ✓ file  ·  text" : "Copy for LLM as: file  ·  ✓ text",
            run: () => setCopyAsFile(!copyAsFile),
          },
        ]
      : []),
    { label: "Toggle output log", run: toggleOutput },
    "-",
    ...claudeMenu(),
    "-",
    ...mcpMenu(),
  ];
}

function toggleOutput() {
  outputEl.classList.toggle("hidden");
  outputEl.scrollTop = outputEl.scrollHeight;
}

let sideBySide = true;
function toggleLayout() {
  sideBySide = !sideBySide;
  diffEditor.updateOptions({ renderSideBySide: sideBySide });
  $("layout-btn").textContent = sideBySide ? "Inline" : "Side by side";
}

$("add-tab").addEventListener("click", showProjects);
$("app-projects").addEventListener("click", showProjects);
$("app-search").addEventListener("click", () => showSearch("files"));

// ---- side panel width (drag its right edge) -----------------------------------

const SIDE_DEFAULT = 340;
const SIDE_MIN = 220;
const side = document.querySelector("aside")!;
const sideResizer = $("side-resizer");
const sideMax = () => Math.max(SIDE_MIN, Math.round(window.innerWidth * 0.7));
const clampSide = (w: number) => Math.min(sideMax(), Math.max(SIDE_MIN, Math.round(w)));

function setSideWidth(w: number, save: boolean) {
  const width = clampSide(w);
  side.style.width = `${width}px`;
  sideResizer.setAttribute("aria-valuenow", String(width));
  if (save) settings.setItem("sideWidth", String(width));
}

setSideWidth(Number(settings.getItem("sideWidth")) || SIDE_DEFAULT, false);

sideResizer.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  sideResizer.setPointerCapture(e.pointerId);
  document.body.classList.add("resizing-side");
  const left = side.getBoundingClientRect().left;
  const move = (ev: PointerEvent) => setSideWidth(ev.clientX - left, false);
  const end = (ev: PointerEvent) => {
    sideResizer.releasePointerCapture(ev.pointerId);
    sideResizer.removeEventListener("pointermove", move);
    sideResizer.removeEventListener("pointerup", end);
    sideResizer.removeEventListener("pointercancel", end);
    document.body.classList.remove("resizing-side");
    setSideWidth(side.getBoundingClientRect().width, true);
  };
  sideResizer.addEventListener("pointermove", move);
  sideResizer.addEventListener("pointerup", end);
  sideResizer.addEventListener("pointercancel", end);
});
sideResizer.addEventListener("dblclick", () => setSideWidth(SIDE_DEFAULT, true));
sideResizer.addEventListener("keydown", (e) => {
  const step = e.shiftKey ? 64 : 16;
  const now = side.getBoundingClientRect().width;
  if (e.key === "ArrowLeft") setSideWidth(now - step, true);
  else if (e.key === "ArrowRight") setSideWidth(now + step, true);
  else if (e.key === "Home") setSideWidth(SIDE_DEFAULT, true);
  else return;
  e.preventDefault();
});
// A smaller window must not leave the panel wider than the 70% limit.
window.addEventListener("resize", () => {
  const now = side.getBoundingClientRect().width;
  if (now > sideMax()) setSideWidth(now, false);
});
$("branch-btn").addEventListener("click", () =>
  showTab("branches")
    .then(() => branchFilter.select())
    .catch(showError),
);
$("sync-btn").addEventListener("click", () =>
  act("Sync", async () => {
    await repo!.pull(false, { autostash: pullAutostash });
    await repo!.push(true);
  }),
);
$("fetch-btn").addEventListener("click", () => act("Fetch", () => repo!.fetch()));
$("pull-btn").addEventListener("click", () => act("Pull", () => repo!.pull(false, { autostash: pullAutostash })));
$("push-btn").addEventListener("click", () => push());
$("refresh-btn").addEventListener("click", () => refresh().catch(showError));
$("layout-btn").addEventListener("click", toggleLayout);
$("output-btn").addEventListener("click", toggleOutput);
$("more-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  showMenu(r.right - 220, r.bottom, moreMenu());
});

window.addEventListener("keydown", (e) => {
  if (e.key === "F5") {
    e.preventDefault();
    refresh().catch(showError);
  } else if (primaryKey(e) && e.key.toLowerCase() === "o") {
    e.preventDefault();
    pickRepo();
  } else if (primaryKey(e) && e.key.toLowerCase() === "r") {
    // Also stops the WebView's own Ctrl+R page reload.
    e.preventDefault();
    showProjects();
  } else if (primaryKey(e) && !e.shiftKey && e.key.toLowerCase() === "p") {
    // Also stops the WebView's own Ctrl+P print.
    e.preventDefault();
    showSearch("files");
  } else if (primaryKey(e) && e.shiftKey && e.key.toLowerCase() === "f") {
    e.preventDefault();
    showSearch("text", editorSelection());
  } else if (primaryKey(e) && e.key.toLowerCase() === "w") {
    e.preventDefault();
    if (repo) closeTab(repo.root);
  } else if (e.ctrlKey && e.key === "Tab") {
    e.preventDefault();
    cycleTab(e.shiftKey ? -1 : 1);
  } else if (e.key === "Escape") {
    // Esc closes a menu first; otherwise it goes back to the overview.
    if (openMenu) closeMenu();
    else if (target && !document.querySelector("dialog[open]")) clearDiff();
  }
});

// Pick up changes made elsewhere (IDE, terminal) when the window regains focus.
window.addEventListener("focus", () => refresh().catch(showError));

let refreshTimer: number | undefined;
listen("repo-changed", () => {
  clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => refresh().catch(showError), 100);
});

// ---- per-repository data (.hunkpad/, repoStore.ts) ------------------------------

setRepoStoreErrorHandler((message) => setStatus(message, true));
setSettingsErrorHandler((message) => setStatus(message, true));
// The .hunkpad/ row appears in Kept local as soon as the folder exists.
setRepoStoreCreatedHandler((root) => {
  if (repo && samePath(repo.root, root) && status) renderChanges();
});

/** Loads every open tab's .hunkpad data (for colours), then redraws the tabs. */
function loadTabsData() {
  Promise.all([...new Set([...openTabs, ...openTabs.map(groupOf)])].map((p) => loadRepoData(p).catch(() => null)))
    .then(() => renderTabs())
    .catch(showError);
}

// Best effort: write pending changes before the window goes away.
window.addEventListener("beforeunload", () => void flushAll());

// ---- Git missing ------------------------------------------------------------

const gitMissingDialog = $<HTMLDialogElement>("git-missing-dialog");

/** How to install Git on this platform, then "Check again". */
function gitInstallSteps(): HTMLElement[] {
  const code = (s: string) => h("code", {}, s);
  const install = isWindows
    ? h("li", {}, "Download and install Git for Windows (the default options are fine).")
    : isMac
      ? h(
          "li",
          {},
          "Install Apple's Command Line Tools: run ",
          code("xcode-select --install"),
          " in Terminal. With Homebrew, ",
          code("brew install git"),
          " works too.",
        )
      : h(
          "li",
          {},
          "Install it with your package manager, e.g. ",
          code("sudo apt install git"),
          " or ",
          code("sudo dnf install git"),
          ".",
        );
  return [install, h("li", {}, "Come back here and click ", h("b", {}, "Check again"), ". No restart needed.")];
}
$("git-missing-steps").replaceChildren(...gitInstallSteps());

/** Explains that Git is needed, how to install it, and offers "Check again". */
function showGitMissing() {
  setStatus("Git was not found: install Git (git-scm.com)", true);
  $("git-missing-state").textContent = "";
  if (!gitMissingDialog.open) gitMissingDialog.showModal();
}

setGitMissingHandler(showGitMissing);
$("git-missing-close").addEventListener("click", () => gitMissingDialog.close());
$("git-missing-download").addEventListener("click", () => {
  invoke("open_git_download").catch(showError);
  $("git-missing-state").textContent = "Opened git-scm.com in your browser. After installing, click Check again.";
});
$("git-missing-check").addEventListener("click", async () => {
  const version = await invoke<string | null>("git_version");
  if (!version) {
    $("git-missing-state").textContent = "Still not found. Finish the installation, then try again.";
    return;
  }
  gitMissingDialog.close();
  setStatus(`Found ${version}`);
  await startup(); // now open the tabs that could not be opened before
});

// ---- MCP server for Claude Code (mcp.ts, src-tauri/src/mcp.rs) ---------------
//
// Off by default. When on, Claude Code (once installed with `claude mcp add`)
// can see what this window shows and use its features. Git commands it asks for
// go through the usual confirmation dialog.

const MCP_DEFAULT_PORT = 47821;
let mcpOn = loadFlag("mcpServer", false);
let mcpRunning = false;
const mcpPort = () => Number(settings.getItem("mcpPort")) || MCP_DEFAULT_PORT;

function mcpToken(): string {
  let token = settings.getItem("mcpToken");
  if (!token || token.length < 32) {
    token = newToken();
    settings.setItem("mcpToken", token);
  }
  return token;
}

const needRepo = (): Repo => {
  if (!repo) throw new ToolError("No repository is open in Hunkpad.");
  return repo;
};

const needGroup = (r: Repo, id: string): ChangeGroup => {
  const g = loadGroups(r.root).find((x) => x.id === id);
  if (!g) throw new ToolError(`No change group with id ${id}: list them with hunkpad_list_changes.`);
  return g;
};

/** Every unstaged block (not Kept local or conflicted) with its group, also before any group exists. */
async function mcpBlocks(r: Repo): Promise<{ hunk: Hunk; group: string | null }[]> {
  if (loadGroups(r.root).length) return [...hunkMap.values()].flat();
  const kept = keptPathSet();
  const files = changedFiles().filter((f) => f.unstaged && !f.conflict && !kept.has(f.path));
  const wanted = new Set(files.map((f) => f.path));
  const parsed = parseDiffU0(await r.diffU0()).filter((hk) => wanted.has(hk.path));
  for (const f of files) if (f.unstaged === "U") parsed.push(wholeFileHunk(f.path, "untracked"));
  return parsed.map((hunk) => ({ hunk, group: null }));
}

const MCP_MAX_BLOCK_LINES = 80;

function blockInfo(hk: Hunk, group: string | null, includeDiff: boolean) {
  const range = (start: number, count: number) => (count ? `${start}-${start + count - 1}` : `after ${start}`);
  const info: Record<string, unknown> = {
    id: blockId(hk.path, hk.oldStart, hk.sig),
    group,
    ...(hk.whole ? { whole: hk.whole } : { oldLines: range(hk.oldStart, hk.oldCount), newLines: range(hk.newStart, hk.newCount) }),
    added: hk.added.length,
    removed: hk.removed.length,
  };
  if (includeDiff && !hk.whole) {
    if (isSecretPath(hk.path)) info.diff = "(withheld: the file looks like it holds secrets)";
    else {
      const lines = [...hk.removed.map((l) => `-${l}`), ...hk.added.map((l) => `+${l}`)];
      info.diff = lines.slice(0, MCP_MAX_BLOCK_LINES).join("\n") + (lines.length > MCP_MAX_BLOCK_LINES ? `\n… ${lines.length - MCP_MAX_BLOCK_LINES} more lines` : "");
    }
  }
  return info;
}

const mcpHost: McpHost = {
  view() {
    const r = repo;
    const ed = modifiedEditor;
    const pos = target ? ed.getPosition() : null;
    const sel = target ? ed.getSelection() : null;
    const selected = sel && !sel.isEmpty() ? (ed.getModel()?.getValueInRange(sel) ?? "") : "";
    return {
      repo: r
        ? {
            root: r.root,
            name: r.name,
            branch: status?.branch ?? null,
            upstream: status?.upstream ?? null,
            ahead: status?.ahead ?? 0,
            behind: status?.behind ?? 0,
            inProgress: status?.operation ?? null,
            worktrees: worktrees.map((w) => ({
              path: w.path,
              branch: w.branch,
              main: w.main,
              current: samePath(w.path, r.root),
              ...(w.locked !== null ? { locked: true } : {}),
              ...(w.prunable ? { folderMissing: true } : {}),
            })),
          }
        : null,
      openRepos: openTabs,
      sideTab: activeTab,
      compareWith: compareRef,
      file: target
        ? {
            path: target.path,
            view: diffLabel(target),
            markdownPreview: mdPreviewOn && showsMarkdown(),
            cursor: pos ? { line: pos.lineNumber, column: pos.column } : null,
            selection: selected
              ? { fromLine: sel!.startLineNumber, toLine: sel!.endLineNumber, text: selected.slice(0, 4000) }
              : null,
          }
        : null,
    };
  },

  async worktreeSetup() {
    needRepo();
    const main = mainPath();
    await loadRepoData(main).catch(() => null);
    return {
      repo: main,
      saved: !!loadWorktreeSetup(main),
      setup: await effectiveSetup(main),
      worktrees: worktrees.map((w, i) => ({ path: w.path, branch: w.branch, number: i, main: w.main })),
    };
  },

  async setWorktreeSetup(change) {
    needRepo();
    const main = mainPath();
    const cur = await effectiveSetup(main);
    const copy = change.copy ? parseCopyList(change.copy.join("\n")) : cur.copy;
    const bad = copy.filter((p) => !validCopyPath(p));
    if (bad.length) throw new ToolError(`not repo-relative paths: ${bad.join(", ")}`);
    if (change.command !== undefined && /[\r\n]/.test(change.command)) throw new ToolError("command must be one line");
    const next: WorktreeSetup = {
      copy,
      command: change.command?.trim() ?? cur.command,
      basePort: change.basePort === undefined ? cur.basePort : change.basePort,
    };
    const ok = await ask(`Claude Code wants to change the worktree setup of ${projectName(main)}:\n\n${setupLines(next)}`, {
      title: "Hunkpad",
      okLabel: "Save",
      cancelLabel: "Decline",
    });
    if (!ok) return "cancelled";
    saveWorktreeSetup(main, next);
    renderScripts();
    setStatus(`Worktree setup of ${projectName(main)} changed by Claude Code`);
    return "done";
  },

  async runWorktreeSetup(path) {
    needRepo();
    const same = (p: string) => samePath(p, path.replace(/\\/g, "/")) || samePath(p, path);
    const w = worktrees.find((x) => same(x.path));
    if (!w) throw new ToolError(`Not a worktree of the active repository: ${path}`);
    if (w.main) throw new ToolError("That is the main folder: the setup copies from it into the other worktrees");
    if (w.prunable) throw new ToolError(`The folder of this worktree is gone: ${w.path}`);
    const s = await effectiveSetup(mainPath());
    const ok = await ask(`Claude Code wants to set up the worktree ${w.path}:\n\n${setupLines(s)}\n\nExisting files are never overwritten.`, {
      title: "Hunkpad",
      okLabel: "Set it up",
      cancelLabel: "Decline",
    });
    if (!ok) return { outcome: "cancelled" };
    const result = await runSetup(w.path, s);
    return result ? { outcome: "done", ...result } : { outcome: "failed" };
  },

  async switchRepo(root) {
    const same = (p: string) => samePath(p, root.replace(/\\/g, "/")) || samePath(p, root);
    const tab = openTabs.find(same) ?? worktrees.find((w) => same(w.path) && !w.prunable)?.path;
    if (!tab) throw new ToolError(`Not an open tab or a worktree of the active repository: ${root}. Open tabs: ${openTabs.join(", ") || "none"}`);
    await openRepo(tab);
  },

  async changes(includeDiff) {
    const r = needRepo();
    await refresh();
    const files = changedFiles();
    const kept = keptPathSet();
    const blocks = await mcpBlocks(r);
    const byPath = new Map<string, ReturnType<typeof blockInfo>[]>();
    for (const { hunk, group } of blocks) byPath.set(hunk.path, [...(byPath.get(hunk.path) ?? []), blockInfo(hunk, group, includeDiff)]);
    const groups = loadGroups(r.root);
    const active = loadHunkState(r.root).active;
    return {
      repo: r.root,
      staged: files.filter((f) => f.staged).map((f) => ({ path: f.path, status: f.staged, ...(f.origPath ? { from: f.origPath } : {}) })),
      unstaged: files
        .filter((f) => f.unstaged && !f.conflict && !kept.has(f.path))
        .map((f) => ({ path: f.path, status: f.unstaged === "U" ? "untracked" : f.unstaged, blocks: byPath.get(f.path) ?? [] })),
      conflicts: files.filter((f) => f.conflict).map((f) => f.path),
      keptLocal: [...kept],
      groups: groups.map((g) => ({
        id: g.id,
        name: g.name,
        active: g.id === active,
        ...(g.message ? { message: g.message } : {}),
        blocks: blocks.filter((b) => b.group === g.id).length,
      })),
      ungroupedBlocks: blocks.filter((b) => b.group === null).length,
      note: "Kept local files are never committed; their changes are not listed as blocks.",
    };
  },

  createGroup(name, message, makeActive) {
    const r = needRepo();
    const id = newUserId();
    saveGroups(r.root, [...loadGroups(r.root), { id, name, files: [], ...(message ? { message } : {}) }]);
    if (makeActive) saveHunkState(r.root, { ...loadHunkState(r.root), active: id });
    refresh().catch(showError);
    setStatus(`Claude created the group “${name}”`);
    return id;
  },

  updateGroup(id, change) {
    const r = needRepo();
    needGroup(r, id);
    updateGroups((groups) => groups.map((g) => (g.id === id ? { ...g, ...change } : g)));
  },

  deleteGroup(id) {
    deleteGroup(needGroup(needRepo(), id));
  },

  setActiveGroup(id) {
    const r = needRepo();
    if (id !== null) needGroup(r, id);
    setActiveGroup(id);
  },

  async assignBlocks(ids, groupId) {
    const r = needRepo();
    if (groupId !== null) needGroup(r, groupId);
    await refresh();
    const all = await mcpBlocks(r);
    const moved: string[] = [];
    const notFound: string[] = [];
    const chosen = new Set<Hunk>();
    for (const id of ids) {
      const want = parseBlockId(id);
      const same = want ? all.filter((b) => b.hunk.path === want.path && b.hunk.sig === want.sig) : [];
      const hit = same.find((b) => b.hunk.oldStart === want!.oldStart) ?? same[0];
      if (hit) {
        chosen.add(hit.hunk);
        moved.push(id);
      } else notFound.push(id);
    }
    if (chosen.size) {
      const state = loadHunkState(r.root);
      const others = state.hunks.filter((a) => !all.some((b) => sameHunk(a, b.hunk)));
      const next = all.map((b) => assignmentOf(b.hunk, chosen.has(b.hunk) ? groupId : b.group));
      saveHunkState(r.root, { active: state.active, hunks: [...others, ...next] });
      await refresh();
    }
    return { moved, notFound };
  },

  listComments(filter) {
    const r = needRepo();
    return loadComments(r.root)
      .filter((c) => filter === "all" || (filter === "resolved") === c.resolved)
      .map((c) => ({ id: c.id, path: c.path, line: c.line, lineText: c.anchor, text: c.text, resolved: c.resolved }));
  },

  async addComment(path, line, text) {
    const r = needRepo();
    if (!text) throw new ToolError("text is required");
    const content = await r.readWorktree(path);
    if (content === null) throw new ToolError(`No such file in the working tree: ${path}`);
    const lines = content.split(/\r?\n/);
    if (line > lines.length) throw new ToolError(`${path} has ${lines.length} lines`);
    const id = newCommentId();
    const list = loadComments(r.root);
    list.push({ id, path, line, anchor: lines[line - 1].trim(), text, created: Date.now(), resolved: false });
    saveComments(r.root, list);
    commentsChanged();
    setStatus(`Claude commented on ${path}:${line}`);
    return id;
  },

  resolveComment(id, resolved) {
    const r = needRepo();
    if (!loadComments(r.root).some((c) => c.id === id)) throw new ToolError(`No comment with id ${id}`);
    updateComment(id, (c) => (c.resolved = resolved));
  },

  async openFile(path, line) {
    const r = needRepo();
    if (!(await invoke<boolean>("is_file", { path: `${r.root}/${path}` }))) throw new ToolError(`No such file: ${path}`);
    const conflict = !!status?.files.find((f) => f.path === path)?.conflict;
    await showDiff({ kind: "worktree", path, conflict }, { wholeFile: true });
    if (line) revealLine(line, "modified");
  },

  async stageGroup(id) {
    const r = needRepo();
    const g = needGroup(r, id);
    await refresh();
    if (!groupFiles(g.id).length) throw new ToolError(`“${g.name}” has no changes`);
    return stageGroup(g.id);
  },

  async commitGroup(id, message) {
    const r = needRepo();
    const g = needGroup(r, id);
    await refresh();
    if (status?.operation) throw new ToolError(`A ${status.operation} is in progress: the user must finish or abort it first`);
    const files = groupFiles(g.id);
    if (!files.length) throw new ToolError(`“${g.name}” has no changes to commit`);
    const text = message?.trim() || g.message?.trim();
    if (!text) throw new ToolError("Give a commit message (the group has no suggested one)");
    return commitGroupNow(g, files, text);
  },
};

listen<{ id: number; method: string; params: unknown }>("mcp-request", async (e) => {
  const { id, method, params } = e.payload;
  const response = await handleMcp(mcpHost, method, params).catch((err) => ({
    error: { code: -32603, message: errorText(err) },
  }));
  invoke("mcp_reply", { id, response }).catch(() => {});
});

async function startMcp(): Promise<boolean> {
  try {
    // A restart (e.g. the page reloads) stops the old listener first; its port can
    // take a moment to be free again, so binding is retried briefly.
    for (let attempt = 1; ; attempt++) {
      try {
        await invoke("mcp_start", { port: mcpPort(), token: mcpToken() });
        break;
      } catch (e) {
        if (attempt === 8) throw e;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    mcpRunning = true;
    return true;
  } catch (e) {
    mcpRunning = false;
    setStatus(`MCP server: ${errorText(e)}`, true);
    return false;
  } finally {
    renderMcpButton();
  }
}

/** The Quick row's button: its dot shows whether the server runs; a click turns it on, or opens its menu. */
function renderMcpButton() {
  const btn = $("qa-mcp");
  btn.classList.toggle("on", mcpOn && mcpRunning);
  btn.classList.toggle("failed", mcpOn && !mcpRunning);
  btn.title = !mcpOn
    ? "Let Claude Code see and use Hunkpad (turns on a local MCP server)"
    : mcpRunning
      ? `Claude Code can use Hunkpad: ${mcpUrl(mcpPort())}. Click for options.`
      : "The MCP server is on but not running. Click for options.";
}

$("qa-mcp").addEventListener("click", (e) => {
  e.stopPropagation();
  if (!mcpOn) return void turnOnMcp().catch(showError);
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  showMenu(r.left, r.bottom, mcpMenu());
});

async function turnOnMcp() {
  const ok = await ask(
    "Let Claude Code see and use Hunkpad?\n\n" +
      `Hunkpad will run a local MCP server on ${mcpUrl(mcpPort())} (this computer only, protected by a secret token). ` +
      "Claude Code can then see the open repository, file, cursor and selection, changes, change groups and comments, " +
      "organise groups, comment and open files. Git commands it asks for (stage or commit a group) are shown to you here first.\n\n" +
      "Next, Hunkpad can add it to Claude Code (claude mcp add, for all your projects).",
    { title: "Hunkpad MCP server", okLabel: "Turn on" },
  );
  if (!ok) return;
  mcpOn = true;
  saveFlag("mcpServer", true);
  if (!(await startMcp())) return;
  setStatus(`MCP server on: ${mcpUrl(mcpPort())}`);
  await installMcp();
}

async function turnOffMcp() {
  await invoke("mcp_stop").catch(showError);
  mcpOn = mcpRunning = false;
  saveFlag("mcpServer", false);
  renderMcpButton();
  setStatus("MCP server off (Claude Code keeps its entry until you remove it)");
}

/** `claude mcp add` for the user scope, replacing an older entry. */
async function installMcp() {
  const shown = installArgs(mcpPort(), "<token>").join(" ");
  const ok = await ask(`Add Hunkpad to Claude Code, for all your projects?\n\nclaude ${shown}`, {
    title: "Hunkpad MCP server",
    okLabel: "Add",
  });
  if (!ok) return;
  const cwd = repo?.root ?? ".";
  try {
    await invoke("run_claude", { cwd, args: removeArgs(), stdin: "", id: 0 }); // fine if it was not there
    const out = await invoke<{ code: number; stdout: string; stderr: string }>("run_claude", {
      cwd,
      args: installArgs(mcpPort(), mcpToken()),
      stdin: "",
      id: 0,
    });
    if (out.code !== 0) throw new Error((out.stderr || out.stdout).trim() || `claude exited with code ${out.code}`);
    await message(
      "Added. In Claude Code, start a new session (or run /mcp) and Hunkpad's tools are there, e.g. " +
        "“look at what I have open in Hunkpad” or “organise my changes into groups”.\n\n" +
        "Hunkpad must be running for Claude to reach it.",
      { title: "Hunkpad MCP server", kind: "info" },
    );
  } catch (e) {
    const text = errorText(e);
    await message(
      text.includes("CLAUDE_NOT_FOUND")
        ? "The claude command line was not found. Install Claude Code (claude.com/claude-code), then try again."
        : `Could not add it: ${text}`,
      { title: "Hunkpad MCP server", kind: "error" },
    );
  }
}

async function uninstallMcp() {
  const out = await invoke<{ code: number; stdout: string; stderr: string }>("run_claude", {
    cwd: repo?.root ?? ".",
    args: removeArgs(),
    stdin: "",
    id: 0,
  }).catch((e) => ({ code: 1, stdout: "", stderr: errorText(e) }));
  setStatus(out.code === 0 ? "Removed Hunkpad from Claude Code" : `claude mcp remove: ${(out.stderr || out.stdout).trim()}`, out.code !== 0);
}

/** A new token: Claude Code's old entry stops working, so it is reinstalled. */
async function newMcpToken() {
  settings.setItem("mcpToken", newToken());
  if (mcpOn) await startMcp();
  await installMcp();
}

function mcpMenu(): MenuItem[] {
  if (!mcpOn) return [{ label: "Claude Code can use Hunkpad (MCP)…", run: () => turnOnMcp().catch(showError) }];
  return [
    { label: `MCP server: ${mcpRunning ? `on, ${mcpUrl(mcpPort())}` : "not running (retry)"}`, run: () => startMcp().catch(showError) },
    { label: "MCP: add to Claude Code…", run: () => installMcp().catch(showError) },
    { label: "MCP: remove from Claude Code", run: () => uninstallMcp().catch(showError) },
    { label: "MCP: new token (and re-add)…", run: () => newMcpToken().catch(showError) },
    { label: "Turn off MCP server", run: () => turnOffMcp().catch(showError) },
  ];
}

renderMcpButton();
if (mcpOn) startMcp().catch(showError);

// ---- startup --------------------------------------------------------------

// Restore the Git users and the active user's tabs. A path on the command line
// (e.g. an IDE external tool) is opened as a tab and wins; else the last active tab.
async function startup() {
  const users = loadUsers();
  gitUsers = users.users;
  activeUserId = users.active;
  const saved = loadUserTabs(activeUserId);
  openTabs = saved.paths;
  renderTabs();
  // Without Git nothing can be opened: say so, and keep every tab as it is.
  if (!(await invoke<string | null>("git_version"))) return showGitMissing();
  await loadGlobalIdentity().catch(showError);
  loadTabsData();
  const cli = await invoke<string | null>("initial_repo");
  const first = cli ?? saved.active ?? openTabs[0];
  if (!first) return;
  try {
    await openRepo(first);
  } catch (e) {
    showError(e);
    // A remembered tab whose folder is gone is dropped (but not when Git is the problem).
    if (!cli && !(e instanceof GitNotFoundError)) closeTab(first);
  }
}

localizeShortcuts(document.body);
startup().catch(showError);
