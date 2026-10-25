// Per-repository Hunkpad data, stored inside the repository in `.hunkpad/`:
//
//   .hunkpad/.gitignore "*"  → Git ignores the whole folder (itself included),
//                              so it is always kept local and never committed.
//   .hunkpad/state.json       colour, favourites, change groups, block
//                              assignments, Kept local list, scripts, comments.
//
// Reads happen once per repository (loadRepoData); after that the data is
// served from memory and every change is written back shortly after (debounced,
// and only when something actually changed). The folder is created on the
// first real save. Data from older versions (kept in the app settings) moves
// into the folder the first time the repository is opened.

import { invoke } from "@tauri-apps/api/core";
import type { ChangeGroup, HunkState, UserScript } from "./projects";
import type { ReviewComment } from "./comments";
import { pathKey } from "./platform";
import { settings } from "./settings";

export const DATA_DIR = ".hunkpad";
const STATE_FILE = `${DATA_DIR}/state.json`;
const IGNORE_FILE = `${DATA_DIR}/.gitignore`;

export interface RepoData {
  version: 1;
  color: string | null;
  /** Favourite refs as `<kind>:<name>`. */
  favourites: string[];
  changeGroups: ChangeGroup[];
  hunks: HunkState;
  keptLocal: string[];
  scripts: UserScript[];
  /** Review comments on lines (comments.ts). */
  comments: ReviewComment[];
  /** How new worktrees are prepared (kept in the main work tree's data); null = the defaults. */
  worktreeSetup: WorktreeSetup | null;
}

export interface WorktreeSetup {
  /** Repo-relative files or folders copied from the main work tree. */
  copy: string[];
  /** Command line run in the new worktree, e.g. `pnpm install`; "" for none. */
  command: string;
  /** Scripts get PORT = basePort + the worktree's number. */
  basePort: number | null;
}

const empty = (): RepoData => ({
  version: 1,
  color: null,
  favourites: [],
  changeGroups: [],
  hunks: { active: null, hunks: [] },
  keptLocal: [],
  scripts: [],
  comments: [],
  worktreeSetup: null,
});
const EMPTY_JSON = JSON.stringify(empty());

interface Entry {
  /** The repository root as given (cache keys are lower-cased). */
  root: string;
  data: RepoData;
  /** JSON of what is on disk (or of nothing, before the first save). */
  saved: string;
  /** state.json exists in the repository. */
  exists: boolean;
  timer?: number;
  /** Settings keys migrated into this repo; removed once safely written. */
  migrated: string[];
}

const cache = new Map<string, Entry>();
const key = pathKey;

let reportError: (message: string) => void = () => {};
export function setRepoStoreErrorHandler(fn: (message: string) => void) {
  reportError = fn;
}

let onCreated: (root: string) => void = () => {};
/** Called once when a repository's .hunkpad folder is first written. */
export function setRepoStoreCreatedHandler(fn: (root: string) => void) {
  onCreated = fn;
}

const arr = <T>(v: unknown, ok: (x: unknown) => boolean): T[] => (Array.isArray(v) ? (v.filter(ok) as T[]) : []);

/** Tolerates hand-edited or older files: anything malformed falls back to empty. */
function normalize(raw: unknown): RepoData {
  const v = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const hunks = (v.hunks && typeof v.hunks === "object" ? v.hunks : {}) as Record<string, unknown>;
  return {
    version: 1,
    color: typeof v.color === "string" ? v.color : null,
    favourites: arr<string>(v.favourites, (x) => typeof x === "string"),
    changeGroups: arr<ChangeGroup>(v.changeGroups, (g) => typeof (g as ChangeGroup)?.id === "string"),
    hunks: {
      active: typeof hunks.active === "string" ? hunks.active : null,
      hunks: arr(hunks.hunks, (a) => typeof (a as { path?: unknown })?.path === "string"),
    },
    keptLocal: arr<string>(v.keptLocal, (x) => typeof x === "string"),
    scripts: arr<UserScript>(v.scripts, (s) => typeof (s as UserScript)?.path === "string"),
    comments: arr<ReviewComment>(
      v.comments,
      (c) => typeof (c as ReviewComment)?.path === "string" && typeof (c as ReviewComment)?.text === "string",
    ),
    worktreeSetup: setupFrom(v.worktreeSetup),
  };
}

function setupFrom(raw: unknown): WorktreeSetup | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  const port = typeof v.basePort === "number" && Number.isInteger(v.basePort) && v.basePort > 0 ? v.basePort : null;
  return { copy: arr<string>(v.copy, (x) => typeof x === "string"), command: typeof v.command === "string" ? v.command : "", basePort: port };
}

