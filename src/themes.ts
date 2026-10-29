// Extra colour themes. Each one is the app's colour tokens (the same CSS variables
// the built-in themes set in styles.css) plus a Monaco theme for the diff editor.
// Their signature touches (stripes, glows, little animations) are CSS rules on
// [data-theme="<id>"] in styles.css. "Auto" picks a seasonal theme by date.

export type Tokens = {
  bg: string;
  bgSide: string;
  fg: string;
  muted: string;
  border: string;
  hover: string;
  selected: string;
  accent: string;
  accentFg: string;
  banner: string;
  mod: string;
  add: string;
  del: string;
  ren: string;
};

export interface ExtraTheme {
  id: string;
  label: string;
  group: "Practical" | "Fun" | "Seasonal & cultural";
  dark: boolean;
  tokens: Tokens;
  /** Monaco: syntax colours (hex without #) and a few editor colours. */
  syntax: { comment: string; keyword: string; string: string; number: string; type: string };
  /** Diff colours in the editor; defaults to the add / del tokens. */
  diff?: { add: string; del: string };
}

const t = (
  bg: string, bgSide: string, fg: string, muted: string, border: string, hover: string, selected: string,
  accent: string, accentFg: string, banner: string, mod: string, add: string, del: string, ren: string,
): Tokens => ({ bg, bgSide, fg, muted, border, hover, selected, accent, accentFg, banner, mod, add, del, ren });

const s = (comment: string, keyword: string, string: string, number: string, type: string) => ({
  comment, keyword, string, number, type,
});

