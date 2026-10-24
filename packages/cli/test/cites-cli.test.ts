import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { Api, parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { main } from "../src/main.js";
import { fileInRepo } from "../src/ui-api-cites.js";

/**
 * atticus cites (WP7.3 for IntelliJ): what cites each line of one file, the same as GET /api/cites,
 * for an editor that can't call the app. A file is named by repo and path, or by where it is in
 * the metarepo's workspace.
 */

const ESTATE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/estate");
const PATH = "src/main/java/forge/customers/CustomerController.java";
let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-cites-cli-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  for (const r of parse(await readFile(join(ESTATE, "catalog.yaml"), "utf8")) as unknown[]) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(JSON.stringify(p.issues));
    const file = join(root, "catalog", "generated", recordPath(p.record));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, serializeRecord(p.record));
  }
  await cp(join(ESTATE, "specs"), join(root, "specs"), { recursive: true });
});

const run = async (args: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(args, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
};

describe("atticus cites", () => {
  it("finds a file's repo and path from where it is in the workspace", () => {
    expect(
      fileInRepo(root, join(root, "workspace", "forge-customers", ...PATH.split("/"))),
    ).toEqual({ repo: "forge-customers", path: PATH });
    expect(
      fileInRepo(
        root,
        join(root, "workspace", ".worktrees", "add-limit", "forge-web", "src", "a.ts"),
      ),
    ).toEqual({ repo: "forge-web", path: "src/a.ts" });
    expect(
      fileInRepo(root, join(root, "workspace", ".branches", "forge-web", "develop", "src", "a.ts")),
    ).toEqual({ repo: "forge-web", path: "src/a.ts" });
    // Elsewhere in the metarepo (an adopted repo's own files): the path, the repo to be found.
    expect(fileInRepo(root, join(root, "src", "a.ts"))).toEqual({ path: "src/a.ts" });
    expect(fileInRepo(root, join(tmpdir(), "elsewhere.ts"))).toBeUndefined();
  });

  it("gives each cited line with its flows and records, by repo and path or by file", async () => {
    const r = await run([
      "cites",
      "--repo",
      "forge-customers",
      "--path",
      PATH,
      "--json",
      "--root",
      root,
    ]);
    expect(r.code).toBe(0);
    const v = Api.CiteList.parse(JSON.parse(r.out));
    expect(v.lines.find((l) => l.line === 10)?.flows[0]).toMatchObject({
      flow: "forge-customers.create-customer",
      step: 0,
    });
    const byFile = await run([
      "cites",
      "--file",
      join(root, "workspace", "forge-customers", ...PATH.split("/")),
      "--json",
      "--root",
      root,
    ]);
    expect(JSON.parse(byFile.out)).toEqual(JSON.parse(r.out));
    const text = await run(["cites", "--repo", "forge-customers", "--path", PATH, "--root", root]);
    expect(text.out).toMatch(/^Line 10: .*A client creates a customer/m);
  });

  it("says when nothing cites the file, and asks for a file", async () => {
    const none = await run(["cites", "--repo", "forge-web", "--path", "src/x.ts", "--root", root]);
    expect(none.code).toBe(0);
    expect(none.out).toMatch(/Nothing in the specs or the catalog cites/);
    expect((await run(["cites", "--root", root])).code).toBe(2);
    expect((await run(["cites", "--file", join(tmpdir(), "x.ts"), "--root", root])).code).toBe(1);
  });
});
