// The Claude features' plain logic: reading the CLI's JSON, what may be sent,
// and checking each answer before Hunkpad acts on it.

import { describe, expect, it } from "vitest";
import {
  ClaudeError,
  ClaudeSignInError,
  cliArgs,
  conflictPrompt,
  findSecrets,
  hasConflictMarkers,
  isSecretPath,
  parseCliOutput,
  parseCommitMessage,
  parseFindings,
  parseGroupPlan,
  parseResolution,
  parseSetupSuggestion,
  parseText,
  setupPrompt,
} from "../src/claude";

describe("CLI output", () => {
  it("prefers the structured output", () => {
    const out = JSON.stringify({ type: "result", is_error: false, result: "ignored", structured_output: { message: "Fix typo" } });
    expect(parseCliOutput(out)).toEqual({ message: "Fix typo" });
  });

  it("falls back to JSON in the result text, fenced or with words around it", () => {
    expect(parseCliOutput(JSON.stringify({ is_error: false, result: '```json\n{"a":1}\n```' }))).toEqual({ a: 1 });
    expect(parseCliOutput(JSON.stringify({ is_error: false, result: 'Here: {"a":2} done' }))).toEqual({ a: 2 });
  });

  it("reports the CLI's error, with a sign-in hint for login problems", () => {
    const out = JSON.stringify({ is_error: true, result: "Failed to authenticate: OAuth session expired" });
    expect(() => parseCliOutput(out)).toThrow(/OAuth session expired.*sign in/);
    expect(() => parseCliOutput(out)).toThrow(ClaudeSignInError);
    expect(() => parseCliOutput(JSON.stringify({ is_error: true, result: "Overloaded" }))).not.toThrow(ClaudeSignInError);
  });

  it("reports non-JSON output with stderr", () => {
    expect(() => parseCliOutput("", "error: unknown option", 1)).toThrow(/unknown option/);
  });

  it("runs without tools, with the schema and an optional model", () => {
    const args = cliArgs({ system: "S", schema: { type: "object" }, model: " sonnet " });
    expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual(["--tools", ""]);
    expect(args).toContain('{"type":"object"}');
    expect(args.slice(-2)).toEqual(["--model", "sonnet"]);
    expect(cliArgs({ system: "S", schema: {} })).not.toContain("--model");
  });
});

describe("what may be sent", () => {
  it("never sends env, key and credential files", () => {
    for (const p of [".env", "app/.env.local", "certs/server.pem", "id_rsa", "config/credentials.json", ".npmrc", "secrets.yaml"])
      expect(isSecretPath(p), p).toBe(true);
    for (const p of [".env.example", "src/env.ts", "README.md", "keys.ts", "docs/secrets-handling.md"]) expect(isSecretPath(p), p).toBe(false);
  });

  it("finds keys in added lines only", () => {
    const key = `ghp_${"a".repeat(36)}`;
    expect(findSecrets(`+const token = "${key}";`)).toEqual(["GitHub token"]);
    expect(findSecrets(`-const token = "${key}";`)).toEqual([]);
    expect(findSecrets("+-----BEGIN OPENSSH PRIVATE KEY-----")).toEqual(["private key"]);
    expect(findSecrets("+const aws = 'AKIAABCDEFGHIJKLMNOP'")).toEqual(["AWS access key"]);
    expect(findSecrets("+just some code")).toEqual([]);
  });
});

