import { describe, expect, it } from "vitest";
import { Fact, type FileChange } from "@maycombhq/core";
import { insideRepo, slugFactId, verifyFacts, type FileSource } from "../src/index.js";

/**
 * Review round 46 (Windows): NTFS opens `.env::$DATA` as `.env` and `a.ts.` as `a.ts`, and opens
 * `SRC\App.ts` as `src/App.ts`, so the verifier takes a cited path only as the repo lists it.
 */

/** A checkout on NTFS: a path is opened whatever its case and its slashes, and a stream's name reads the file. */
function ntfsSource(files: Record<string, string>): FileSource {
  const keys = Object.keys(files).sort();
  const fold = (p: string) =>
    p
      .replace(/\\/g, "/")
      .split("/")
      .map((x) => x.replace(/:.*$/, "").replace(/[. ]+$/, ""))
      .join("/")
      .toLowerCase();
  return {
    list: () => keys,
    read: (p) => {
      const k = keys.find((x) => fold(x) === fold(p));
      return k === undefined ? undefined : files[k];
    },
  };
}

const COMMIT = "abc1234";
const files = {
  "src/AccountController.java": [
    "@RestController",
    "class AccountController {",
    '  @GetMapping("/accounts/{id}")',
    "}",
  ].join("\n"),
  ".env": "DB_PASSWORD=hunter2\n",
  "certs/server.key": "-----BEGIN PRIVATE KEY-----\n",
};
const entry = (file: string, o: Record<string, unknown> = {}) =>
  Fact.parse({
    repo: "forge-ledger",
    commit: COMMIT,
    kind: "entry",
    id: "e-get-account",
    entryType: "rest",
    method: "GET",
    path: "/accounts/{id}",
    cite: { file, line: 3, value: "/accounts/{id}" },
    ...o,
  });

describe("insideRepo on Windows", () => {
  it.each([
    ".env::$DATA",
    "certs/server.key::$DATA",
    "src/a.ts:stream",
    "src/a.ts.",
    "src/a.ts ",
    "src./a.ts",
    "..\\outside.txt",
    "src\\..\\..\\outside.txt",
    "C:\\Windows\\win.ini",
    "\\\\server\\share\\a.txt",
  ])("refuses %s", (p) => expect(insideRepo(p)).toBe(false));

  it.each(["src/a.ts", "src\\a.ts", ".env", "a/b/.gitignore", "./src/a.ts"])("takes %s", (p) =>
    expect(insideRepo(p)).toBe(true),
  );
});

describe("the verifier on an NTFS checkout", () => {
  it("refuses a fact citing a secret's file through its data stream or a trailing dot", async () => {
    for (const file of [".env::$DATA", "certs/server.key::$DATA", ".env.", "certs/server.key "]) {
      const r = await verifyFacts({
        facts: [entry(file, { cite: { file, line: 1, value: "DB_PASSWORD" } })],
        source: ntfsSource(files),
        commit: COMMIT,
      });
      expect(r.accepted, file).toEqual([]);
      expect(["outside-repo", "secret-path"]).toContain(r.rejected[0]!.code);
    }
  });

  it("stores a wrongly cased or backslashed cited path as the repo lists it", async () => {
    for (const file of ["SRC/accountcontroller.java", "src\\AccountController.java"]) {
      const r = await verifyFacts({
        facts: [entry(file)],
        source: ntfsSource(files),
        commit: COMMIT,
      });
      expect(r.rejected, file).toEqual([]);
      expect(r.accepted.map((f) => f.cite.file)).toEqual(["src/AccountController.java"]);
      // coverage counts the file it cites as read
      expect(r.coverage.read).toContain("src/AccountController.java");
    }
  });

  it("refuses a cited path the repo doesn't list, even when NTFS would open it", async () => {
    const r = await verifyFacts({
      facts: [entry("src/AccountController.java.")],
      source: ntfsSource(files),
      commit: COMMIT,
    });
    expect(r.accepted).toEqual([]);
    expect(r.rejected[0]!.code).toBe("outside-repo");
  });

  it("checks a carried fact's cited files by the repo's spelling", async () => {
    const edited: FileChange = { status: "modified", path: "src/AccountController.java" };
    const r = await verifyFacts({
      facts: [entry("SRC\\AccountController.java", { commit: "1111111" })],
      source: ntfsSource(files),
      commit: COMMIT,
      carry: { "1111111": [edited] },
    });
    expect(r.rejected.map((x) => x.code)).toEqual(["cite-changed"]);
  });
});

it("a fact id is never a Windows device name", () => {
  expect(slugFactId("aux")).toBe("aux-1");
  expect(slugFactId("Con")).toBe("con-1");
  expect(slugFactId("auxRead")).toBe("aux-read");
});
