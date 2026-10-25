import { describe, expect, it } from "vitest";
import { citedFiles, Fact, staleCite, type FileChange } from "../src/index.js";

/**
 * A changed file invalidates only what cites it (CLAUDE.md rule 4, ADR 0124 addendum
 * A-incremental): the files a fact rests on, and whether a diff between two commits touches one.
 */

const fact = (o: Record<string, unknown>): Fact =>
  Fact.parse({ repo: "forge-ledger", commit: "1111111", ...o });

const entry = fact({
  kind: "entry",
  id: "e-get",
  entryType: "rest",
  method: "GET",
  path: "/api/accounts/{id}",
  cite: {
    file: "src/AccountController.java",
    line: 18,
    value: "/accounts/{id}",
    with: [{ file: "src/main/resources/application.yml", line: 3, value: "/api" }],
  },
});
const flow = fact({
  kind: "flow",
  id: "w-get",
  name: "Get an account",
  entry: "e-get",
  cite: { file: "src/AccountController.java", line: 18, value: "/accounts/{id}" },
  steps: [
    {
      kind: "read",
      what: "reads the account",
      cite: {
        file: "src/AccountRepository.java",
        line: 9,
        value: "accounts",
        with: [{ file: "src/Account.java", line: 4, value: "accounts" }],
      },
    },
  ],
  errors: [
    {
      when: "no account",
      then: "404",
      cite: { file: "src/NotFound.java", line: 2, value: "NotFound" },
    },
  ],
});

describe("citedFiles", () => {
  it("names the cited file and every cite.with file, once each, in order", () => {
    expect(citedFiles(entry)).toEqual([
      "src/AccountController.java",
      "src/main/resources/application.yml",
    ]);
  });
  it("names the line an entry's auth rests on (ADR 0124 addendum A-read)", () => {
    const secured = fact({
      ...entry,
      auth: "mtls",
      authCite: { file: "src/main/resources/security.yml", line: 7, value: "client-auth" },
    });
    expect(citedFiles(secured)).toEqual([
      "src/AccountController.java",
      "src/main/resources/application.yml",
      "src/main/resources/security.yml",
    ]);
  });
  it("names a flow's step and error cites and their parts too", () => {
    expect(citedFiles(flow)).toEqual([
      "src/Account.java",
      "src/AccountController.java",
      "src/AccountRepository.java",
      "src/NotFound.java",
    ]);
  });
});

describe("staleCite: whether a diff touches a file a fact rests on", () => {
  const diff = (...c: FileChange[]) => c;
  it("is undefined when no cited file changed (an unrelated file did)", () => {
    expect(staleCite(entry, diff({ status: "modified", path: "README.md" }))).toBeUndefined();
    // a file added beside it, or copied from it, leaves the cited file as it was
    expect(
      staleCite(
        entry,
        diff(
          { status: "added", path: "src/Other.java" },
          { status: "copied", path: "src/Copy.java", from: "src/AccountController.java" },
        ),
      ),
    ).toBeUndefined();
  });
  it("says an edited, deleted or renamed cited file, following the rename", () => {
    expect(
      staleCite(entry, diff({ status: "modified", path: "src/AccountController.java" })),
    ).toEqual({ file: "src/AccountController.java", how: "edited" });
    expect(
      staleCite(entry, diff({ status: "deleted", path: "src/AccountController.java" })),
    ).toEqual({ file: "src/AccountController.java", how: "deleted" });
    expect(
      staleCite(
        entry,
        diff({
          status: "renamed",
          path: "src/accounts/AccountController.java",
          from: "src/AccountController.java",
        }),
      ),
    ).toEqual({
      file: "src/AccountController.java",
      how: "renamed",
      to: "src/accounts/AccountController.java",
    });
  });
  it("counts a cite.with part's file, and a flow step's", () => {
    expect(
      staleCite(entry, diff({ status: "modified", path: "src/main/resources/application.yml" })),
    ).toEqual({ file: "src/main/resources/application.yml", how: "edited" });
    expect(staleCite(flow, diff({ status: "type-changed", path: "src/Account.java" }))).toEqual({
      file: "src/Account.java",
      how: "edited",
    });
    expect(staleCite(flow, diff({ status: "deleted", path: "src/NotFound.java" }))).toEqual({
      file: "src/NotFound.java",
      how: "deleted",
    });
  });
});
