import {
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  ftruncateSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { claimOnLines, quoteMatches } from "@maycombhq/core";
import {
  dirSource,
  isSourceFile,
  memorySource,
  planBatches,
  sliceText,
  verifyFacts,
  type FileSource,
} from "../src/index.js";

/**
 * Review round 49 (scan pipeline): the verifier reads a checkout as the scan and the assistant's
 * tools do. No link is followed, nothing a .gitignore ignores is listed, every file is decoded
 * one way, a long line can't make a slice without end, tokens outside ASCII are counted, and a
 * file is judged by its path and size before it is read.
 */

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "atticus-verify-r49-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A source that counts what was read. */
function counting(s: FileSource) {
  const reads: string[] = [];
  const out: FileSource = {
    ...s,
    list: () => s.list(),
    read: (p) => {
      reads.push(p);
      return s.read(p);
    },
  };
  if (s.size) out.size = (p) => s.size!(p);
  return { source: out, reads };
}

// POSIX links (a loop, /etc): Windows without the right to make links has none to follow.
describe.skipIf(process.platform === "win32")("dirSource and links (bug 1)", () => {
  const linked = () => {
    const d = temp();
    mkdirSync(join(d, "src"));
    writeFileSync(join(d, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(d, ".env"), "TOKEN=abc\n");
    link("..", join(d, "src", "loop"));
    link("/etc/hostname", join(d, "src", "users.conf"));
    link("../.env", join(d, "src", "settings.yml"));
    link("/etc", join(d, "src", "etc"));
    return d;
  };

  it("lists no link: a loop is walked once, a link out of the repo or to a secret not at all", () => {
    const d = linked();
    expect(dirSource(d).list()).toEqual([".env", "src/a.ts"]);
  });

  it("reads no link, and nothing whose real path is outside the repo", () => {
    const s = dirSource(linked());
    expect(s.read("src/a.ts")).toBe("export const a = 1;\n");
    expect(s.read("src/users.conf")).toBeUndefined();
    expect(s.read("src/settings.yml")).toBeUndefined();
    expect(s.read("src/etc/hostname")).toBeUndefined();
    expect(s.read("src/loop/src/a.ts")).toBe("export const a = 1;\n");
  });
});

describe("dirSource and .gitignore (bug 6)", () => {
  it("lists nothing a .gitignore ignores, so coverage doesn't count it", async () => {
    const d = temp();
    mkdirSync(join(d, "src"));
    mkdirSync(join(d, ".terraform", "modules", "vpc"), { recursive: true });
    writeFileSync(join(d, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(d, ".terraform", "modules", "vpc", "main.tf"), 'resource "x" "y" {}\n');
    writeFileSync(join(d, ".gitignore"), ".terraform/\n");
    const s = dirSource(d);
    expect(s.list()).toEqual([".gitignore", "src/a.ts"]);
    const r = await verifyFacts({ facts: [], source: s, commit: "0123abc" });
    expect(r.coverage.unknown).toEqual(["src/a.ts"]);
  });
});

describe("decoding (bug 7)", () => {
  it("reads a UTF-16 .sql and a Latin-1 .java so their lines verify", () => {
    const d = temp();
    writeFileSync(
      join(d, "orders.sql"),
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from("CREATE TABLE orders (\r\n  id int\r\n);\r\n", "utf16le"),
      ]),
    );
    writeFileSync(
      join(d, "Legacy.java"),
      Buffer.concat([
        Buffer.from("package forge;\n"),
        Buffer.from([...Buffer.from("public class Caf"), 0xe9, ...Buffer.from("Controller {}\n")]),
      ]),
    );
    const s = dirSource(d);
    const sql = s.read("orders.sql")!.split(/\r?\n/);
    expect(claimOnLines(sql, 1, { kind: "word", value: "orders" })).toBe(true);
    expect(quoteMatches(sql[0]!, "CREATE TABLE orders (")).toBe(true);
    const java = s.read("Legacy.java")!.split("\n");
    expect(claimOnLines(java, 2, { kind: "word", value: "CaféController" })).toBe(true);
    expect(quoteMatches(java[1]!, "public class CaféController {}")).toBe(true);
    expect(planBatches(s, { room: 10_000 }).files).toBe(2);
  });

  it("takes a file with a NUL and no UTF-16 mark as binary, not source", () => {
    const s = memorySource({ "src/blob.ts": "PK\u0003\u0004\u0000\u0000junk", "src/a.ts": "a;\n" });
    expect(
      isSourceFile("src/blob.ts", "PK\u0003\u0004\u0000\u0000junk", [
        "PK\u0003\u0004\u0000\u0000junk",
      ]),
    ).toBe(false);
    expect(
      planBatches(s, { room: 10_000 })
        .batches.flat()
        .map((x) => x.path),
    ).toEqual(["src/a.ts"]);
  });
});

describe("Git LFS pointers (bug 10)", () => {
  const pointer =
    "version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 1048576\n";

  it("are not source: not in coverage, not in a prompt", async () => {
    const s = memorySource({ "data/rates.json": pointer, "src/a.ts": "a;\n" });
    expect(isSourceFile("data/rates.json", pointer.split("\n")[0], pointer.split("\n"))).toBe(
      false,
    );
    expect(
      planBatches(s, { room: 10_000 })
        .batches.flat()
        .map((x) => x.path),
    ).toEqual(["src/a.ts"]);
    const r = await verifyFacts({ facts: [], source: s, commit: "0123abc" });
    expect(r.coverage.unknown).toEqual(["src/a.ts"]);
  });
});

describe("a long line (bug 4)", () => {
  it("is cut in the prompt, so its slice stays within the room, and a quote of it still matches", () => {
    const long = `export const TABLE = "${"x".repeat(200_000)}";`;
    const text = `// rates\n${long}\nexport const b = 2;\n`;
    const s = memorySource({ "src/rates.ts": text });
    const plan = planBatches(s, { room: 2_000 });
    const slices = plan.batches.flat();
    for (const x of slices) expect(x.tokens).toBeLessThanOrEqual(2_000);
    const shown = slices.map((x) => sliceText(s, x)).join("\n");
    expect(shown.length).toBeLessThan(4_000);
    expect(shown).toContain('2| export const TABLE = "xxx');
    expect(shown).toMatch(/2\| .* … \[line cut: 200024 characters\]/);
    expect(shown).toContain("3| export const b = 2;");
    // what the reader can quote is the start of the real line
    expect(quoteMatches(long, 'export const TABLE = "xxxxxxxxxx')).toBe(true);
  });
});

describe("tokens outside ASCII (bug 8)", () => {
  it("counts Japanese at a token a character, so its batches fit the room", () => {
    const line = "// 注文の合計金額を計算して、税金と送料を加算します";
    const text = Array.from({ length: 3000 }, () => line).join("\n");
    const plan = planBatches(memorySource({ "src/notes.ts": text }), { room: 60_000 });
    // about 26 tokens a line, 3,000 lines: more than one prompt of 60,000
    expect(plan.tokens).toBeGreaterThan(75_000);
    expect(plan.batches.length).toBeGreaterThan(1);
    for (const b of plan.batches) for (const x of b) expect(x.tokens).toBeLessThanOrEqual(60_000);
  });
});

describe("judged by path and size before it is read (bug 9)", () => {
  it("never reads a binary by its name, or a file over the size a source file may be", async () => {
    const d = temp();
    mkdirSync(join(d, "src"));
    writeFileSync(join(d, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(d, "src", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    // a sparse 64 MB file: no disk, but its size says it is too big to read
    const big = join(d, "src", "generated.ts");
    const fd = openSync(big, "w");
    ftruncateSync(fd, 64 * 1024 * 1024);
    closeSync(fd);
    try {
      const { source, reads } = counting(dirSource(d));
      const plan = planBatches(source, { room: 10_000 });
      expect(plan.batches.flat().map((x) => x.path)).toEqual(["src/a.ts"]);
      const r = await verifyFacts({ facts: [], source, commit: "0123abc" });
      expect(r.coverage.unknown).toEqual(["src/a.ts"]);
      expect(reads.filter((p) => p !== "src/a.ts")).toEqual([]);
    } finally {
      rmSync(big, { force: true });
    }
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
