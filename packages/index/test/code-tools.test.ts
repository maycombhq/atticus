import { cp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTEXT_TOOL_BOUNDS,
  CONTEXT_TOOLS,
  contextToolBox,
  openIndex,
  runContextTool,
  type CatalogIndex,
  type ContextToolOptions,
} from "../src/index.js";
import { contextRoot, FIX } from "./helpers.js";

// ADR 0118: the model searches the code. grep, files and outline read the base clones under
// workspace/ only, skip what .gitignore ignores, and a hit is a pointer show_code may then show.

const APP = "src/main/java/forge/vault/VaultApplication.java";
const CONTROLLER = "src/main/java/forge/vault/web/SecretController.java";

/** The context metarepo with forge-vault cloned, and files its .gitignore files ignore. */
async function vaultRoot(): Promise<string> {
  const root = await contextRoot();
  const clone = join(root, "workspace/forge-vault");
  await cp(join(FIX, "code-search/repos/forge-vault"), clone, { recursive: true });
  await mkdir(join(clone, "generated"), { recursive: true });
  await writeFile(join(clone, "generated/Stub.java"), '@ForgeServiceBase("/stub")\n');
  await writeFile(join(clone, "debug.log"), "@ForgeServiceBase in a log\n");
  await writeFile(join(clone, "keep.log"), "@ForgeServiceBase kept\n");
  await writeFile(join(clone, "tools/scratch.ts"), "// @ForgeServiceBase scratch\n");
  await writeFile(join(clone, "blob.bin"), Buffer.from("\u0000\u0001@ForgeServiceBase\u0000"));
  await mkdir(join(clone, ".git"), { recursive: true });
  await writeFile(join(clone, ".git/config"), "@ForgeServiceBase in git\n");
  return root;
}

const call = (
  ix: CatalogIndex,
  root: string,
  name: string,
  input: Record<string, unknown>,
  o: ContextToolOptions = {},
) => runContextTool(ix, root, name, input, o);

/** A stand-in for the syntax-tree outline the CLI passes in (packages/extractors). */
const outline: ContextToolOptions["outline"] = async (path) =>
  path.endsWith(".java")
    ? [
        {
          line: 8,
          depth: 0,
          kind: "class",
          name: "VaultApplication",
          marks: [
            { line: 6, text: "@SpringBootApplication" },
            { line: 7, text: '@ForgeServiceBase("/vault-api")' },
          ],
        },
        { line: 9, depth: 1, kind: "method", name: "main", marks: [] },
      ]
    : undefined;

