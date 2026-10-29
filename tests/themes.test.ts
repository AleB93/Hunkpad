import { describe, expect, it } from "vitest";
import { EXTRA_THEMES, editorThemeData, seasonalTheme } from "../src/themes";

/** WCAG relative luminance and contrast ratio of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(bl);
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

describe("extra themes", () => {
  it("have unique ids and complete, valid colours", () => {
    const ids = EXTRA_THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of EXTRA_THEMES) {
      for (const v of Object.values(t.tokens)) expect(v, `${t.id}: ${v}`).toMatch(/^#[0-9a-f]{6}$/i);
      for (const v of Object.values(t.syntax)) expect(v, `${t.id}: ${v}`).toMatch(/^[0-9a-f]{6}$/i);
    }
  });

  it("keep body text readable (WCAG AA, 4.5:1) on the main and side backgrounds", () => {
    for (const t of EXTRA_THEMES) {
      expect(contrast(t.tokens.fg, t.tokens.bg), `${t.id} fg/bg`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.tokens.fg, t.tokens.bgSide), `${t.id} fg/side`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("high contrast meets AAA (7:1)", () => {
    const hc = EXTRA_THEMES.find((t) => t.id === "contrast")!;
    expect(contrast(hc.tokens.fg, hc.tokens.bg)).toBeGreaterThanOrEqual(7);
  });

  it("colour-blind safe uses blue and orange, not green and red, for diffs", () => {
    const cb = EXTRA_THEMES.find((t) => t.id === "colorblind")!;
    expect(cb.tokens.add.toLowerCase()).toBe("#4da3ff");
    expect(cb.tokens.del.toLowerCase()).toBe("#ff9f1c");
  });

  it("build a Monaco theme on the matching base", () => {
    for (const t of EXTRA_THEMES) {
      const m = editorThemeData(t);
      expect(m.base).toBe(t.dark ? "vs-dark" : "vs");
      expect(m.colors["editor.background"]).toBe(t.tokens.bg);
    }
  });
});

describe("Auto (seasonal)", () => {
  const on = (y: number, m: number, d: number) => seasonalTheme(new Date(y, m - 1, d));

  it("picks the season by date", () => {
    expect(on(2026, 12, 20)).toBe("christmas");
    expect(on(2026, 12, 27)).toBeNull();
    expect(on(2026, 10, 31)).toBe("halloween");
    expect(on(2026, 10, 14)).toBeNull();
    expect(on(2027, 6, 2)).toBe("italia");
    expect(on(2027, 6, 15)).toBe("pride");
    expect(on(2027, 4, 1)).toBe("sakura");
    expect(on(2027, 8, 10)).toBeNull();
  });

  it("follows the moving holidays, and Diwali wins over Halloween", () => {
    expect(on(2027, 2, 6)).toBe("lunar"); // Lunar New Year's day
    expect(on(2027, 2, 3)).toBe("lunar"); // 3 days before
    expect(on(2027, 2, 21)).toBeNull(); // 15 days after
    expect(on(2027, 10, 29)).toBe("diwali"); // also in the Halloween window
    expect(on(2026, 11, 8)).toBe("diwali");
    expect(on(2026, 11, 20)).toBeNull();
  });
});
