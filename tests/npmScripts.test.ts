import { describe, expect, it } from "vitest";
import { npmScriptNames } from "../src/projects";

describe("npm scripts of a package.json", () => {
  it("lists the script names in file order", () => {
    const json = JSON.stringify({ scripts: { start: "next start", "release:main": "node release.mjs", dev: "vite" } });
    expect(npmScriptNames(json)).toEqual(["start", "release:main", "dev"]);
  });

  it("is empty without scripts or for invalid JSON", () => {
    expect(npmScriptNames(JSON.stringify({ name: "x" }))).toEqual([]);
    expect(npmScriptNames(JSON.stringify({ scripts: { bad: 1 } }))).toEqual([]);
    expect(npmScriptNames("{ not json")).toEqual([]);
    expect(npmScriptNames("null")).toEqual([]);
  });
});
