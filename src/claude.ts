// Optional Claude features, run through the user's own Claude Code CLI
// (`claude -p`, src-tauri/src/claude.rs). Hunkpad stores no key and has no
// account: the CLI uses its own login.
//
// Claude is given no tools. It reads only what Hunkpad sends (shown to the
// user first) and answers in JSON checked against a schema. It never runs Git:
// whatever it proposes, Hunkpad applies itself, through the usual flow where
// each Git command can be reviewed before it runs.
//
// This file is the plain logic (requests, parsing, validation, secret checks),
// kept free of the UI so it can be tested.

import { invoke } from "@tauri-apps/api/core";

export class ClaudeNotFoundError extends Error {
  constructor() {
    super("The claude command line was not found. Install Claude Code (claude.com/claude-code) and sign in with `claude` once.");
  }
}

export class ClaudeCancelledError extends Error {
  constructor() {
    super("Cancelled");
  }
}

export class ClaudeError extends Error {}

/** The CLI is installed but not signed in (or its login expired). */
export class ClaudeSignInError extends ClaudeError {}

export interface ClaudeRequest {
  cwd: string;
  /** What Claude is for in this request (its system prompt). */
  system: string;
  /** The whole user message: instructions and data. Sent on stdin. */
  prompt: string;
  /** JSON Schema the answer must match. */
  schema: object;
  /** Model alias or name; empty = the CLI's default. */
  model?: string;
}

let nextId = 1;

/** A running request: its answer, and a way to stop it. */
export interface ClaudeRun<T> {
  result: Promise<T>;
  cancel: () => void;
}

export function cliArgs(req: Pick<ClaudeRequest, "system" | "schema" | "model">): string[] {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--no-session-persistence",
    // No tools at all: Claude cannot read files, run commands or browse.
    "--tools",
    "",
    "--system-prompt",
    req.system,
    "--json-schema",
    JSON.stringify(req.schema),
  ];
  if (req.model?.trim()) args.push("--model", req.model.trim());
  return args;
}

export function runClaude<T = unknown>(req: ClaudeRequest): ClaudeRun<T> {
  const id = nextId++;
  const result = invoke<{ code: number; stdout: string; stderr: string }>("run_claude", {
    cwd: req.cwd,
    args: cliArgs(req),
    stdin: req.prompt,
    id,
  }).then(
    (out) => parseCliOutput(out.stdout, out.stderr, out.code) as T,
    (e) => {
      const text = String(e);
      if (text === "CLAUDE_NOT_FOUND") throw new ClaudeNotFoundError();
      if (text === "CLAUDE_CANCELLED") throw new ClaudeCancelledError();
      throw new ClaudeError(text);
    },
  );
  return { result, cancel: () => void invoke("cancel_claude", { id }).catch(() => {}) };
}

/** Installed CLI version, or null. */
export const claudeVersion = () => invoke<string | null>("claude_version");

/** Opens a terminal window running `claude auth login`. */
export const claudeSignIn = (cwd: string) => invoke<void>("claude_sign_in", { cwd });

