// The tools Hunkpad offers Claude Code over MCP (the server is src-tauri/src/mcp.rs).
// Claude sees what the user sees (active repo, open file, cursor, changes,
// groups, comments) and can organise groups, comment and open files. Anything
// that runs Git goes through Hunkpad's normal confirmation dialog.
//
// This file is the protocol side (tool list, argument checks, dispatch); the
// app implements `McpHost`, so the dispatch can be tested without a window.

export type Outcome = "done" | "cancelled" | "failed";

export interface McpHost {
  view(): unknown;
  switchRepo(root: string): Promise<void>;
  changes(includeDiff: boolean): Promise<unknown>;
  createGroup(name: string, message: string | undefined, makeActive: boolean): string;
  updateGroup(id: string, change: { name?: string; message?: string }): void;
  deleteGroup(id: string): void;
  setActiveGroup(id: string | null): void;
  assignBlocks(blockIds: string[], groupId: string | null): Promise<{ moved: string[]; notFound: string[] }>;
  listComments(filter: "open" | "resolved" | "all"): unknown;
  addComment(path: string, line: number, text: string): Promise<string>;
  resolveComment(id: string, resolved: boolean): void;
  openFile(path: string, line: number | undefined): Promise<void>;
  stageGroup(id: string): Promise<Outcome>;
  commitGroup(id: string, message: string | undefined): Promise<Outcome>;
}

/** A tool's input is wrong, or what it names does not exist: reported to Claude as a tool error. */
export class ToolError extends Error {}

