import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

/** Every path the code tools read whole, to show a file is passed over before it is read. */
const reads: string[] = [];
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    readFile: (async (p: unknown, ...rest: unknown[]) => {
      reads.push(String(p));
      return (fs.readFile as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.readFile,
  };
});

const { contextToolBox } = await import("../src/index.js");

/**
 * Review round 49 (scan pipeline): the assistant's code tools decode a file as the verifier and
 * the scan do (UTF-16 with its mark, Latin-1), and pass a binary or too big a file over by its
 * name and size before reading it.
 */

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function clone() {
  const d = mkdtempSync(join(tmpdir(), "atticus-index-r49-"));
  dirs.push(d);
  mkdirSync(join(d, "db"));
  mkdirSync(join(d, "src"));
  writeFileSync(
    join(d, "db", "orders.sql"),
    Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("-- orders\r\nCREATE TABLE orders (\r\n  id int\r\n);\r\n", "utf16le"),
    ]),
  );
  writeFileSync(
    join(d, "src", "Legacy.java"),
    Buffer.from([...Buffer.from("public class Caf"), 0xe9, ...Buffer.from("Controller {}\n")]),
  );
  writeFileSync(
    join(d, "README.md"),
    Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("# Forge orders\n\n## Tables\n", "utf16le"),
    ]),
  );
  writeFileSync(join(d, "src", "logo.png"), Buffer.from("orders"));
  link("/etc/hostname", join(d, "src", "host.txt"));
  return d;
}

const boxOf = (dir: string) =>
  contextToolBox(
    "/nonexistent",
    async () => {
      throw new Error("no index");
    },
    { codeDir: () => dir, repos: () => ["forge-orders"] },
  );

describe("the code tools decode as every reader does", () => {
  it("grep finds a word in a UTF-16 .sql and in a Latin-1 .java", async () => {
    const box = boxOf(clone());
    const sql = await box.call("grep", { pattern: "CREATE TABLE orders", repo: "forge-orders" });
    expect(sql).toContain("forge-orders:db/orders.sql:2: CREATE TABLE orders (");
    const java = await box.call("grep", { pattern: "CaféController", repo: "forge-orders" });
    expect(java).toContain("forge-orders:src/Legacy.java:1: public class CaféController {}");
  });

  it("outline reads a UTF-16 Markdown file's headings", async () => {
    const box = boxOf(clone());
    const o = await box.call("outline", { repo: "forge-orders", path: "README.md" });
    expect(o).toContain("1: # Forge orders");
    expect(o).toContain("3: ## Tables");
  });
});

describe("the code tools judge a file by its name and size first", () => {
  it("never reads a binary by its extension, or a file over the size a code file may be", async () => {
    const dir = clone();
    // a sparse 64 MB file: no disk, but its size says it is too big to read
    const big = join(dir, "src", "generated.ts");
    const fd = openSync(big, "w");
    ftruncateSync(fd, 64 * 1024 * 1024);
    closeSync(fd);
    try {
      reads.length = 0;
      const out = await boxOf(dir).call("grep", { pattern: "orders", repo: "forge-orders" });
      expect(out).not.toContain("logo.png");
      expect(reads.filter((p) => p.endsWith("logo.png") || p.endsWith("generated.ts"))).toEqual([]);
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