/** A JSON value written as text, maybe inside a ```json fence. */
function parseJsonText(text: string): unknown {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n\s*```/.exec(text);
  const body = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(body);
  } catch {
    // Some text around the object: take the outermost braces.
    const from = body.indexOf("{");
    const to = body.lastIndexOf("}");
    if (from >= 0 && to > from) return JSON.parse(body.slice(from, to + 1));
    throw new ClaudeError("Claude's answer was not valid JSON");
  }
}

/** The answer from `claude -p --output-format json` (structured output when present). */
export function parseCliOutput(stdout: string, stderr = "", code = 0): unknown {
  let env: Record<string, unknown>;
  try {
    env = JSON.parse(stdout.trim()) as Record<string, unknown>;
  } catch {
    const detail = (stderr.trim() || stdout.trim()).split("\n").slice(-5).join("\n");
    throw new ClaudeError(detail ? `claude failed: ${detail}` : `claude exited with code ${code}`);
  }
  if (env.is_error) {
    const why = typeof env.result === "string" && env.result ? env.result : String(env.subtype ?? "unknown error");
    const text = `Claude: ${why}.`.replace(/\.\.$/, ".");
    if (/auth|log ?in|oauth|credential|api key/i.test(why)) throw new ClaudeSignInError(`${text} The claude command line needs you to sign in.`);
    throw new ClaudeError(text);
  }
  if (env.structured_output !== undefined && env.structured_output !== null) return env.structured_output;
  if (typeof env.result === "string") return parseJsonText(env.result);
  throw new ClaudeError("Claude returned no answer");
}

// ---- what may be sent -------------------------------------------------------

/** Files never sent: environment files, keys, credentials. */
export function isSecretPath(path: string): boolean {
  const name = path.split("/").pop()!.toLowerCase();
  return (
    (/^\.env(\..*)?$/.test(name) && !/\.(example|sample|template|dist)$/.test(name)) ||
    /\.(pem|key|p12|pfx|jks|keystore|kdbx)$/.test(name) ||
    /^id_(rsa|dsa|ecdsa|ed25519)$/.test(name) ||
    /^(credentials|secrets?)(\.(json|ya?ml|toml|ini))?$/.test(name) ||
    name === ".npmrc" ||
    name === ".netrc" ||
    name === ".pgpass"
  );
}

const SECRET_PATTERNS: [string, RegExp][] = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitHub token", /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ["Anthropic API key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["OpenAI API key", /\bsk-(proj-)?[A-Za-z0-9]{32,}/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Stripe secret key", /\b[rs]k_live_[0-9a-zA-Z]{20,}/],
];

/** Kinds of secrets found in added lines of a patch (or in plain text). */
export function findSecrets(text: string): string[] {
  const added = text
    .split("\n")
    .filter((l) => !l.startsWith("-") && !l.startsWith("@@") && !l.startsWith("diff "))
    .join("\n");
  return SECRET_PATTERNS.filter(([, re]) => re.test(added)).map(([name]) => name);
}

/** Requests larger than this are refused: pick a group or fewer files. */
export const MAX_PROMPT_BYTES = 600_000;

// ---- 1. commit message ------------------------------------------------------

export const COMMIT_SYSTEM =
  "You write Git commit messages. Follow the repository's existing style (shown as recent subjects). " +
  "A short imperative subject line (at most 72 characters), then, only when it helps, a blank line and a body " +
  "explaining what changed and why, wrapped at 72 columns. Describe only what the diff shows; do not invent motives.";

export const COMMIT_SCHEMA = {
  type: "object",
  properties: { message: { type: "string", description: "The full commit message." } },
  required: ["message"],
  additionalProperties: false,
};

export function commitPrompt(changes: string, recentSubjects: string[]): string {
  const style = recentSubjects.length ? recentSubjects.map((s) => `- ${s}`).join("\n") : "(no commits yet)";
  return `Write the commit message for these changes.\n\nRecent commit subjects in this repository:\n${style}\n\n${changes}`;
}

export function parseCommitMessage(answer: unknown): string {
  const msg = (answer as { message?: unknown })?.message;
  if (typeof msg !== "string" || !msg.trim()) throw new ClaudeError("Claude returned no commit message");
  return msg.replace(/\r\n/g, "\n").trim();
}

// ---- 2. organize changes into groups ---------------------------------------

export interface PlanBlock {
  /** "b1", "b2"…: how Claude refers to the block. */
  id: string;
  path: string;
  /** The block as unified-diff lines ("-old", "+new"), or a note for whole files. */
  text: string;
}

export interface GroupPlan {
  groups: { name: string; message: string; blocks: string[] }[];
  /** Block ids Claude did not place (they stay where they are). */
  unplaced: string[];
}

export const ORGANIZE_SYSTEM =
  "You organize uncommitted changes into a few logical commits, like a careful developer splitting their work. " +
  "Each group is one coherent change (a feature, a fix, a refactor, docs, formatting...). Prefer few, meaningful groups; " +
  "keep blocks that depend on each other together. Every block goes in exactly one group.";

export const ORGANIZE_SCHEMA = {
  type: "object",
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short group name, 2-6 words." },
          message: { type: "string", description: "Commit message for this group." },
          blocks: { type: "array", items: { type: "string" }, description: "Block ids, e.g. b3." },
        },
        required: ["name", "message", "blocks"],
        additionalProperties: false,
      },
    },
  },
  required: ["groups"],
  additionalProperties: false,
};

const MAX_BLOCK_LINES = 120;

export function organizePrompt(blocks: PlanBlock[], recentSubjects: string[]): string {
  const out = [
    "Split these change blocks into logical commits. Each block has an id; refer to blocks only by id.",
    "",
    "Recent commit subjects (for the message style):",
    ...(recentSubjects.length ? recentSubjects.map((s) => `- ${s}`) : ["(no commits yet)"]),
    "",
  ];
  for (const b of blocks) {
    const lines = b.text.split("\n");
    const shown = lines.length > MAX_BLOCK_LINES ? [...lines.slice(0, MAX_BLOCK_LINES), `… (${lines.length - MAX_BLOCK_LINES} more lines)`] : lines;
    out.push(`### ${b.id} · ${b.path}`, "```diff", ...shown, "```", "");
  }
  return out.join("\n");
}

