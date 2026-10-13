// Which OS Hunkpad runs on, and the conventions that differ between them:
// the shortcut modifier (Cmd on macOS, Ctrl elsewhere), how shortcuts are
// written, and whether paths are case-sensitive.

const ua = navigator.userAgent;
export const isMac = /Mac/.test(ua);
export const isWindows = /Windows/.test(ua);
export const isLinux = !isMac && !isWindows;

/** Paths are case-insensitive on Windows and (by default) macOS, case-sensitive on Linux. */
export const pathKey = (p: string) => (isLinux ? p : p.toLowerCase());
export const samePath = (a: string, b: string) => pathKey(a) === pathKey(b);

/** The main shortcut modifier is held: Cmd on macOS, Ctrl elsewhere. */
export const primaryKey = (e: KeyboardEvent | MouseEvent) => (isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey);

/**
 * Shortcuts are written "Ctrl+R" in the source; on macOS they read "⌘R".
 * Ctrl+Tab really is Ctrl on every platform, so it stays as it is.
 */
export function keys(text: string): string {
  if (!isMac) return text;
  return text.replace(/Ctrl\+(Alt\+)?(Shift\+)?(\w+)/g, (all, alt, shift, key: string) =>
    key === "Tab" ? all : `${alt ? "⌥" : ""}${shift ? "⇧" : ""}⌘${key === "Enter" ? "↩" : key}`,
  );
}

/** Rewrites the shortcuts written in index.html (titles, placeholders, text) for this platform. */
export function localizeShortcuts(root: HTMLElement) {
  if (!isMac) return;
  for (const el of root.querySelectorAll<HTMLElement>("[title], [placeholder]")) {
    for (const attr of ["title", "placeholder"]) {
      const v = el.getAttribute(attr);
      if (v?.includes("Ctrl+")) el.setAttribute(attr, keys(v));
    }
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeValue?.includes("Ctrl+")) n.nodeValue = keys(n.nodeValue);
  }
}
