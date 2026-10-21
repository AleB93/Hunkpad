import { describe, expect, it } from "vitest";
import { McpHost, TOOLS, ToolError, blockId, handleMcp, installArgs, parseBlockId, repoPath } from "../src/mcp";

/** A host that records calls and answers with canned data. */
function fakeHost(): McpHost & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  const rec =
    (name: string, value?: unknown) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
      return value as never;
    };
  return {
    calls,
    view: rec("view", { repo: { root: "C:/r" } }),
    switchRepo: async (root: string) => void calls.push(["switchRepo", root]),
    changes: async (d: boolean) => (calls.push(["changes", d]), { unstaged: [] }),
    createGroup: rec("createGroup", "g1"),
    updateGroup: rec("updateGroup"),
    deleteGroup: (id: string) => {
      if (id !== "g1") throw new ToolError(`No change group with id ${id}`);
      calls.push(["deleteGroup", id]);
    },
    setActiveGroup: rec("setActiveGroup"),
    assignBlocks: async (ids: string[], g: string | null) => (calls.push(["assignBlocks", ids, g]), { moved: ids, notFound: [] }),
    listComments: rec("listComments", []),
    addComment: async (...a: unknown[]) => (calls.push(["addComment", ...a]), "c1"),
    resolveComment: rec("resolveComment"),
    openFile: async (...a: unknown[]) => void calls.push(["openFile", ...a]),
    stageGroup: async () => "done",
    commitGroup: async () => "cancelled",
  };
}

const call = (host: McpHost, name: string, args: object = {}) => handleMcp(host, "tools/call", { name, arguments: args });
const text = (a: Awaited<ReturnType<typeof handleMcp>>) =>
  "result" in a ? ((a.result as { content: { text: string }[] }).content[0].text) : a.error.message;

describe("MCP tools", () => {
  it("lists every tool with an object input schema", async () => {
    const a = await handleMcp(fakeHost(), "tools/list", {});
    const tools = (a as { result: { tools: typeof TOOLS } }).result.tools;
    expect(tools.length).toBe(TOOLS.length);
    for (const t of tools) {
      expect(t.name).toMatch(/^hunkpad_[a-z_]+$/);
      expect(t.inputSchema.type).toBe("object");
    }
  });

  it("calls the host with checked arguments and returns structured content", async () => {
    const host = fakeHost();
    const a = await call(host, "hunkpad_create_group", { name: "  Fix login ", message: "fix: login", makeActive: true });
    expect(host.calls).toContainEqual(["createGroup", "Fix login", "fix: login", true]);
    expect((a as { result: { structuredContent: unknown } }).result.structuredContent).toEqual({ groupId: "g1" });
  });

  it("reports bad input and host errors as tool errors, not protocol errors", async () => {
    const host = fakeHost();
    const bad = await call(host, "hunkpad_add_comment", { path: "../etc/passwd", line: 1, text: "x" });
    expect((bad as { result: { isError: boolean } }).result.isError).toBe(true);
    expect(text(bad)).toMatch(/repository-relative/);
    const missing = await call(host, "hunkpad_delete_group", { groupId: "nope" });
    expect(text(missing)).toMatch(/No change group/);
    const line = await call(host, "hunkpad_open_file", { path: "a.ts", line: 0 });
    expect(text(line)).toMatch(/line number/);
  });

  it("passes null for Ungrouped and normalises paths", async () => {
    const host = fakeHost();
    await call(host, "hunkpad_assign_blocks", { blockIds: ["a.ts#3.x"], groupId: null });
    await call(host, "hunkpad_open_file", { path: ".\\src\\a.ts", line: 4 });
    expect(host.calls).toContainEqual(["assignBlocks", ["a.ts#3.x"], null]);
    expect(host.calls).toContainEqual(["openFile", "src/a.ts", 4]);
  });

  it("tells Claude when the user declined a Git command", async () => {
    expect(text(await call(fakeHost(), "hunkpad_commit_group", { groupId: "g1" }))).toMatch(/declined/);
  });

  it("rejects unknown tools and methods", async () => {
    expect(await handleMcp(fakeHost(), "tools/call", { name: "rm_rf" })).toHaveProperty("error");
    expect(await handleMcp(fakeHost(), "resources/list", {})).toHaveProperty("error.code", -32601);
  });
});

describe("MCP helpers", () => {
  it("round-trips block ids, also for paths with #", () => {
    expect(parseBlockId(blockId("docs/a#b.md", 12, "k3x"))).toEqual({ path: "docs/a#b.md", oldStart: 12, sig: "k3x" });
    expect(parseBlockId("nonsense")).toBeNull();
  });

  it("keeps paths inside the repository", () => {
    expect(repoPath("src/a.ts")).toBe("src/a.ts");
    for (const p of ["/etc/passwd", "C:/x", "a/../../b", ""]) expect(() => repoPath(p)).toThrow(ToolError);
  });

  it("installs for the user scope with the token as a header", () => {
    const args = installArgs(47821, "t".repeat(64));
    expect(args.slice(0, 2)).toEqual(["mcp", "add"]);
    expect(args).toContain("user");
    expect(args).toContain(`Authorization: Bearer ${"t".repeat(64)}`);
    // --header is variadic: name and URL must come before it.
    expect(args.slice(-4)).toEqual(["hunkpad", "http://127.0.0.1:47821/mcp", "--header", `Authorization: Bearer ${"t".repeat(64)}`]);
  });
});