export const EXTRA_THEMES: ExtraTheme[] = [
  // ---- practical ----
  {
    id: "contrast", label: "High contrast", group: "Practical", dark: true,
    tokens: t("#000000", "#000000", "#ffffff", "#e0e0e0", "#ffffff", "#1f1f1f", "#003a8c", "#ffff00", "#000000", "#4d3d00", "#ffd000", "#00ff66", "#ff5c5c", "#66ccff"),
    syntax: s("c0c0c0", "ffff00", "00ff66", "ff9cff", "66ccff"),
  },
  {
    // Blue / orange instead of green / red: readable with red-green colour blindness.
    id: "colorblind", label: "Colour-blind safe", group: "Practical", dark: true,
    tokens: t("#1e1e1e", "#252526", "#d4d4d4", "#9a9a9a", "#3a3a3a", "#2a2d2e", "#264f78", "#4da3ff", "#0b1a2a", "#4b3b00", "#ffd166", "#4da3ff", "#ff9f1c", "#c3a6ff"),
    syntax: s("8a8a8a", "c3a6ff", "ffd166", "ff9f1c", "4da3ff"),
  },
  {
    id: "solarized-light", label: "Solarized light", group: "Practical", dark: false,
    tokens: t("#fdf6e3", "#eee8d5", "#475b62", "#93a1a1", "#ddd6c1", "#e6dfc8", "#d3e5f0", "#268bd2", "#fdf6e3", "#f5e7b8", "#b58900", "#859900", "#dc322f", "#2aa198"),
    syntax: s("93a1a1", "859900", "2aa198", "d33682", "b58900"),
  },
  {
    id: "solarized-dark", label: "Solarized dark", group: "Practical", dark: true,
    tokens: t("#002b36", "#073642", "#93a1a1", "#657b83", "#0d4a58", "#0a3f4c", "#114f5e", "#268bd2", "#fdf6e3", "#3b3200", "#b58900", "#859900", "#dc322f", "#2aa198"),
    syntax: s("586e75", "859900", "2aa198", "d33682", "b58900"),
  },
  {
    id: "nord", label: "Nord", group: "Practical", dark: true,
    tokens: t("#2e3440", "#3b4252", "#e5e9f0", "#9aa5b8", "#4c566a", "#434c5e", "#4c5e7a", "#88c0d0", "#2e3440", "#4f4a32", "#ebcb8b", "#a3be8c", "#bf616a", "#81a1c1"),
    syntax: s("6b7a94", "81a1c1", "a3be8c", "b48ead", "8fbcbb"),
  },
  {
    id: "sepia", label: "Sepia / Paper", group: "Practical", dark: false,
    tokens: t("#f4ecd8", "#ebe0c6", "#433422", "#7a6a52", "#d6c7a5", "#e3d6b8", "#e8d3a6", "#8b4513", "#fff8e8", "#f0dca8", "#9a6b00", "#4f7a28", "#a33a2a", "#5a6f8a"),
    syntax: s("9a8a70", "8b4513", "4f7a28", "a0522d", "5a6f8a"),
  },
  // ---- fun ----
  {
    id: "terminal", label: "Terminal", group: "Fun", dark: true,
    tokens: t("#000000", "#050a05", "#33ff66", "#1fae47", "#0f3d1a", "#0a1f0e", "#0f4d1f", "#33ff66", "#000000", "#2a3300", "#ccff33", "#33ff66", "#ff4d4d", "#66ffcc"),
    syntax: s("1f8a3a", "66ff99", "ccff33", "99ffcc", "33ffcc"),
  },
  {
    id: "amber", label: "Amber CRT", group: "Fun", dark: true,
    tokens: t("#0d0800", "#140c00", "#ffb000", "#b57d00", "#3d2a00", "#1f1500", "#4a3300", "#ffb000", "#0d0800", "#3d2a00", "#ffd27a", "#ffcc33", "#ff6a3d", "#ffe08a"),
    syntax: s("8a6000", "ffcc33", "ffe08a", "ff9e00", "ffd27a"),
    diff: { add: "#ffcc33", del: "#ff6a3d" },
  },
  {
    id: "vaporwave", label: "Vaporwave", group: "Fun", dark: true,
    tokens: t("#241734", "#2e1b47", "#ffe6ff", "#c9a8e8", "#4a2f6e", "#3a2458", "#5a2d7a", "#ff71ce", "#241734", "#4a3a10", "#fffb96", "#05ffa1", "#ff6b9d", "#01cdfe"),
    syntax: s("8f74b3", "ff71ce", "fffb96", "05ffa1", "01cdfe"),
  },
  {
    id: "win95", label: "Windows 95", group: "Fun", dark: false,
    tokens: t("#ffffff", "#c0c0c0", "#000000", "#4a4a4a", "#808080", "#d4d0c8", "#000080", "#000080", "#ffffff", "#ffffc0", "#808000", "#008000", "#c00000", "#000080"),
    syntax: s("008000", "0000ff", "800000", "098658", "267f99"),
  },
  {
    id: "gameboy", label: "Game Boy", group: "Fun", dark: false,
    tokens: t("#9bbc0f", "#8bac0f", "#0f380f", "#306230", "#306230", "#8bac0f", "#306230", "#0f380f", "#9bbc0f", "#8bac0f", "#306230", "#0f380f", "#0f380f", "#306230"),
    syntax: s("306230", "0f380f", "306230", "0f380f", "306230"),
    diff: { add: "#306230", del: "#0f380f" },
  },
  {
    id: "matrix", label: "Matrix", group: "Fun", dark: true,
    tokens: t("#000000", "#020b04", "#00ff41", "#008f11", "#003b00", "#001a06", "#003b00", "#00ff41", "#000000", "#002b0a", "#b3ff00", "#00ff41", "#ff3b3b", "#00ffaa"),
    syntax: s("008f11", "00ff41", "b3ff00", "00ffaa", "6dff8a"),
  },
  {
    id: "blueprint", label: "Blueprint", group: "Fun", dark: true,
    tokens: t("#0d3b66", "#0b3358", "#e8f1ff", "#9fbbe0", "#2e5f8f", "#14487a", "#1f5f99", "#ffffff", "#0d3b66", "#3b4a1a", "#ffd166", "#9fffcb", "#ff8fa3", "#a0d8ff"),
    syntax: s("8fb0d9", "ffffff", "ffd166", "9fffcb", "a0d8ff"),
  },
  // ---- seasonal & cultural ----
  {
    id: "diwali", label: "Diwali", group: "Seasonal & cultural", dark: true,
    tokens: t("#1a1033", "#22163f", "#fff3d6", "#c9b38a", "#3d2c66", "#2c1f52", "#4a2f7a", "#ffa41b", "#1a1033", "#4a3300", "#ffd700", "#7bd88f", "#ff6b6b", "#ffb86b"),
    syntax: s("9a88c0", "ffa41b", "ffd700", "ff7aa2", "7bd8ff"),
  },
  {
    id: "lunar", label: "Lunar New Year", group: "Seasonal & cultural", dark: true,
    tokens: t("#2a0606", "#3a0a0a", "#fff1d6", "#d9a99a", "#5c1616", "#4a1010", "#6b1a1a", "#f5c518", "#2a0606", "#5c4300", "#f5c518", "#7bd88f", "#ff8a8a", "#ffcf6b"),
    syntax: s("b07d70", "f5c518", "ffd98a", "ff9e6b", "ffcf6b"),
  },
  {
    id: "christmas", label: "Christmas", group: "Seasonal & cultural", dark: true,
    tokens: t("#0f2a1d", "#14382a", "#f4f8f4", "#a9c2b2", "#22513b", "#1b4532", "#2a6146", "#d4202c", "#ffffff", "#4a3a10", "#f2c14e", "#6fdc8c", "#ff6b6b", "#9ad0ff"),
    syntax: s("7fa08c", "ff6b6b", "f2c14e", "9ad0ff", "6fdc8c"),
  },
  {
    id: "halloween", label: "Halloween", group: "Seasonal & cultural", dark: true,
    tokens: t("#1a0f1f", "#24152b", "#f5e6ff", "#b39cc2", "#3d2647", "#2e1c36", "#4a2a5c", "#ff7518", "#1a0f1f", "#4a2a00", "#ffb347", "#9ae66e", "#ff5c5c", "#b98cff"),
    syntax: s("8a6f99", "ff7518", "ffb347", "9ae66e", "b98cff"),
  },
  {
    id: "sakura", label: "Sakura", group: "Seasonal & cultural", dark: false,
    tokens: t("#fff7f9", "#fde8ee", "#3a2a30", "#8a6f78", "#f3c9d6", "#fadbe4", "#f9cbd9", "#e75480", "#ffffff", "#ffe8b3", "#b06b00", "#3d8b5a", "#c2185b", "#6a5acd"),
    syntax: s("b09aa2", "e75480", "3d8b5a", "c2185b", "6a5acd"),
  },
  {
    id: "italia", label: "Italia", group: "Seasonal & cultural", dark: false,
    tokens: t("#ffffff", "#f5f7f5", "#1f2a24", "#66706a", "#dfe4e0", "#ecf0ed", "#d4ecdf", "#009246", "#ffffff", "#fff4cc", "#a36a00", "#009246", "#ce2b37", "#1f5fa8"),
    syntax: s("8a948e", "009246", "ce2b37", "a36a00", "1f5fa8"),
  },
];

