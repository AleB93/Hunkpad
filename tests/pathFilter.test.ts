import { describe, expect, it } from "vitest";
import { TESTS_PATTERN, pathFilter } from "../src/overview";

describe("All changes: filter files by path", () => {
  it("hides or keeps only the files that match, ignoring case", () => {
    const hide = pathFilter("\\.md$", "hide");
    expect(hide.keep("README.md")).toBe(false);
    expect(hide.keep("src/main.ts")).toBe(true);
    const only = pathFilter("^SRC/", "only");
    expect(only.keep("src/main.ts")).toBe(true);
    expect(only.keep("tests/a.ts")).toBe(false);
  });

  it("keeps everything for an empty or invalid pattern, and says why it is invalid", () => {
    expect(pathFilter("  ", "hide").keep("x")).toBe(true);
    const bad = pathFilter("(", "hide");
    expect(bad.error).toBeTruthy();
    expect(bad.keep("x")).toBe(true);
  });

  it("the Hide tests preset finds test files in common layouts", () => {
    const keep = pathFilter(TESTS_PATTERN, "hide").keep;
    const tests = [
      "tests/search.test.ts",
      "test/unit/a.js",
      "src/__tests__/x.tsx",
      "spec/models/user_spec.rb",
      "src/app.test.ts",
      "src/app.spec.js",
      "pkg/server_test.go",
      "lib/test_utils.py",
      "source/Board.IdentityHub.UnitTests/Services/StoreTests.cs",
      "source/Board.IdentityHub.IntegrationTests/Auth/FlowTests.cs",
      "Foo.Tests/Bar.cs",
    ];
    for (const p of tests) expect(keep(p), p).toBe(false);
  });

  it("the Hide tests preset leaves ordinary files alone", () => {
    const keep = pathFilter(TESTS_PATTERN, "hide").keep;
    const code = [
      "src/latest.ts",
      "src/contest.js",
      "src/testing-library-setup-notes.md",
      "latest/index.ts",
      "source/Board.IdentityHub.Server/Services/TokenExchangeGrantValidator.cs",
      "docs/attestation.md",
    ];
    for (const p of code) expect(keep(p), p).toBe(true);
  });
});
