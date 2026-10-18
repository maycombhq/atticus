import { readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { Dialect, RECORD_KINDS, rulesJsonSchemas, TEMPLATE_FILTERS } from "@maycombhq/core";
import { runDialectTests } from "@maycombhq/extractors";
import { exportKit, KIT_COMMANDS, KIT_DIR } from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE_DIALECT = join(HERE, "../../../fixtures/forge/metarepo/org-pack/dialects/forge.yaml");
const EVAL = join(HERE, "../../../fixtures/forge-dialect-eval");

async function walk(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...(await walk(join(dir, e.name), `${prefix}${e.name}/`)));
    else out.push(`${prefix}${e.name}`);
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

const doc = (name: string) => readFileSync(join(KIT_DIR, name), "utf8");
const allDocs = async () =>
  Promise.all(
    (await walk(KIT_DIR)).map(async (f) => ({ f, text: await readFile(join(KIT_DIR, f), "utf8") })),
  );

/** Fenced ```yaml blocks in a Markdown file. */
const yamlBlocks = (md: string) => [...md.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]!);

describe("exportKit", () => {
  it("writes the kit, the generated C2 JSON Schema, the record kinds and the command reference", async () => {
    const out = await mkdtemp(join(tmpdir(), "atticus-kit-"));
    const written = await exportKit(out);
    expect(written).toEqual([
      "README.md",
      "c1-kinds.md",
      "c2-reference.md",
      "checklist.md",
      "cli.md",
      "dialect.schema.json",
      "prompts/write-dialect.md",
      "worked-example.md",
    ]);
    expect(await walk(out)).toEqual(written);
    expect(JSON.parse(await readFile(join(out, "dialect.schema.json"), "utf8"))).toEqual(
      rulesJsonSchemas().Dialect,
    );
    expect(await readFile(join(out, "README.md"), "utf8")).toBe(doc("README.md"));

    const cli = await readFile(join(out, "cli.md"), "utf8");
    for (const c of KIT_COMMANDS) expect(cli).toContain(c.usage);
    expect(cli).toContain("atticus dialect new <name> --from <repo>...");
    expect(cli).not.toContain("grade");

    const kinds = await readFile(join(out, "c1-kinds.md"), "utf8");
    for (const k of RECORD_KINDS.filter((k) => k !== "CuratedDecision"))
      expect(kinds).toContain(`## ${k}\n`);
    expect(kinds).toContain(
      "| `endpointType` | yes | one of `rest`, `grpc`, `soap`, `event-topic`, `file-drop`, `mq-queue`, `batch-job` |",
    );
    expect(kinds).not.toContain("CuratedDecision");
  });

  it("leaves other files in the folder alone and overwrites its own", async () => {
    const out = await mkdtemp(join(tmpdir(), "atticus-kit-"));
    await exportKit(out);
    const again = await exportKit(out);
    expect(again).toHaveLength(8);
  });
});

describe("the kit's content", () => {
  it("documents every match kind, template value and filter the engine has", () => {
    const ref = doc("c2-reference.md");
    for (const m of [
      "annotation",
      "baseClass",
      "methodCall",
      "configKey",
      "xpath",
      "jsonPath",
      "regex",
    ])
      expect(ref).toContain(`\`${m}\``);
    for (const t of [
      "${attr.",
      "${annotation.",
      "${config:",
      "${yaml:",
      "${member.name}",
      "${class.name}",
      "${file.path}",
      "${file.line}",
      "${repo.name}",
      "${match.",
    ])
      expect(ref).toContain(t);
    for (const f of TEMPLATE_FILTERS) expect(ref).toContain(`\`${f}`);
  });

  it("shows the Forge dialect exactly as the fixture org pack has it", () => {
    const blocks = yamlBlocks(doc("worked-example.md")).map((b) => parse(b) as unknown);
    expect(blocks).toContainEqual(parse(readFileSync(FORGE_DIALECT, "utf8")));
  });

  it("has only valid C2 in its complete dialect examples, and their inline tests pass", async () => {
    let checked = 0;
    for (const name of [
      "README.md",
      "c2-reference.md",
      "worked-example.md",
      "prompts/write-dialect.md",
    ]) {
      for (const b of yamlBlocks(doc(name)).filter((x) => x.startsWith("schemaVersion: 1"))) {
        const r = Dialect.safeParse(parse(b));
        expect(r.success, `${name}: ${r.error?.message}`).toBe(true);
        if (r.success && r.data.tests.every((t) => t.files)) {
          expect(await runDialectTests(r.data, KIT_DIR), name).toEqual([]);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("does not reveal the eval task's framework or its answers", async () => {
    const names = [
      "messaging",
      "RelayClient",
      "RelayCall",
      "QueueConsumer",
      "OnMessage",
      "Emits",
      "order-intake",
      "inventory",
      "notify-worker",
      "billing",
    ];
    const ids = (
      parse(readFileSync(join(EVAL, "expected.yaml"), "utf8")) as {
        repos: { records: { id: string }[] }[];
      }
    ).repos.flatMap((r) => r.records.map((x) => x.id));
    for (const { f, text } of await allDocs()) {
      for (const n of [...names, ...ids]) expect(text, `${f} mentions ${n}`).not.toContain(n);
    }
  });
});
