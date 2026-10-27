// `stash -u` under GIT_LITERAL_PATHSPECS=1, as the app runs Git: the untracked
// files must be saved in the stash AND removed from the working tree.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STASH_PUSH } from "../src/git";

let dir = "";
const git = (...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GIT_LITERAL_PATHSPECS: "1", GIT_CONFIG_NOSYSTEM: "1" },
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hunkpad-stash-"));
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "tracked.txt"), "a\n");
  git("add", "tracked.txt");
  git("commit", "-q", "-m", "init");
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

describe("stash including untracked files", () => {
  it("removes the untracked files it saved", () => {
    writeFileSync(join(dir, "tracked.txt"), "a\nb\n");
    writeFileSync(join(dir, "new.txt"), "n\n");
    git(...STASH_PUSH, "-u", "-m", "with untracked");

    expect(git("status", "--porcelain")).toBe("");
    expect(existsSync(join(dir, "new.txt"))).toBe(false);
    expect(git("ls-tree", "-r", "--name-only", "stash@{0}^3").trim()).toBe("new.txt");
    // Three parents: HEAD, the index, the untracked files.
    expect(git("log", "-1", "--format=%P", "stash@{0}").trim().split(" ")).toHaveLength(3);
  });

  it("without the option, git leaves them behind (why STASH_PUSH has it)", () => {
    writeFileSync(join(dir, "new.txt"), "n\n");
    git("stash", "push", "-u", "-m", "plain");
    expect(existsSync(join(dir, "new.txt"))).toBe(true);
  });
});
