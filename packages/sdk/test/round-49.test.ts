import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  fsRepo,
  memoryScanCache,
  scanRepo,
  type Extractor,
  type RepoHandle,
} from "../src/index.js";

/**
 * Review round 49 (scan pipeline): the scan lists what git would (no link, nothing a .gitignore
 * ignores), decodes every file one way, and keys its stored results by how the repo was listed.
 */

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "atticus-sdk-r49-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const SHA = "a".repeat(40);

/** An extractor that says which files it was listed, as warnings. */
const lister: Extractor = {
  id: "lister",
  version: "1.0.0",
  claims: ["**/*.txt"],
  // eslint-disable-next-line require-yield -- it only says which files it was listed
  async *scan(repo, ctx) {
    for await (const f of repo.listFiles(["**/*.txt"])) ctx.warn("saw", f);
  },
};

async function seen(repo: RepoHandle, cache = memoryScanCache()) {
  const r = await scanRepo({
    repo,
    extractors: [lister],
    cache,
    scannedAt: "2026-01-01T00:00:00Z",
  });
  return { paths: r.warnings.map((w) => w.path), status: r.runs[0]!.status };
}

describe("fsRepo lists what git would", () => {
  it("leaves out what a .gitignore ignores, and every link", async () => {
    const d = temp();
    mkdirSync(join(d, "src"));
    mkdirSync(join(d, "generated"));
    writeFileSync(join(d, "src", "a.txt"), "a");
    writeFileSync(join(d, "generated", "b.txt"), "b");
    writeFileSync(join(d, ".gitignore"), "generated/\n");
    link("../src", join(d, "src", "again"));
    link("a.txt", join(d, "src", "copy.txt"));
    expect((await seen(fsRepo("r", d, SHA))).paths).toEqual(["src/a.txt"]);
  });
});

describe("fsRepo decodes what it reads", () => {
  it("reads UTF-16 with a byte-order mark and Latin-1 as text", async () => {
    const d = temp();
    writeFileSync(
      join(d, "orders.sql"),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("CREATE TABLE orders (\n", "utf16le")]),
    );
    writeFileSync(join(d, "Legacy.java"), Buffer.from([0x43, 0x61, 0x66, 0xe9, 0x0a]));
    const repo = fsRepo("r", d, SHA);
    expect(await repo.readText("orders.sql")).toBe("CREATE TABLE orders (\n");
    expect(await repo.readText("Legacy.java")).toBe("Café\n");
  });
});

describe("the stored scan is keyed by how the repo was listed", () => {
  it("is scanned again when the folders left out or the size limit change", async () => {
    const d = temp();
    mkdirSync(join(d, "src"));
    mkdirSync(join(d, "gen"));
    writeFileSync(join(d, "src", "a.txt"), "x");
    writeFileSync(join(d, "gen", "b.txt"), "yy");
    const cache = memoryScanCache();
    expect(await seen(fsRepo("r", d, SHA), cache)).toEqual({
      paths: ["gen/b.txt", "src/a.txt"],
      status: "ran",
    });
    expect((await seen(fsRepo("r", d, SHA), cache)).status).toBe("cached");
    expect(await seen(fsRepo("r", d, SHA, { ignore: ["gen"] }), cache)).toEqual({
      paths: ["src/a.txt"],
      status: "ran",
    });
    expect(await seen(fsRepo("r", d, SHA, { maxFileBytes: 1 }), cache)).toMatchObject({
      status: "ran",
    });
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
