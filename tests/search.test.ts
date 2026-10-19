// File-name ranking, and `git grep` output parsed as the app parses it: each
// text test builds a small repository in the temp folder and runs the same
// arguments the app runs.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TextSearchOptions, fuzzyMatch, grepArgs, matchRange, parseGrep, rankFiles } from "../src/search";

describe("file names", () => {
  const paths = [
    "src/main.ts",
    "src/git.ts",
    "src/search.ts",
    "src-tauri/src/lib.rs",
    "tests/search.test.ts",
    "docs/some/deep/folder/maintenance.md",
  ];

  it("needs every character, in order", () => {
    expect(fuzzyMatch("mts", "src/main.ts")).not.toBeNull();
    expect(fuzzyMatch("stm", "src/main.ts")).toBeNull();
  });

  it("ranks a file-name prefix first", () => {
    expect(rankFiles("search", paths).map((m) => m.path)[0]).toBe("src/search.ts");
    expect(rankFiles("main", paths).map((m) => m.path)[0]).toBe("src/main.ts");
  });

  it("matches across folders and returns the hit positions", () => {
    const m = fuzzyMatch("taurilib", "src-tauri/src/lib.rs")!;
    expect(m.hits.map((i) => "src-tauri/src/lib.rs"[i]).join("")).toBe("taurilib");
  });

  it("an empty query lists everything", () => {
    expect(rankFiles("", paths)).toHaveLength(paths.length);
  });
});

describe("text", () => {
  let dir = "";
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
  /** As the app runs it: exit code 1 (no match) gives empty output. */
  const grep = (query: string, o: Partial<TextSearchOptions> = {}) => {
    const r = spawnSync("git", ["-c", "core.quotepath=false", ...grepArgs(query, { matchCase: false, wholeWord: false, regex: false, ...o })], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBeLessThan(2);
    return parseGrep(r.stdout);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hunkpad-search-"));
    git("init", "-q", "-b", "main");
    mkdirSync(join(dir, "sub dir"));
    writeFileSync(join(dir, "a.ts"), "const userId = 1;\nfunction getUser(userId) {}\n");
    writeFileSync(join(dir, "sub dir/b.ts"), "// città è userId\nUSERID\n");
    writeFileSync(join(dir, "bin.dat"), "userId\0binary");
    writeFileSync(join(dir, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(dir, "ignored.txt"), "userId\n");
    git("add", "a.ts", ".gitignore"); // sub dir/b.ts stays untracked
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it("finds tracked and untracked files, skips binary and ignored ones", () => {
    const { matches } = grep("userId");
    expect(new Set(matches.map((m) => m.path))).toEqual(new Set(["a.ts", "sub dir/b.ts"]));
  });

  it("reports line and character column (also after non-ASCII text)", () => {
    const { matches } = grep("userId", { matchCase: true });
    const b = matches.find((m) => m.path === "sub dir/b.ts")!;
    expect(b.line).toBe(1);
    expect(b.text.slice(b.column - 1, b.column - 1 + 6)).toBe("userId");
    const a = matches.filter((m) => m.path === "a.ts").map((m) => m.line);
    expect(a).toEqual([1, 2]);
  });

  it("match case and whole word", () => {
    expect(grep("userid").matches.length).toBe(4);
    expect(grep("userid", { matchCase: true }).matches.length).toBe(0);
    expect(grep("User", { matchCase: true }).matches.length).toBe(1); // getUser
    expect(grep("User", { matchCase: true, wholeWord: true }).matches.length).toBe(0);
  });

  it("regex, and no match is not an error", () => {
    expect(grep("get[A-Z]\\w+", { regex: true, matchCase: true }).matches.map((m) => m.line)).toEqual([2]);
    expect(grep("nothing-like-this").matches).toEqual([]);
  });

  it("caps the results", () => {
    writeFileSync(join(dir, "many.txt"), "hit\n".repeat(50));
    const r = spawnSync("git", grepArgs("hit", { matchCase: true, wholeWord: true, regex: false }), { cwd: dir, encoding: "utf8" });
    const { matches, truncated } = parseGrep(r.stdout, 10);
    expect(matches).toHaveLength(10);
    expect(truncated).toBe(true);
  });

  it("finds the match again in the line, for highlighting", () => {
    const o = { matchCase: false, wholeWord: true, regex: false };
    expect(matchRange("getUser(userId) userId", "userid", o, 8)).toEqual([8, 14]);
    expect(matchRange("a.b", ".", { ...o, wholeWord: false })).toEqual([1, 2]);
  });
});
