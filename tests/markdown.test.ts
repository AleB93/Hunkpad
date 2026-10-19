import { describe, expect, it } from "vitest";
import { isMarkdown, isWebLink, resolveRepoPath, slug } from "../src/markdown";

describe("markdown preview helpers", () => {
  it("recognises Markdown files", () => {
    expect(isMarkdown("docs/README.md")).toBe(true);
    expect(isMarkdown("notes.MARKDOWN")).toBe(true);
    expect(isMarkdown("src/main.ts")).toBe(false);
  });

  it("makes GitHub-style heading anchors", () => {
    expect(slug("Keyboard shortcuts")).toBe("keyboard-shortcuts");
    expect(slug("What's new? (2026)")).toBe("whats-new-2026");
    expect(slug("Città è bella")).toBe("città-è-bella");
  });

  it("resolves links relative to the file, or to the root with a leading /", () => {
    expect(resolveRepoPath("docs/how-to/a.md", "b.md")).toBe("docs/how-to/b.md");
    expect(resolveRepoPath("docs/how-to/a.md", "../img/x.png")).toBe("docs/img/x.png");
    expect(resolveRepoPath("docs/a.md", "./sub%20dir/c.md")).toBe("docs/sub dir/c.md");
    expect(resolveRepoPath("docs/a.md", "/README.md")).toBe("README.md");
    expect(resolveRepoPath("README.md", "../outside.md")).toBeNull();
  });

  it("only web and mail links go to the browser", () => {
    expect(isWebLink("https://example.com")).toBe(true);
    expect(isWebLink("mailto:a@b.c")).toBe(true);
    expect(isWebLink("javascript:alert(1)")).toBe(false);
    expect(isWebLink("docs/a.md")).toBe(false);
  });
});