describe("the code tools (ADR 0118)", () => {
  it("are defined beside the others, each with a JSON schema", () => {
    expect(CONTEXT_TOOLS.map((t) => t.name)).toEqual([
      "search",
      "show",
      "walk",
      "show_code",
      "grep",
      "files",
      "outline",
      "similar",
    ]);
    for (const t of CONTEXT_TOOLS.slice(4)) expect(t.inputSchema.type).toBe("object");
  });

  it("grep finds what the model asks for, each hit repo:path:line, skipping ignored, binary and .git files", async () => {
    const root = await vaultRoot();
    const ix = await openIndex(root);
    const out = await call(ix, root, "grep", { pattern: "@ForgeServiceBase", repo: "forge-vault" });
    const hits = out.split("\n").filter((l) => l.startsWith("forge-vault:"));
    expect(hits).toEqual([
      "forge-vault:keep.log:1: @ForgeServiceBase kept",
      `forge-vault:${APP}:7: @ForgeServiceBase("/vault-api")`,
    ]);
    expect(out).toMatch(/^2 hits for "@ForgeServiceBase"/);
    expect(out).toMatch(/A hit is a pointer, not a fact/);
    // Every clone in the workspace when no repo is named.
    expect(await call(ix, root, "grep", { pattern: "@ForgeServiceBase" })).toContain(
      `forge-vault:${APP}:7:`,
    );
    ix.close();
  });

  it("grep takes a regular expression, a case-insensitive search and a glob of paths", async () => {
    const root = await vaultRoot();
    const ix = await openIndex(root);
    const re = await call(ix, root, "grep", {
      pattern: "@(Get|Vault)\\w*\\(",
      regex: true,
      paths: "src/**/*.java",
    });
    expect(re.split("\n").filter((l) => l.startsWith("forge-vault:"))).toEqual([
      `forge-vault:${CONTROLLER}:10:   @GetMapping("/secrets")`,
      `forge-vault:${CONTROLLER}:15:   @VaultRoute(path = "/rotate", verb = "POST")`,
    ]);
    const ci = await call(ix, root, "grep", {
      pattern: "forge vault",
      ignoreCase: true,
      paths: "*.md",
    });
    expect(ci).toContain("forge-vault:README.md:1: # Forge Vault");
    expect(await call(ix, root, "grep", { pattern: "zzqq-nothing" })).toMatch(/^No line matches/);
    await expect(call(ix, root, "grep", { pattern: "(", regex: true })).rejects.toThrow(
      /isn't a regular expression/,
    );
    await expect(call(ix, root, "grep", {})).rejects.toThrow(/needs a pattern/);
    await expect(call(ix, root, "grep", { pattern: "x".repeat(201) })).rejects.toThrow(
      /at most 200/,
    );
    ix.close();
  });

  it("grep keeps to its caps and says what it cut", async () => {
    const root = await vaultRoot();
    const ix = await openIndex(root);
    const one = await call(ix, root, "grep", { pattern: "return", repo: "forge-vault", limit: 1 });
    expect(one.split("\n").filter((l) => l.startsWith("forge-vault:"))).toHaveLength(1);
    expect(one).toMatch(/more hits past the 1 shown/);
    const long = join(root, "workspace/forge-vault/long.txt");
    await writeFile(long, `needle ${"x".repeat(5000)}\n`);
    const cut = await call(ix, root, "grep", { pattern: "needle", repo: "forge-vault" });
    const line = cut.split("\n").find((l) => l.startsWith("forge-vault:long.txt:1: "))!;
    expect(line.length).toBeLessThan(260);
    expect(CONTEXT_TOOL_BOUNDS.grepLimit).toBe(100);
    ix.close();
  });

  it("files lists what a glob matches, ignored files left out", async () => {
    const root = await vaultRoot();
    const ix = await openIndex(root);
    const out = await call(ix, root, "files", { glob: "**/*.java", repo: "forge-vault" });
    expect(out.split("\n").filter((l) => l.startsWith("forge-vault:"))).toEqual([
      `forge-vault:${APP}`,
      `forge-vault:${CONTROLLER}`,
    ]);
    const ts = await call(ix, root, "files", { glob: "*.ts" });
    expect(ts).toContain("forge-vault:tools/release.ts");
    expect(ts).not.toContain("scratch.ts");
    const capped = await call(ix, root, "files", { glob: "**", repo: "forge-vault", limit: 2 });
    expect(capped.split("\n").filter((l) => l.startsWith("forge-vault:"))).toHaveLength(2);
    expect(capped).toMatch(/more past the 2 shown/);
    await expect(call(ix, root, "files", {})).rejects.toThrow(/needs a glob/);
    ix.close();
  });

  it("outline gives a file's declarations from the reader passed in, else its headings or keys", async () => {
    const root = await vaultRoot();
    const ix = await openIndex(root);
    const java = await call(ix, root, "outline", { repo: "forge-vault", path: APP }, { outline });
    expect(java.split("\n")).toEqual([
      `Outline of forge-vault:${APP}`,
      "From its syntax tree: each line is the line number, then what is declared there.",
      "6: @SpringBootApplication",
      '7: @ForgeServiceBase("/vault-api")',
      "8: class VaultApplication",
      "9:   method main",
    ]);
    const md = await call(ix, root, "outline", { repo: "forge-vault", path: "README.md" });
    expect(md).toMatch(/From its headings/);
    expect(md).toContain("1: # Forge Vault");
    expect(md).toContain("9: ## Routes");
    const props = await call(ix, root, "outline", {
      repo: "forge-vault",
      path: "src/main/resources/application.properties",
    });
    expect(props).toContain("1: spring.application.name");
    // No reader for Java passed in: no outline, said so.
    expect(await call(ix, root, "outline", { repo: "forge-vault", path: APP })).toMatch(
      /has no outline/,
    );
    ix.close();
  });

  it("refuses a path out of the clone, a repo that isn't cloned and an ignored file", async () => {
    const root = await vaultRoot();
    const ix = await openIndex(root);
    const outside = join(tmpdir(), `atticus-outside-${Date.now()}.md`);
    await writeFile(outside, "# SECRET\n");
    let linked = true;
    try {
      await symlink(outside, join(root, "workspace/forge-vault/leak.md"));
    } catch {
      linked = false; // Windows without the right to make links.
    }
    await expect(
      call(ix, root, "outline", { repo: "forge-vault", path: "../../etc/passwd" }),
    ).rejects.toThrow(/leaves the repo's checkout/);
    await expect(
      call(ix, root, "outline", { repo: "forge-vault", path: "/etc/passwd" }),
    ).rejects.toThrow(/isn't a path inside the repo/);
    await expect(call(ix, root, "grep", { pattern: "x", repo: "forge-nowhere" })).rejects.toThrow(
      /isn't cloned/,
    );
    await expect(call(ix, root, "grep", { pattern: "x", repo: "../etc" })).rejects.toThrow(
      /isn't a repo id/,
    );
    await expect(
      call(ix, root, "outline", { repo: "forge-vault", path: "generated/Stub.java" }),
    ).rejects.toThrow(/\.gitignore/);
    if (linked) {
      await expect(
        call(ix, root, "outline", { repo: "forge-vault", path: "leak.md" }),
      ).rejects.toThrow(/leads outside the repo's checkout/);
      const g = await call(ix, root, "grep", { pattern: "SECRET", repo: "forge-vault" });
      expect(g).toMatch(/^No line matches/);
    }
    ix.close();
  });

  it("show_code shows a line a grep or outline hit of this run returned, and no other", async () => {
    const root = await vaultRoot();
    const box = contextToolBox(root, () => openIndex(root), { outline });
    const at = { repo: "forge-vault", path: APP };
    await expect(box.call("show_code", { ...at, line: 7 })).rejects.toThrow(/No fact cites/);
    await box.call("grep", { pattern: "ForgeServiceBase(", repo: "forge-vault" });
    const shown = await box.call("show_code", { ...at, line: 7, context: 1 });
    expect(shown).toMatch(
      /^A search hit at forge-vault\/src\/main\/java\/forge\/vault\/VaultApplication.java:7:/,
    );
    expect(shown).toMatch(/\n>7 {2}@ForgeServiceBase\("\/vault-api"\)/);
    await expect(box.call("show_code", { ...at, line: 2 })).rejects.toThrow(/No fact cites/);
    await box.call("outline", at);
    expect(await box.call("show_code", { ...at, line: 9, context: 0 })).toMatch(/>9 {2}/);
    // A box made from a run's earlier calls (a call made elsewhere) knows their hits.
    const grep = await box.call("grep", { pattern: "@GetMapping", repo: "forge-vault" });
    const later = contextToolBox(root, () => openIndex(root), {
      calls: [{ name: "grep", output: grep }],
    });
    expect(
      await later.call("show_code", { repo: "forge-vault", path: CONTROLLER, line: 10 }),
    ).toMatch(/GetMapping/);
    await expect(
      later.call("show_code", { repo: "forge-vault", path: CONTROLLER, line: 15 }),
    ).rejects.toThrow(/No fact cites/);
  });
});