/** Checks Claude's grouping against the blocks sent: unknown ids are dropped, each block is used once. */
export function parseGroupPlan(answer: unknown, blockIds: string[]): GroupPlan {
  const raw = (answer as { groups?: unknown })?.groups;
  if (!Array.isArray(raw)) throw new ClaudeError("Claude returned no groups");
  const known = new Set(blockIds);
  const used = new Set<string>();
  const groups: GroupPlan["groups"] = [];
  for (const g of raw) {
    if (!g || typeof g !== "object") continue;
    const { name, message, blocks } = g as Record<string, unknown>;
    const ids = (Array.isArray(blocks) ? blocks : [])
      .filter((b): b is string => typeof b === "string")
      .map((b) => b.trim())
      .filter((b) => known.has(b) && !used.has(b));
    ids.forEach((b) => used.add(b));
    if (!ids.length) continue;
    const title = typeof name === "string" && name.trim() ? name.trim().slice(0, 80) : `Group ${groups.length + 1}`;
    groups.push({ name: title, message: typeof message === "string" ? message.trim() : "", blocks: ids });
  }
  if (!groups.length) throw new ClaudeError("Claude's grouping did not use any of the change blocks");
  return { groups, unplaced: blockIds.filter((b) => !used.has(b)) };
}

// ---- 3. review ----------------------------------------------------------------

export interface ReviewFinding {
  path: string;
  line: number;
  comment: string;
}

export const REVIEW_SYSTEM =
  "You review a developer's uncommitted changes before they commit, like a careful senior colleague. " +
  "Report only real problems worth fixing: bugs, wrong logic, unhandled errors, security issues, data loss, " +
  "and clearly confusing code. No praise, no style nitpicks, no restating the diff. Few, high-confidence findings; " +
  "an empty list is a fine answer. Each finding points at a line of the new version of a file.";

export const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          line: { type: "integer", description: "1-based line number in the NEW version of the file (the + side)." },
          comment: { type: "string", description: "The problem and how to fix it, in 1-3 sentences." },
        },
        required: ["path", "line", "comment"],
        additionalProperties: false,
      },
    },
  },
  required: ["findings"],
  additionalProperties: false,
};

export function reviewPrompt(changes: string): string {
  return `Review these changes. Line numbers refer to the new version of each file (the + side of the @@ headers).\n\n${changes}`;
}

