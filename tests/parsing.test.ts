// The parsers read real Git output: each test builds a small repository in the
// temp folder, runs the same git command the app runs, and parses the result.
// This catches differences between Git versions and platforms.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseNameStatus, parseStatus } from "../src/git";
import { parseDiffU0 } from "../src/hunks";
import { parsePatch } from "../src/overview";
import { splitPatch, toMarkdown } from "../src/export";

let dir = "";

/** git with the same options as the app (lib.rs), isolated from the user's config. */
function git(...args: string[]): string {
  return execFileSync("git", ["-c", "core.quotepath=false", "-c", "color.ui=false", ...args], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: join(dir, ".no-global-config"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

const write = (path: string, content: string) => writeFileSync(join(dir, path), content);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hunkpad-test-"));
  git("init", "-q", "-b", "main");
  write("a.txt", "one\ntwo\nthree\n");
  write("b.txt", "keep\n");
  git("add", ".");
  git("commit", "-q", "-m", "first");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("parseStatus", () => {
  it("reads branch, staged, unstaged, untracked and renamed files", () => {
    write("a.txt", "one\nTWO\nthree\n");
    write("new file ü.txt", "hello\n");
    git("mv", "b.txt", "c.txt");
    const status = parseStatus(git("status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"));

    expect(status.branch).toBe("main");
    expect(status.oid).toMatch(/^[0-9a-f]{40}$/);
    const byPath = new Map(status.files.map((f) => [f.path, f]));
    expect(byPath.get("a.txt")).toMatchObject({ staged: null, unstaged: "M" });
    expect(byPath.get("c.txt")).toMatchObject({ staged: "R", origPath: "b.txt" });
    expect(byPath.get("new file ü.txt")).toMatchObject({ unstaged: "U" });
  });

  it("handles an unborn branch", () => {
    rmSync(join(dir, ".git"), { recursive: true, force: true });
    git("init", "-q", "-b", "start");
    const status = parseStatus(git("status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"));
    expect(status.branch).toBe("start");
    expect(status.oid).toBeNull();
  });
});

describe("parseNameStatus", () => {
  it("reads changes and renames between two commits", () => {
    git("mv", "b.txt", "renamed.txt");
    write("a.txt", "changed\n");
    git("commit", "-q", "-am", "second");
    const files = parseNameStatus(git("diff", "--name-status", "-z", "-M", "HEAD~1", "HEAD"));
    expect(files).toEqual(
      expect.arrayContaining([
        { status: "M", origPath: null, path: "a.txt" },
        { status: "R", origPath: "b.txt", path: "renamed.txt" },
      ]),
    );
  });
});

describe("parseDiffU0", () => {
  it("splits a file into one hunk per changed block", () => {
    write("a.txt", "ONE\ntwo\nthree\nfour\n");
    const hunks = parseDiffU0(git("diff", "-U0", "--no-color", "--no-ext-diff", "--no-renames"));
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ path: "a.txt", oldStart: 1, oldCount: 1, removed: ["one"], added: ["ONE"] });
    expect(hunks[1]).toMatchObject({ path: "a.txt", oldStart: 3, oldCount: 0, newStart: 4, added: ["four"] });
  });

  it("keeps paths with spaces and non-ASCII characters", () => {
    write("dir é.txt", "x\n");
    git("add", ".");
    git("commit", "-q", "-m", "add");
    write("dir é.txt", "y\n");
    const hunks = parseDiffU0(git("diff", "-U0", "--no-color", "--no-ext-diff", "--no-renames"));
    expect(hunks.map((h) => h.path)).toEqual(["dir é.txt"]);
  });

  it("reads CRLF output as if it were LF", () => {
    write("a.txt", "one\nTWO\nthree\n");
    const lf = git("diff", "-U0", "--no-color", "--no-ext-diff", "--no-renames");
    const strip = (hs: ReturnType<typeof parseDiffU0>) => hs.map(({ path, removed, added }) => ({ path, removed, added }));
    expect(strip(parseDiffU0(lf.replace(/\n/g, "\r\n")))).toEqual(strip(parseDiffU0(lf)));
  });
});

describe("parsePatch", () => {
  it("numbers lines and counts additions and removals", () => {
    write("a.txt", "one\nTWO\nthree\nfour\n");
    const [file] = parsePatch(git("diff", "-U3", "--no-color", "--no-ext-diff"));
    expect(file).toMatchObject({ path: "a.txt", added: 2, removed: 1, binary: false });
    const added = file.hunks.flatMap((h) => h.lines).filter((l) => l.kind === "+");
    expect(added.map((l) => [l.text, l.newNo])).toEqual([
      ["TWO", 2],
      ["four", 4],
    ]);
  });

  it("marks binary files", () => {
    writeFileSync(join(dir, "img.bin"), Buffer.from([0, 1, 2, 0, 255]));
    git("add", ".");
    const files = parsePatch(git("diff", "-U3", "--no-color", "--no-ext-diff", "--cached"));
    expect(files.find((f) => f.path === "img.bin")?.binary).toBe(true);
  });
});

describe("Copy for LLM export", () => {
  it("splits a patch per file and renders Markdown", () => {
    write("a.txt", "one\nTWO\nthree\n");
    write("b.txt", "changed\n");
    const parts = splitPatch(git("diff", "-U3", "--no-color", "--no-ext-diff"));
    expect(parts.map((p) => p.path)).toEqual(["a.txt", "b.txt"]);

    const md = toMarkdown({
      title: "Changes",
      meta: ["Repository: test"],
      files: parts.map((p) => ({ path: p.path, status: "modified", patch: p.text, comments: [] })),
    });
    expect(md).toContain("## a.txt");
    expect(md).toContain("+TWO");
    expect(md).toContain("- Files: 2");
  });
});