describe("answers", () => {
  it("commit message: trimmed, LF line endings", () => {
    expect(parseCommitMessage({ message: "  Fix it\r\n\r\nBody\r\n" })).toBe("Fix it\n\nBody");
    expect(() => parseCommitMessage({ message: " " })).toThrow(ClaudeError);
  });

  it("group plan: unknown ids dropped, each block used once, the rest unplaced", () => {
    const plan = parseGroupPlan(
      {
        groups: [
          { name: " Docs ", message: "Update docs", blocks: ["b1", "b9", "b2"] },
          { name: "", message: "Dup", blocks: ["b2", "b3"] },
          { name: "Empty", message: "", blocks: ["nope"] },
        ],
      },
      ["b1", "b2", "b3", "b4"],
    );
    expect(plan.groups).toEqual([
      { name: "Docs", message: "Update docs", blocks: ["b1", "b2"] },
      { name: "Group 2", message: "Dup", blocks: ["b3"] },
    ]);
    expect(plan.unplaced).toEqual(["b4"]);
  });

  it("group plan: refuses an answer that places nothing", () => {
    expect(() => parseGroupPlan({ groups: [{ name: "x", message: "", blocks: ["zz"] }] }, ["b1"])).toThrow(ClaudeError);
    expect(() => parseGroupPlan({}, ["b1"])).toThrow(ClaudeError);
  });

  it("review: only sent files, lines clamped to the file", () => {
    const counts = new Map([["src/a.ts", 10]]);
    const out = parseFindings(
      {
        findings: [
          { path: "b/src/a.ts", line: 40, comment: " Off by one " },
          { path: "src/other.ts", line: 1, comment: "not sent" },
          { path: "src/a.ts", line: 0, comment: "" },
        ],
      },
      counts,
    );
    expect(out).toEqual([{ path: "src/a.ts", line: 10, comment: "Off by one" }]);
  });

  it("text: title and body", () => {
    expect(parseText({ title: " T ", body: "a\r\nb" })).toEqual({ title: "T", body: "a\nb" });
    expect(() => parseText({ title: "T" })).toThrow(ClaudeError);
  });
});

describe("conflicts", () => {
  const conflicted = "a\r\n<<<<<<< HEAD\r\nours\r\n=======\r\ntheirs\r\n>>>>>>> topic\r\nz\r\n";

  it("detects markers only at line starts", () => {
    expect(hasConflictMarkers(conflicted)).toBe(true);
    expect(hasConflictMarkers("a = '<<<<<<< not a marker'\n")).toBe(false);
  });

  it("keeps the original's line endings and final newline", () => {
    const r = parseResolution({ content: "a\nours and theirs\nz", explanation: " merged " }, conflicted);
    expect(r).toEqual({ content: "a\r\nours and theirs\r\nz\r\n", explanation: "merged" });
  });

  it("refuses a resolution that still has markers", () => {
    expect(() => parseResolution({ content: "<<<<<<< HEAD\nx\n", explanation: "" }, conflicted)).toThrow(/conflict markers/);
  });

  it("fences the file so backticks inside cannot end it", () => {
    const prompt = conflictPrompt("x.md", "merge", "````\ncode\n````");
    expect(prompt).toContain("\n`````\n````\ncode\n````\n`````");
  });
});

describe("worktree setup", () => {
  const untracked = [".env.local", "node_modules/", "web/.env", "dist/"];

  it("keeps only untracked paths, one command line and a port in range", () => {
    const s = parseSetupSuggestion(
      { copy: ["./.env.local", "web/.env", "src/index.ts", "../secret", "node_modules/react"], command: "pnpm install &&\n pnpm --dir web install", basePort: 99999, explanation: " ok " },
      untracked,
    );
    expect(s).toEqual({ copy: [".env.local", "web/.env", "node_modules/react"], command: "pnpm install && pnpm --dir web install", basePort: null, explanation: "ok" });
    expect(() => parseSetupSuggestion({ copy: "x" }, untracked)).toThrow(ClaudeError);
  });

  it("sends names, the current setup and manifests, not untracked contents", () => {
    const prompt = setupPrompt({
      tracked: ["package.json"],
      untracked,
      manifests: [{ path: "package.json", text: '{"name":"a"}' }],
      current: { copy: [], command: "pnpm install", basePort: null },
    });
    expect(prompt).toContain(".env.local");
    expect(prompt).toContain('{"name":"a"}');
    expect(prompt).toContain('"command": "pnpm install"');
  });
});