/** Findings on files that were sent, with a valid line (lineCount per path). */
export function parseFindings(answer: unknown, lineCount: Map<string, number>): ReviewFinding[] {
  const raw = (answer as { findings?: unknown })?.findings;
  if (!Array.isArray(raw)) throw new ClaudeError("Claude returned no review");
  const out: ReviewFinding[] = [];
  for (const f of raw) {
    const { path, line, comment } = (f ?? {}) as Record<string, unknown>;
    if (typeof path !== "string" || typeof comment !== "string" || !comment.trim()) continue;
    const clean = path.replace(/^[ab]\//, "");
    const count = lineCount.get(clean);
    if (count === undefined) continue;
    const n = typeof line === "number" && Number.isFinite(line) ? Math.round(line) : 1;
    out.push({ path: clean, line: Math.min(Math.max(1, n), Math.max(1, count)), comment: comment.trim() });
  }
  return out;
}

// ---- 4. pull request description / 5. explain a commit -------------------------

export const TEXT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    body: { type: "string", description: "Markdown." },
  },
  required: ["title", "body"],
  additionalProperties: false,
};

export const PR_SYSTEM =
  "You write pull request descriptions from a branch's commits and diff. A clear title, then a Markdown body: " +
  "a short summary of what and why, the notable changes as a list, and anything reviewers should check or test. " +
  "Base everything on the commits and diff; do not invent context.";

export function prPrompt(base: string, branch: string, commits: string, changes: string): string {
  return `Write a pull request description for merging ${branch} into ${base}.\n\nCommits (oldest first):\n${commits}\n\n${changes}`;
}

export const EXPLAIN_SYSTEM =
  "You explain a Git commit to a developer who did not write it: what it changes, why it probably does so " +
  "(say when you are guessing), and anything risky or surprising. The title is a one-line summary; the body is " +
  "short Markdown.";

export function explainPrompt(changes: string): string {
  return `Explain this commit.\n\n${changes}`;
}

export function parseText(answer: unknown): { title: string; body: string } {
  const { title, body } = (answer ?? {}) as Record<string, unknown>;
  if (typeof title !== "string" || typeof body !== "string") throw new ClaudeError("Claude returned no text");
  return { title: title.trim(), body: body.replace(/\r\n/g, "\n").trim() };
}

// ---- 6. merge conflicts ---------------------------------------------------------

export const CONFLICT_SYSTEM =
  "You resolve Git merge conflicts. You get one file with conflict markers (<<<<<<< ours, =======, >>>>>>> theirs, " +
  "maybe ||||||| base). Produce the whole file with every conflict resolved, keeping the intent of both sides " +
  "whenever they can be combined; when they truly exclude each other, choose one and say why. Change nothing " +
  "outside the conflicted regions.";

export const CONFLICT_SCHEMA = {
  type: "object",
  properties: {
    content: { type: "string", description: "The complete resolved file, without any conflict markers." },
    explanation: { type: "string", description: "Markdown: how each conflict was resolved." },
  },
  required: ["content", "explanation"],
  additionalProperties: false,
};

export function conflictPrompt(path: string, operation: string | null, text: string): string {
  const fence = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  const op = operation ? ` during a ${operation}` : "";
  return `Resolve the conflicts in ${path}${op}. "ours" is the current branch, "theirs" the incoming change.\n\n${fence}\n${text}\n${fence}`;
}

const MARKER = /^(<{7}|={7}|>{7}|\|{7})( |$)/m;

export const hasConflictMarkers = (text: string) => MARKER.test(text);

/** The resolved file, keeping the original's line endings and final newline. */
export function parseResolution(answer: unknown, original: string): { content: string; explanation: string } {
  const { content, explanation } = (answer ?? {}) as Record<string, unknown>;
  if (typeof content !== "string" || !content.trim()) throw new ClaudeError("Claude returned no resolved file");
  if (hasConflictMarkers(content)) throw new ClaudeError("Claude's version still has conflict markers");
  const crlf = original.includes("\r\n");
  let text = content.replace(/\r\n/g, "\n");
  const endsNl = /\n$/.test(original);
  text = text.replace(/\n*$/, endsNl ? "\n" : "");
  if (crlf) text = text.replace(/\n/g, "\r\n");
  return { content: text, explanation: typeof explanation === "string" ? explanation.trim() : "" };
}