const obj = (properties: Record<string, object>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const str = (description: string) => ({ type: "string", description });
const groupOrNull = { type: ["string", "null"], description: "Group id, or null for Ungrouped." };

export const TOOLS = [
  {
    name: "hunkpad_get_view",
    description:
      "What the user is looking at in Hunkpad right now: the active repository (branch, upstream, ahead/behind, " +
      "merge/rebase in progress), the other open repository tabs, the side tab, the open file and diff, and the " +
      "cursor line and selected text in it.",
    inputSchema: obj({}),
    annotations: { readOnlyHint: true },
  },
  {
    name: "hunkpad_switch_repo",
    description: "Make another open repository tab the active one (every other tool acts on the active tab).",
    inputSchema: obj({ root: str("Repository root, as listed in hunkpad_get_view.openRepos.") }, ["root"]),
  },
  {
    name: "hunkpad_list_changes",
    description:
      "The active repository's changes as Hunkpad shows them: staged files, unstaged files split into change " +
      "blocks (each with an id and its change group), Kept local files (never committed), conflicts, and the " +
      "change groups (local changelists the user commits one by one). Set includeDiff for each block's lines.",
    inputSchema: obj({ includeDiff: { type: "boolean", description: "Include each block's diff lines (capped)." } }),
    annotations: { readOnlyHint: true },
  },
  {
    name: "hunkpad_create_group",
    description: "Create a change group (local to Hunkpad, nothing is committed). Returns its id.",
    inputSchema: obj(
      {
        name: str("Short name, e.g. 'Fix token refresh'."),
        message: str("Suggested commit message, offered when the user commits the group."),
        makeActive: { type: "boolean", description: "New changes the user makes go to this group." },
      },
      ["name"],
    ),
  },
  {
    name: "hunkpad_update_group",
    description: "Rename a change group or change its suggested commit message.",
    inputSchema: obj({ groupId: str("Group id."), name: str("New name."), message: str("New commit message.") }, ["groupId"]),
  },
  {
    name: "hunkpad_delete_group",
    description: "Delete a change group; its blocks go back to Ungrouped. The changes themselves are kept.",
    inputSchema: obj({ groupId: str("Group id.") }, ["groupId"]),
    annotations: { destructiveHint: false },
  },
  {
    name: "hunkpad_set_active_group",
    description: "Choose the group new changes go to (null = Ungrouped).",
    inputSchema: obj({ groupId: groupOrNull }, ["groupId"]),
  },
  {
    name: "hunkpad_assign_blocks",
    description:
      "Move change blocks (ids from hunkpad_list_changes) into a group, or to Ungrouped with null. " +
      "Ids of blocks that changed since they were listed are returned in notFound: list again.",
    inputSchema: obj(
      { blockIds: { type: "array", items: { type: "string" }, minItems: 1 }, groupId: groupOrNull },
      ["blockIds", "groupId"],
    ),
  },
  {
    name: "hunkpad_list_comments",
    description: "Review comments the user (or Claude) left on lines of the active repository's files.",
    inputSchema: obj({ status: { type: "string", enum: ["open", "resolved", "all"], description: "Default: open." } }),
    annotations: { readOnlyHint: true },
  },
  {
    name: "hunkpad_add_comment",
    description: "Add a review comment on a line of a file in the working tree; it shows in the diff and the Comments tab.",
    inputSchema: obj(
      {
        path: str("Repository-relative path, with forward slashes."),
        line: { type: "integer", minimum: 1, description: "1-based line in the file on disk." },
        text: str("The comment."),
      },
      ["path", "line", "text"],
    ),
  },
  {
    name: "hunkpad_resolve_comment",
    description: "Mark a review comment resolved (or open again with resolved: false).",
    inputSchema: obj({ commentId: str("Comment id."), resolved: { type: "boolean", description: "Default: true." } }, ["commentId"]),
  },
  {
    name: "hunkpad_open_file",
    description: "Show a file of the active repository in Hunkpad's window, optionally at a line.",
    inputSchema: obj(
      { path: str("Repository-relative path, with forward slashes."), line: { type: "integer", minimum: 1 } },
      ["path"],
    ),
  },
  {
    name: "hunkpad_stage_group",
    description: "Stage a change group's blocks. Hunkpad shows the Git command to the user, who may decline.",
    inputSchema: obj({ groupId: str("Group id.") }, ["groupId"]),
  },
  {
    name: "hunkpad_commit_group",
    description:
      "Commit exactly one change group's blocks (other changes stay uncommitted). Hunkpad shows the Git command " +
      "to the user, who may decline. Uses the message given, else the group's suggested message.",
    inputSchema: obj({ groupId: str("Group id."), message: str("Commit message.") }, ["groupId"]),
  },
] as const;

type Args = Record<string, unknown>;

function needString(args: Args, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) throw new ToolError(`${key} is required`);
  return v;
}
function optString(args: Args, key: string): string | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new ToolError(`${key} must be a string`);
  return v;
}
function optBool(args: Args, key: string, fallback: boolean): boolean {
  const v = args[key];
  if (v === undefined) return fallback;
  if (typeof v !== "boolean") throw new ToolError(`${key} must be true or false`);
  return v;
}
function needGroupOrNull(args: Args): string | null {
  const v = args.groupId;
  if (v === null) return null;
  if (typeof v !== "string" || !v) throw new ToolError("groupId must be a group id or null");
  return v;
}
function needLine(args: Args, key: string, required: boolean): number | undefined {
  const v = args[key];
  if (v === undefined && !required) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new ToolError(`${key} must be a line number (1 or more)`);
  return v;
}
/** Repository-relative, forward slashes, inside the repository. */
export function repoPath(raw: string): string {
  const p = raw.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!p || p.startsWith("/") || /^[a-z]:/i.test(p) || p.split("/").some((s) => s === ".." || s === ""))
    throw new ToolError(`not a repository-relative path: ${raw}`);
  return p;
}

const outcomeText: Record<Outcome, string> = {
  done: "done",
  cancelled: "The user declined it in Hunkpad: nothing was run.",
  failed: "It failed in Hunkpad; the user sees the error there.",
};

