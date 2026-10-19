// App-wide data (Git users, tabs, saved projects) lives in the app settings
// (settings.ts). Per-repository data (colour, favourites, change groups, Kept
// local, scripts) lives inside each repository, in .hunkpad/ (see repoStore.ts);
// the functions for it below keep their names but read and write that store.
import type { HunkAssignment } from "./hunks";
import { samePath } from "./platform";
import { repoData, updateRepoData } from "./repoStore";
import { settings } from "./settings";

export interface Project {
  path: string;
  name: string;
  pinned: boolean;
  lastOpened: number;
}

const KEY = "projects";
const MAX_RECENT = 20;

function load(): Project[] {
  try {
    const list: unknown = JSON.parse(settings.getItem(KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((p): p is Project => typeof p?.path === "string") : [];
  } catch {
    return [];
  }
}

function save(list: Project[]) {
  try {
    settings.setItem(KEY, JSON.stringify(list));
  } catch {
    // storage unavailable: the list just won't persist
  }
}

/** Pinned first (by name), then recent (most recently opened first). */
export function listProjects(): Project[] {
  return load().sort((a, b) =>
    a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : a.pinned ? a.name.localeCompare(b.name) : b.lastOpened - a.lastOpened,
  );
}

export function lastOpenedProject(): Project | null {
  return load().reduce<Project | null>((best, p) => (!best || p.lastOpened > best.lastOpened ? p : best), null);
}

export function findProject(path: string): Project | null {
  return load().find((p) => samePath(p.path, path)) ?? null;
}

/** Records that `path` was opened, adding it to the list if new. */
export function touchProject(path: string, name: string) {
  const list = load();
  const existing = list.find((p) => samePath(p.path, path));
  if (existing) existing.lastOpened = Date.now();
  else list.push({ path, name, pinned: false, lastOpened: Date.now() });

  const recent = list.filter((p) => !p.pinned).sort((a, b) => b.lastOpened - a.lastOpened);
  const dropped = new Set(recent.slice(MAX_RECENT));
  save(list.filter((p) => !dropped.has(p)));
}

export function updateProject(path: string, patch: Partial<Omit<Project, "path">>) {
  save(load().map((p) => (samePath(p.path, path) ? { ...p, ...patch } : p)));
}

export function removeProject(path: string) {
  save(load().filter((p) => !samePath(p.path, path)));
}

// ---- favourite branches & tags (per repository: .hunkpad/state.json) ---------

/** Favourite refs of a repository, as `<kind>:<name>` keys. */
export function favouriteRefs(repo: string): Set<string> {
  return new Set(repoData(repo).favourites);
}

/** Adds or removes a favourite; returns whether it is now a favourite. */
export function toggleFavourite(repo: string, key: string): boolean {
  let now = false;
  updateRepoData(repo, (d) => {
    now = !d.favourites.includes(key);
    d.favourites = now ? [...d.favourites, key] : d.favourites.filter((k) => k !== key);
  });
  return now;
}

// ---- open tabs & tab colours ----------------------------------------------

const TABS_KEY = "openTabs";

export const REPO_COLORS = [
  { name: "Red", value: "#e5534b" },
  { name: "Orange", value: "#e0823d" },
  { name: "Yellow", value: "#d4a72c" },
  { name: "Green", value: "#3fb950" },
  { name: "Teal", value: "#2ea8a0" },
  { name: "Blue", value: "#4c8eda" },
  { name: "Purple", value: "#a371f7" },
  { name: "Pink", value: "#db61a2" },
  { name: "Grey", value: "#8b949e" },
];

// ---- Git users (first tab row) ---------------------------------------------
//
// A Git user groups repository tabs and carries a commit identity. The identity
// is passed as `git -c user.name=… -c user.email=…` on each command, so nothing
// is ever written into a repository's config.

export interface GitUser {
  id: string;
  label: string;
  /** Empty name and email = use the global Git identity. */
  authorName: string;
  authorEmail: string;
  color: string | null;
}

const USERS_KEY = "gitUsers";
const userTabsKey = (id: string) => `userTabs:${id}`;

function read<T>(key: string, fallback: T): T {
  try {
    const raw = settings.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    if (value === undefined) settings.removeItem(key);
    else settings.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable: just won't persist
  }
}

export function newUserId(): string {
  return `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** All Git users and the active one. The first run creates "Default" and moves any old tabs into it. */
export function loadUsers(): { users: GitUser[]; active: string } {
  const saved = read<{ users?: GitUser[]; active?: string }>(USERS_KEY, {});
  const users = Array.isArray(saved.users) ? saved.users.filter((u) => typeof u?.id === "string") : [];
  if (users.length) {
    const active = users.some((u) => u.id === saved.active) ? saved.active! : users[0].id;
    return { users, active };
  }
  const fallback: GitUser = { id: "default", label: "Default", authorName: "", authorEmail: "", color: null };
  const oldTabs = read<{ paths?: string[]; active?: string | null } | null>(TABS_KEY, null);
  if (oldTabs) {
    saveUserTabs(fallback.id, oldTabs.paths ?? [], oldTabs.active ?? null);
    write(TABS_KEY, undefined);
  }
  saveUsers([fallback], fallback.id);
  return { users: [fallback], active: fallback.id };
}

export function saveUsers(users: GitUser[], active: string) {
  write(USERS_KEY, { users, active });
}

export function loadUserTabs(id: string): { paths: string[]; active: string | null } {
  const v = read<{ paths?: unknown; active?: unknown }>(userTabsKey(id), {});
  const paths = Array.isArray(v.paths) ? v.paths.filter((p): p is string => typeof p === "string") : [];
  return { paths, active: typeof v.active === "string" ? v.active : null };
}

export function saveUserTabs(id: string, paths: string[], active: string | null) {
  write(userTabsKey(id), { paths, active });
}

export function deleteUserTabs(id: string) {
  write(userTabsKey(id), undefined);
}

/** A repository's tab colour (from its .hunkpad data; null until loaded or unset). */
export function repoColor(path: string): string | null {
  return repoData(path).color;
}

export function setRepoColor(path: string, color: string | null) {
  updateRepoData(path, (d) => (d.color = color));
}

// ---- change groups (per repository, local only) ----------------------------
//
// Groups organise working changes into "waves" of development. Git has no such
// concept, so they exist only here, in the app's storage on this machine: never
// committed, pushed or written into the repository.

export interface ChangeGroup {
  id: string;
  name: string;
  /** Repo-relative paths; a file is in at most one group. */
  files: string[];
  collapsed?: boolean;
  /** Suggested commit message (e.g. from Claude), offered when the group is committed. */
  message?: string;
}

const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function loadGroups(repo: string): ChangeGroup[] {
  return copy(repoData(repo).changeGroups);
}

export function saveGroups(repo: string, groups: ChangeGroup[]) {
  updateRepoData(repo, (d) => (d.changeGroups = copy(groups)));
}

/** Default group name: "Group 2026-10-12 14:30" (local time). */
export function defaultGroupName(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `Group ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`;
}

// ---- block-level assignments (which group owns each change block) ----------

export interface HunkState {
  /** Group that receives new change blocks; null = Ungrouped. */
  active: string | null;
  hunks: HunkAssignment[];
}

export function loadHunkState(repo: string): HunkState {
  return copy(repoData(repo).hunks);
}

export function saveHunkState(repo: string, state: HunkState) {
  updateRepoData(repo, (d) => (d.hunks = copy(state)));
}

// ---- "Kept local": files whose changes are never staged ---------------------
//
// For local-only edits (settings, secrets for dev) that must never be committed
// but should not go in .gitignore. Kept until the user removes them, even while
// they have no changes. Stored only here; Git itself is not told anything.

export function loadKeptLocal(repo: string): string[] {
  return [...repoData(repo).keptLocal];
}

export function saveKeptLocal(repo: string, paths: string[]) {
  updateRepoData(repo, (d) => (d.keptLocal = [...new Set(paths)].sort()));
}

// ---- user scripts (per repository) ----------------------------------------

export interface UserScript {
  id: string;
  name: string;
  /** Absolute path of an existing script file, or of a package.json when `npm` is set. */
  path: string;
  /** An npm script from that package.json, run with `npm run` in its folder. */
  npm?: string;
}

/** The script names of a package.json, in file order; [] when it has none or is not valid JSON. */
export function npmScriptNames(packageJson: string): string[] {
  try {
    const scripts = JSON.parse(packageJson)?.scripts;
    if (!scripts || typeof scripts !== "object") return [];
    return Object.keys(scripts).filter((k) => typeof scripts[k] === "string");
  } catch {
    return [];
  }
}

export function loadScripts(repo: string): UserScript[] {
  return copy(repoData(repo).scripts);
}

export function saveScripts(repo: string, scripts: UserScript[]) {
  updateRepoData(repo, (d) => (d.scripts = copy(scripts)));
}
