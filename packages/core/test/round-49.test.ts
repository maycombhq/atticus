import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  decodeText,
  estimateTokens,
  Fact,
  isBinaryBytes,
  isBinaryText,
  isLfsPointer,
  listRepoFilesSync,
  staleCite,
  walkRepo,
  type FileChange,
} from "../src/index.js";

/**
 * Review round 49 (scan pipeline): one text decoder, one token estimate and one walker of a
 * checkout, shared by the verifier, the scan and the assistant's code tools.
 */

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "atticus-r49-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("decodeText", () => {
  it("decodes UTF-16 LE and BE with a byte-order mark (SSMS writes .sql so)", () => {
    const text = "CREATE TABLE orders (\r\n  id int\r\n);";
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    expect(decodeText(le)).toBe(text);
    const be = Buffer.from(le);
    be[0] = 0xfe;
    be[1] = 0xff;
    for (let i = 2; i + 1 < be.length; i += 2) {
      const a = le[i]!;
      be[i] = le[i + 1]!;
      be[i + 1] = a;
    }
    expect(decodeText(be)).toBe(text);
  });

  it("strips a UTF-8 byte-order mark and keeps valid UTF-8 as it is", () => {
    expect(decodeText(Buffer.from("﻿public class CaféController {}", "utf8"))).toBe(
      "public class CaféController {}",
    );
    expect(decodeText(Buffer.from("注文の合計", "utf8"))).toBe("注文の合計");
  });

  it("reads invalid UTF-8 as windows-1252 (a Latin-1 file)", () => {
    // "Café" in Latin-1, and windows-1252's curly quotes and euro sign
    const bytes = Buffer.from([0x43, 0x61, 0x66, 0xe9, 0x20, 0x93, 0x80, 0x94]);
    expect(decodeText(bytes)).toBe("Café “€”");
  });

  it("says a file with a NUL and no UTF-16 mark is binary, and one with the mark isn't", () => {
    expect(isBinaryBytes(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]))).toBe(true);
    expect(
      isBinaryBytes(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("a", "utf16le")])),
    ).toBe(false);
    expect(isBinaryBytes(Buffer.from("plain text\n"))).toBe(false);
    expect(isBinaryText("PK\u0003\u0004\u0000\u0000")).toBe(true);
    expect(isBinaryText("plain")).toBe(false);
  });
});

describe("isLfsPointer", () => {
  it("knows an un-smudged Git LFS pointer by its first line", () => {
    expect(
      isLfsPointer(
        "version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n",
      ),
    ).toBe(true);
    expect(isLfsPointer("version: 2\n")).toBe(false);
  });
});

describe("estimateTokens", () => {
  it("counts ASCII at four characters a token, as before", () => {
    expect(estimateTokens("abcd".repeat(25))).toBe(25);
    expect(estimateTokens("")).toBe(0);
  });

  it("counts each character outside ASCII as a token, so Japanese isn't under-counted", () => {
    // 26 kanji and kana: chars/4 said 7; a tokenizer gives about one a character
    const jp = "注文の合計金額を計算して、税金と送料を加算します";
    expect(estimateTokens(jp)).toBe([...jp].length);
    // an astral character (two UTF-16 units) is one
    expect(estimateTokens("😀")).toBe(1);
    // four ASCII characters (a token) and two kanji (two)
    expect(estimateTokens("// 注文\n")).toBe(3);
  });
});

describe("listRepoFilesSync and walkRepo", () => {
  const repo = () => {
    const d = temp();
    mkdirSync(join(d, "src"));
    mkdirSync(join(d, ".terraform", "modules"), { recursive: true });
    mkdirSync(join(d, "logs"));
    writeFileSync(join(d, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(d, "src", "keep.log"), "kept by a negation\n");
    writeFileSync(join(d, "logs", "x.log"), "ignored\n");
    writeFileSync(join(d, ".terraform", "modules", "main.tf"), 'resource "x" "y" {}\n');
    writeFileSync(join(d, ".gitignore"), ".terraform/\n*.log\n!src/keep.log\n");
    writeFileSync(join(d, ".env"), "TOKEN=abc\n");
    // a loop, a link out of the repo and a link to a secret: none is walked
    link("..", join(d, "src", "loop"));
    link("/etc/hostname", join(d, "src", "host.txt"));
    link("../.env", join(d, "src", "settings.txt"));
    // a submodule's .git file
    mkdirSync(join(d, "lib"));
    writeFileSync(join(d, "lib", ".git"), "gitdir: ../.git/modules/lib\n");
    return d;
  };

  it("never follows a link, skips .git and what a .gitignore ignores, in name order", () => {
    const d = repo();
    expect(listRepoFilesSync(d)).toEqual([".env", ".gitignore", "src/a.ts", "src/keep.log"]);
  });

  it("asks the caller about each folder", () => {
    const d = repo();
    expect(listRepoFilesSync(d, { skipFolder: (_above, name) => name === "src" })).toEqual([
      ".env",
      ".gitignore",
    ]);
  });

  it("walks the same files asynchronously, and stops at a cap", async () => {
    const d = repo();
    const seen: string[] = [];
    const r = await walkRepo(d, async (p) => {
      seen.push(p);
    });
    expect(seen).toEqual(listRepoFilesSync(d));
    expect(r).toEqual({ files: 4, cut: false });
    const capped: string[] = [];
    expect(await walkRepo(d, async (p) => void capped.push(p), { max: 2 })).toEqual({
      files: 2,
      cut: true,
    });
    expect(capped).toEqual([".env", ".gitignore"]);
  });
});

describe("staleCite and a submodule bump", () => {
  const fact = Fact.parse({
    repo: "forge-ledger",
    commit: "1111111",
    kind: "entry",
    id: "e-a",
    entryType: "rest",
    method: "GET",
    path: "/v1/a",
    cite: { file: "lib/sm/api.ts", line: 1, value: "/v1/a" },
  });

  it("treats every cited file under a changed gitlink as edited", () => {
    const changes: FileChange[] = [{ status: "modified", path: "lib/sm", gitlink: true }];
    expect(staleCite(fact, changes)).toEqual({ file: "lib/sm/api.ts", how: "edited" });
  });

  it("treats a cited file under a removed gitlink as deleted", () => {
    expect(staleCite(fact, [{ status: "deleted", path: "lib/sm", gitlink: true }])).toEqual({
      file: "lib/sm/api.ts",
      how: "deleted",
    });
  });

  it("leaves a fact citing a file beside the gitlink alone", () => {
    expect(staleCite(fact, [{ status: "modified", path: "lib/s", gitlink: true }])).toBeUndefined();
  });
});

/** A symbolic link, where this machine may make one (Windows without the right may not). */
function link(target: string, path: string): void {
  try {
    symlinkSync(target, path);
  } catch {
    // no link: the walk and the reads have nothing to skip
  }
}