async function callTool(host: McpHost, name: string, args: Args): Promise<unknown> {
  switch (name) {
    case "hunkpad_get_view":
      return host.view();
    case "hunkpad_switch_repo":
      await host.switchRepo(needString(args, "root"));
      return host.view();
    case "hunkpad_list_changes":
      return host.changes(optBool(args, "includeDiff", false));
    case "hunkpad_create_group":
      return { groupId: host.createGroup(needString(args, "name").trim(), optString(args, "message"), optBool(args, "makeActive", false)) };
    case "hunkpad_update_group": {
      const name = optString(args, "name")?.trim();
      const message = optString(args, "message");
      if (!name && message === undefined) throw new ToolError("give a name or a message");
      host.updateGroup(needString(args, "groupId"), { ...(name ? { name } : {}), ...(message !== undefined ? { message } : {}) });
      return { ok: true };
    }
    case "hunkpad_delete_group":
      host.deleteGroup(needString(args, "groupId"));
      return { ok: true };
    case "hunkpad_set_active_group":
      host.setActiveGroup(needGroupOrNull(args));
      return { ok: true };
    case "hunkpad_assign_blocks": {
      const ids = args.blockIds;
      if (!Array.isArray(ids) || !ids.length || ids.some((x) => typeof x !== "string")) throw new ToolError("blockIds must be a list of block ids");
      return host.assignBlocks(ids as string[], needGroupOrNull(args));
    }
    case "hunkpad_list_comments": {
      const status = optString(args, "status") ?? "open";
      if (status !== "open" && status !== "resolved" && status !== "all") throw new ToolError("status must be open, resolved or all");
      return host.listComments(status);
    }
    case "hunkpad_add_comment":
      return { commentId: await host.addComment(repoPath(needString(args, "path")), needLine(args, "line", true)!, needString(args, "text").trim()) };
    case "hunkpad_resolve_comment":
      host.resolveComment(needString(args, "commentId"), optBool(args, "resolved", true));
      return { ok: true };
    case "hunkpad_open_file":
      await host.openFile(repoPath(needString(args, "path")), needLine(args, "line", false));
      return { ok: true };
    case "hunkpad_stage_group":
      return { outcome: outcomeText[await host.stageGroup(needString(args, "groupId"))] };
    case "hunkpad_commit_group":
      return { outcome: outcomeText[await host.commitGroup(needString(args, "groupId"), optString(args, "message"))] };
    default:
      throw new ToolError(`unknown tool: ${name}`);
  }
}

type Answer = { result: unknown } | { error: { code: number; message: string } };

/** Answers one JSON-RPC request forwarded by the server (initialize and ping are answered there). */
export async function handleMcp(host: McpHost, method: string, params: unknown): Promise<Answer> {
  if (method === "tools/list") return { result: { tools: TOOLS } };
  if (method !== "tools/call") return { error: { code: -32601, message: `method not found: ${method}` } };
  const p = (params ?? {}) as { name?: unknown; arguments?: unknown };
  if (typeof p.name !== "string") return { error: { code: -32602, message: "tools/call needs a tool name" } };
  if (!TOOLS.some((t) => t.name === p.name)) return { error: { code: -32602, message: `unknown tool: ${p.name}` } };
  const args = p.arguments && typeof p.arguments === "object" ? (p.arguments as Args) : {};
  try {
    const data = await callTool(host, p.name, args);
    return {
      result: {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        ...(data && typeof data === "object" && !Array.isArray(data) ? { structuredContent: data } : {}),
      },
    };
  } catch (e) {
    // Tool failures are results Claude can read and recover from, not protocol errors.
    const text = e instanceof Error ? e.message : String(e);
    return { result: { isError: true, content: [{ type: "text", text }] } };
  }
}

/** Block ids: path, the block's first old line, and its content hash (positions move as the user edits). */
export const blockId = (path: string, oldStart: number, sig: string) => `${path}#${oldStart}.${sig}`;

export function parseBlockId(id: string): { path: string; oldStart: number; sig: string } | null {
  const hash = id.lastIndexOf("#");
  if (hash <= 0) return null;
  const m = /^(\d+)\.(.+)$/.exec(id.slice(hash + 1));
  return m ? { path: id.slice(0, hash), oldStart: Number(m[1]), sig: m[2] } : null;
}

export const MCP_NAME = "hunkpad";
export const mcpUrl = (port: number) => `http://127.0.0.1:${port}/mcp`;

/**
 * `claude mcp add` arguments that install this server for every project (user scope).
 * --header takes several values, so it goes last: before the name it would swallow it.
 */
export const installArgs = (port: number, token: string) => [
  "mcp",
  "add",
  "--transport",
  "http",
  "--scope",
  "user",
  MCP_NAME,
  mcpUrl(port),
  "--header",
  `Authorization: Bearer ${token}`,
];

export const removeArgs = () => ["mcp", "remove", "--scope", "user", MCP_NAME];

/** A new random token (hex). */
export function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