const VARS: [keyof Tokens, string][] = [
  ["bg", "--bg"], ["bgSide", "--bg-side"], ["fg", "--fg"], ["muted", "--muted"], ["border", "--border"],
  ["hover", "--hover"], ["selected", "--selected"], ["accent", "--accent"], ["accentFg", "--accent-fg"],
  ["banner", "--banner"], ["mod", "--mod"], ["add", "--add"], ["del", "--del"], ["ren", "--ren"],
];

/** Sets (or, with null, removes) the extra theme's tokens on the page root. */
export function applyTokens(root: HTMLElement, theme: ExtraTheme | null) {
  for (const [key, name] of VARS) {
    if (theme) root.style.setProperty(name, theme.tokens[key]);
    else root.style.removeProperty(name);
  }
  if (theme) root.style.setProperty("color-scheme", theme.dark ? "dark" : "light");
  else root.style.removeProperty("color-scheme");
}

/** The Monaco theme data for an extra theme. */
export function editorThemeData(theme: ExtraTheme) {
  const k = theme.tokens;
  const diff = theme.diff ?? { add: k.add, del: k.del };
  return {
    base: (theme.dark ? "vs-dark" : "vs") as "vs" | "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: theme.syntax.comment, fontStyle: "italic" },
      { token: "keyword", foreground: theme.syntax.keyword },
      { token: "string", foreground: theme.syntax.string },
      { token: "number", foreground: theme.syntax.number },
      { token: "type", foreground: theme.syntax.type },
    ],
    colors: {
      "editor.background": k.bg,
      "editorGutter.background": k.bg,
      "editor.foreground": k.fg,
      "editorLineNumber.foreground": k.muted,
      "editorLineNumber.activeForeground": k.accent,
      "editorCursor.foreground": k.accent,
      "editor.lineHighlightBackground": k.hover,
      "editor.selectionBackground": `${k.selected}cc`,
      "diffEditor.insertedTextBackground": `${diff.add}38`,
      "diffEditor.removedTextBackground": `${diff.del}38`,
      "diffEditor.insertedLineBackground": `${diff.add}18`,
      "diffEditor.removedLineBackground": `${diff.del}18`,
    },
  };
}

// ---- Auto: a seasonal theme on its dates, else null (follow the system) ----

/** Lunar New Year's day, by year (the date moves with the moon). */
const LUNAR_NEW_YEAR: Record<number, [number, number]> = {
  2026: [2, 17], 2027: [2, 6], 2028: [1, 26], 2029: [2, 13], 2030: [2, 3],
  2031: [1, 23], 2032: [2, 11], 2033: [1, 31], 2034: [2, 19], 2035: [2, 8],
};
/** Diwali (Lakshmi Puja), by year. */
const DIWALI: Record<number, [number, number]> = {
  2026: [11, 8], 2027: [10, 29], 2028: [10, 17], 2029: [11, 5], 2030: [10, 26],
};

const DAY = 24 * 60 * 60 * 1000;
const dayNumber = (d: Date) => Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY);
const near = (date: Date, table: Record<number, [number, number]>, before: number, after: number) => {
  const md = table[date.getFullYear()];
  if (!md) return false;
  const diff = dayNumber(date) - dayNumber(new Date(date.getFullYear(), md[0] - 1, md[1]));
  return diff >= -before && diff <= after;
};

/** The seasonal theme for `date` (local time), or null for none. */
export function seasonalTheme(date: Date): string | null {
  const m = date.getMonth() + 1;
  const d = date.getDate();
  if (near(date, DIWALI, 2, 3)) return "diwali";
  if (near(date, LUNAR_NEW_YEAR, 3, 14)) return "lunar";
  if (m === 12 && d <= 26) return "christmas";
  if (m === 10 && d >= 15) return "halloween";
  if (m === 6 && d === 2) return "italia"; // Festa della Repubblica
  if (m === 6) return "pride"; // Pride Month
  if ((m === 3 && d >= 20) || (m === 4 && d <= 15)) return "sakura";
  return null;
}
