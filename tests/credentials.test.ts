import { describe, expect, it } from "vitest";
import { credentialTarget } from "../src/git";

describe("sign-in target of a remote URL", () => {
  it("reads protocol, host and the account named in the URL", () => {
    expect(credentialTarget("https://github.com/owner/repo.git")).toEqual({ protocol: "https", host: "github.com", urlUser: "" });
    expect(credentialTarget("https://GoldenPredictions@github.com/GoldenPredictions/goldenpredictions.git")).toEqual({
      protocol: "https",
      host: "github.com",
      urlUser: "GoldenPredictions",
    });
    expect(credentialTarget("http://git.local:8080/r.git")?.host).toBe("git.local:8080");
    expect(credentialTarget("https://first%40mail.com@host.dev/r")?.urlUser).toBe("first@mail.com");
  });

  it("is null for SSH and local remotes", () => {
    expect(credentialTarget("git@github.com:owner/repo.git")).toBeNull();
    expect(credentialTarget("ssh://git@github.com/owner/repo.git")).toBeNull();
    expect(credentialTarget("/srv/repos/r.git")).toBeNull();
    expect(credentialTarget("C:\\repos\\r")).toBeNull();
  });
});
