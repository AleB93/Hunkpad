import { describe, expect, it } from "vitest";
import { inWorktree, isInside, parseCopyList, validCopyPath, worktreeEnv } from "../src/worktrees";

describe("inWorktree", () => {
  const roots = ["/r/app", "/r/app-feature", "/r/app/.claude/worktrees/x"];

  it("moves a script saved in one work tree to the same place in another", () => {
    expect(inWorktree("/r/app/package.json", roots, "/r/app-feature")).toBe("/r/app-feature/package.json");
    expect(inWorktree("/r/app-feature/scripts/dev.sh", roots, "/r/app")).toBe("/r/app/scripts/dev.sh");
  });

  it("picks the innermost work tree and leaves outside paths alone", () => {
    expect(inWorktree("/r/app/.claude/worktrees/x/package.json", roots, "/r/app")).toBe("/r/app/package.json");
    expect(inWorktree("/home/me/bin/tool.sh", roots, "/r/app-feature")).toBe("/home/me/bin/tool.sh");
  });

  it("does not take a sibling with a longer name for a parent", () => {
    expect(isInside("/r/app-feature/a", "/r/app")).toBe(false);
  });
});

describe("worktreeEnv", () => {
  it("numbers the worktree and sets PORT only with a base port", () => {
    expect(worktreeEnv(2, "/r/b", 3000)).toEqual([["HUNKPAD_WORKTREE", "2"], ["HUNKPAD_WORKTREE_PATH", "/r/b"], ["PORT", "3002"]]);
    expect(worktreeEnv(0, "/r/a", null).map(([k]) => k)).toEqual(["HUNKPAD_WORKTREE", "HUNKPAD_WORKTREE_PATH"]);
  });
});

describe("copy list", () => {
  it("reads one path per line and rejects paths outside the repository", () => {
    expect(parseCopyList(" .env\n\n./config/dev.json\r\nconfig\\local/\n.env")).toEqual([".env", "config/dev.json", "config/local"]);
    expect([".env", "config/dev.json", "../x", "/etc/passwd", ".git/config", "C:/x"].map(validCopyPath)).toEqual([
      true, true, false, false, false, false,
    ]);
  });
});
