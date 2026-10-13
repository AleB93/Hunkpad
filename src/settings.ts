// App-wide settings (Git users, projects, open tabs, view mode…), kept in
// settings.json in the OS app-data folder:
//   Windows  %APPDATA%\io.github.aleb93.hunkpad\settings.json
//   macOS    ~/Library/Application Support/io.github.aleb93.hunkpad/settings.json
//   Linux    ~/.config/io.github.aleb93.hunkpad/settings.json
//
// Same API as localStorage (string values), read synchronously from memory:
// `loadSettings()` must finish before the app starts (see boot.ts). Every change
// is written straight away. Older versions kept these in the WebView's
// localStorage; they are copied over on the first start.

import { invoke } from "@tauri-apps/api/core";

const VERSION = 1;

interface SettingsFile {
  version: number;
  values: Record<string, string>;
}

let values: Record<string, string> = {};
let writing: Promise<void> = Promise.resolve();

let reportError: (message: string) => void = (m) => console.error(m);
export function setSettingsErrorHandler(fn: (message: string) => void) {
  reportError = fn;
}

function fromLocalStorage(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      const v = k === null ? null : localStorage.getItem(k);
      if (k !== null && v !== null) out[k] = v;
    }
  } catch {
    // storage unavailable: nothing to copy
  }
  return out;
}

/** Reads settings.json (or, the first time, what older versions left in localStorage). */
export async function loadSettings(): Promise<void> {
  let text: string | null = null;
  try {
    text = await invoke<string | null>("load_settings");
  } catch (e) {
    reportError(`Could not read the settings: ${e}`);
  }
  if (text === null) {
    values = fromLocalStorage();
    if (Object.keys(values).length) save();
    return;
  }
  try {
    const parsed = JSON.parse(text) as Partial<SettingsFile>;
    values = parsed.values && typeof parsed.values === "object" ? { ...parsed.values } : {};
  } catch {
    reportError("settings.json is not valid JSON: starting from default settings");
    values = {};
  }
}

function save() {
  const content = JSON.stringify({ version: VERSION, values } satisfies SettingsFile, null, 2);
  // One write at a time, in order, so an older state never overwrites a newer one.
  writing = writing
    .then(() => invoke<void>("save_settings", { content }))
    .catch((e) => reportError(`Could not save the settings: ${e}`));
}

export const settings = {
  getItem(key: string): string | null {
    return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
  },
  setItem(key: string, value: string) {
    if (values[key] === value) return;
    values[key] = value;
    save();
  },
  removeItem(key: string) {
    if (!(key in values)) return;
    delete values[key];
    save();
  },
};