function readLocal(k: string): unknown {
  try {
    const raw = settings.getItem(k);
    return raw === null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Collects this repository's data from where older versions kept it (the app settings). */
function fromLocalStorage(root: string): { data: RepoData; keys: string[] } {
  const k = key(root);
  const keys = [`favourites:${k}`, `changeGroups:${k}`, `hunkGroups:${k}`, `keptLocal:${k}`, `scripts:${k}`];
  const colors = (readLocal("repoColors") ?? {}) as Record<string, string>;
  const data = normalize({
    color: colors[k] ?? null,
    favourites: readLocal(keys[0]),
    changeGroups: readLocal(keys[1]),
    hunks: readLocal(keys[2]),
    keptLocal: readLocal(keys[3]),
    scripts: readLocal(keys[4]),
  });
  return { data, keys: keys.filter((x) => readLocal(x) !== undefined) };
}

/** Loads a repository's data (once); later calls are instant. */
export async function loadRepoData(root: string): Promise<RepoData> {
  const k = key(root);
  const cached = cache.get(k);
  if (cached) return cached.data;
  let text: string | null = null;
  try {
    // The folder was first called .dspane, then .diffpane: rename it if that is what this repo has.
    const old = await invoke<string | null>("migrate_data_dir", { repo: root });
    if (old) reportError(`Renamed ${root}/${old} to ${DATA_DIR}`);
  } catch (e) {
    reportError(String(e));
  }
  try {
    text = await invoke<string | null>("read_file", { repo: root, path: STATE_FILE });
  } catch {
    text = null; // unreadable: start empty, a save will report the problem
  }
  const raced = cache.get(k);
  if (raced) return raced.data;

  let entry: Entry;
  if (text !== null) {
    let parsed: unknown = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      reportError(`${root}/${STATE_FILE} is not valid JSON: starting from empty data`);
    }
    const data = normalize(parsed);
    entry = { root, data, saved: JSON.stringify(data), exists: true, migrated: [] };
  } else {
    const { data, keys } = fromLocalStorage(root);
    entry = { root, data, saved: EMPTY_JSON, exists: false, migrated: keys };
  }
  cache.set(k, entry);
  if (entry.migrated.length) scheduleSave(root);
  return entry.data;
}

/** The data in memory (empty if the repository has not been loaded yet). */
export function repoData(root: string): RepoData {
  return cache.get(key(root))?.data ?? empty();
}

/** Whether `.hunkpad/state.json` exists for this repository. */
export const hasRepoData = (root: string) => cache.get(key(root))?.exists ?? false;

/** Changes a repository's data and saves it shortly after. */
export function updateRepoData(root: string, change: (data: RepoData) => void) {
  const k = key(root);
  let entry = cache.get(k);
  if (!entry) {
    entry = { root, data: empty(), saved: EMPTY_JSON, exists: false, migrated: [] };
    cache.set(k, entry);
  }
  change(entry.data);
  scheduleSave(root);
}

function scheduleSave(root: string) {
  const entry = cache.get(key(root));
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.timer = window.setTimeout(() => void flush(root), 250);
}

async function flush(root: string) {
  const entry = cache.get(key(root));
  if (!entry) return;
  const json = JSON.stringify(entry.data);
  if (json === entry.saved) return; // nothing changed
  if (!entry.exists && json === EMPTY_JSON) return; // never create the folder for nothing
  try {
    // The ignore file first, so Git never sees an unignored state.json.
    const ignore = await invoke<string | null>("read_file", { repo: root, path: IGNORE_FILE });
    if (ignore === null) {
      await invoke("write_file", {
        repo: root,
        path: IGNORE_FILE,
        content: "# Hunkpad data: local to this machine, never committed.\n*\n",
      });
    }
    await invoke("write_file", { repo: root, path: STATE_FILE, content: `${JSON.stringify(entry.data, null, 2)}\n` });
    entry.saved = json;
    const created = !entry.exists;
    entry.exists = true;
    if (created) onCreated(entry.root);
    // Older copies in the app settings are only removed once the data is safely on disk.
    for (const k of entry.migrated) settings.removeItem(k);
    if (entry.migrated.length) {
      const colors = (readLocal("repoColors") ?? {}) as Record<string, string>;
      delete colors[key(root)];
      settings.setItem("repoColors", JSON.stringify(colors));
      entry.migrated = [];
    }
  } catch (e) {
    reportError(`Could not save Hunkpad data in ${root}/${DATA_DIR}: ${e}`);
  }
}

/** Writes every pending change now (e.g. before the window closes). */
export async function flushAll() {
  await Promise.all(
    [...cache.values()].map((e) => {
      clearTimeout(e.timer);
      return flush(e.root);
    }),
  );
}
