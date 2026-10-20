import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  dialectGrade,
  dialectKit,
  dialectNew,
  dialectRun,
  dialectTest,
} from "../src/dialect-commands.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "../../../fixtures");
const FORGE = join(FIXTURES, "forge");
const EVAL = join(FIXTURES, "forge-dialect-eval");
const REFERENCE = join(HERE, "../../assistant-kit/test/reference/forge-messaging.yaml");

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

async function tempRoot(dialects: Record<string, unknown> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-cli-dialect-"));
  await mkdir(join(root, "org-pack/dialects"), { recursive: true });
  for (const [name, d] of Object.entries(dialects))
    await writeFile(
      join(root, "org-pack/dialects", `${name}.yaml`),
      typeof d === "string" ? d : stringify(d),
    );
  return root;
}

const queueDialect = (tests: unknown[]) => ({
  schemaVersion: 1,
  name: "house",
  version: "1.0.0",
  appliesTo: { marker: "house.yaml" },
  rules: [
    {
      id: "queue",
      description: "A @Queue method consumes a queue.",
      match: { annotation: "Queue", target: "method", files: ["**/*.java"] },
      emit: {
        kind: "Endpoint",
        id: "${yaml:house.yaml#app}.queue.${attr.name | lower}",
        fields: {
          component: "${yaml:house.yaml#app}",
          endpointType: "mq-queue",
          pathOrTopic: "${attr.name}",
        },
      },
      confidence: "verified",
    },
  ],
  tests,
});

const HOUSE_FILES = {
  "house.yaml": "app: demo\n",
  "src/A.java": 'class A {\n  @Queue(name = "IN.Q")\n  void a() {}\n}\n',
};

describe("atticus dialect new", () => {
  it("writes a scaffold from the surveyed repos and never overwrites it", async () => {
    const root = await tempRoot();
    const c = capture();
    expect(await dialectNew(root, "forge-house", [join(FORGE, "repos/forge-ledger")], c.io)).toBe(
      0,
    );
    const text = await readFile(join(root, "org-pack/dialects/forge-house.yaml"), "utf8");
    expect(text).toBe(
      readFileSync(join(HERE, "../../assistant-kit/test/golden/forge-ledger.yaml.golden"), "utf8"),
    );
    expect(c.out).toEqual([
      "Wrote org-pack/dialects/forge-house.yaml from 1 repo: marker forge.yaml, 6 framework annotations, 4 candidate rules, 1 config key.",
      "Next: finish the rules and write tests, then run atticus dialect test forge-house.",
    ]);

    const again = capture();
    expect(
      await dialectNew(root, "forge-house", [join(FORGE, "repos/forge-ledger")], again.io),
    ).toBe(1);
    expect(again.err).toEqual([
      "org-pack/dialects/forge-house.yaml already exists; it was left as it is. Choose another name or edit that file.",
    ]);
    expect(await readFile(join(root, "org-pack/dialects/forge-house.yaml"), "utf8")).toBe(text);
  });

  it("exits 2 for a bad name, no repos or a missing folder", async () => {
    const root = await tempRoot();
    const c = capture();
    expect(await dialectNew(root, "Forge House", [join(FORGE, "repos/forge-ledger")], c.io)).toBe(
      2,
    );
    expect(await dialectNew(root, "house", [], c.io)).toBe(2);
    expect(await dialectNew(root, "house", [join(root, "nope")], c.io)).toBe(2);
    expect(c.err).toEqual([
      'A dialect name is a lowercase slug (a-z, 0-9, ".", "_" and "-"), for example: forge-messaging',
      "dialect new needs at least one repo folder, for example: atticus dialect new house --from repos/a repos/b",
      `${join(root, "nope")} is not a folder.`,
    ]);
    expect(await readdir(join(root, "org-pack/dialects"))).toEqual([]);
  });
});

describe("atticus dialect test", () => {
  it("passes the Forge dialect in the fixture org pack", async () => {
    const c = capture();
    expect(await dialectTest(join(FORGE, "metarepo"), "forge", c.io)).toBe(0);
    expect(c.out).toEqual([
      "Testing dialect forge 0.1.0: 4 rules, 2 tests",
      "  pass  endpoints and the direct vendor call in forge-ledger",
      "  pass  a service with no forge.yaml produces nothing",
      "2 tests passed.",
    ]);
  });

  it("prints each failure under its test and exits 1", async () => {
    const root = await tempRoot({
      house: queueDialect([
        {
          name: "the queue",
          files: HOUSE_FILES,
          expect: [{ kind: "Endpoint", id: "demo.queue.in.q", pathOrTopic: "in.q" }],
        },
        { name: "no marker, no records", files: { "src/A.java": HOUSE_FILES["src/A.java"] } },
      ]),
    });
    const c = capture();
    expect(await dialectTest(root, "house", c.io)).toBe(1);
    expect(c.out).toEqual([
      "Testing dialect house 1.0.0: 1 rule, 2 tests",
      "  FAIL  the queue",
      '          demo.queue.in.q.pathOrTopic: expected "in.q", got "IN.Q"',
      "  pass  no marker, no records",
      "1 of 2 tests failed. To see what the rules produce from a repo: atticus dialect run house <repo>",
    ]);
  });

  it("lists every schema problem when the file isn't valid C2", async () => {
    const d = queueDialect([]);
    (d.rules[0]!.emit.fields as Record<string, string>).owner = "x";
    const root = await tempRoot({ house: d });
    const c = capture();
    expect(await dialectTest(root, "house", c.io)).toBe(1);
    expect(c.err).toEqual([
      "org-pack/dialects/house.yaml is not a valid dialect (contract C2):",
      "  rules.0.emit.fields.owner: Endpoint has no field owner in contract C1",
      "  tests: every dialect ships at least one test",
    ]);
  });

  it("says when there is no such dialect, or the YAML is broken", async () => {
    const root = await tempRoot({ broken: "name: [unclosed\n" });
    const c = capture();
    expect(await dialectTest(root, "missing", c.io)).toBe(1);
    expect(await dialectTest(root, "broken", c.io)).toBe(1);
    expect(c.err[0]).toBe(
      "No dialect file org-pack/dialects/missing.yaml. Create one with: atticus dialect new missing --from <repo>...",
    );
    expect(c.err[1]).toMatch(/^org-pack\/dialects\/broken\.yaml is not valid YAML: /);
  });

  it("refuses a file whose name field differs from its file name", async () => {
    const root = await tempRoot({ other: queueDialect([{ name: "t", files: HOUSE_FILES }]) });
    const c = capture();
    expect(await dialectTest(root, "other", c.io)).toBe(1);
    expect(c.err).toEqual([
      "org-pack/dialects/other.yaml is not a valid dialect (contract C2):",
      "  name: the file is other.yaml, so name must be other (it says house)",
    ]);
  });
});

describe("atticus dialect run", () => {
  it("prints the records a dialect emits from one repo, ready to paste into a test", async () => {
    const root = await tempRoot({ house: queueDialect([]) });
    const repo = join(root, "demo-repo");
    for (const [p, text] of Object.entries(HOUSE_FILES)) {
      await mkdir(dirname(join(repo, p)), { recursive: true });
      await writeFile(join(repo, p), text);
    }
    const c = capture();
    expect(await dialectRun(root, "house", repo, {}, c.io)).toBe(0);
    expect(c.out).toEqual([
      "- kind: Endpoint",
      "  id: demo.queue.in.q",
      "  confidence: verified",
      "  component: demo",
      "  endpointType: mq-queue",
      "  pathOrTopic: IN.Q",
      "  # from src/A.java:2 (rule queue)",
      "1 record from demo-repo. This dialect has no tests yet; atticus dialect test fails until it has one.",
    ]);

    const j = capture();
    expect(await dialectRun(root, "house", repo, { json: true }, j.io)).toBe(0);
    const res = JSON.parse(j.out.join("\n")) as { records: { id: string; evidence: unknown[] }[] };
    expect(res.records.map((r) => r.id)).toEqual(["demo.queue.in.q"]);
    expect(res.records[0]!.evidence[0]).toMatchObject({
      path: "src/A.java",
      line: 2,
      dialect: "house@1.0.0",
    });
  });

  it("says when the marker file is missing, and shows templates that could not be filled", async () => {
    const d = queueDialect([{ name: "t", files: HOUSE_FILES }]);
    d.rules[0]!.emit.id = "${yaml:house.yaml#app}.queue.${attr.queue}";
    const root = await tempRoot({ house: d });
    const repo = join(root, "r");
    await mkdir(join(repo, "src"), { recursive: true });
    await writeFile(join(repo, "src/A.java"), HOUSE_FILES["src/A.java"]);
    const none = capture();
    expect(await dialectRun(root, "house", repo, {}, none.io)).toBe(0);
    expect(none.out).toEqual([
      "The marker house.yaml is not in r, so the dialect does not apply there. 0 records.",
    ]);

    await writeFile(join(repo, "house.yaml"), "app: demo\n");
    const warn = capture();
    expect(await dialectRun(root, "house", repo, {}, warn.io)).toBe(0);
    expect(warn.out).toEqual([
      "warning: rule queue: the id template could not be filled (src/A.java)",
      "0 records from r.",
    ]);
  });

  it("exits 1 and shows why when a rule produces records that fail C1", async () => {
    const d = queueDialect([{ name: "t", files: HOUSE_FILES }]);
    d.rules[0]!.emit.id = "${yaml:house.yaml#app}.queue.${attr.name}";
    const root = await tempRoot({ house: d });
    const c = capture();
    const repo = join(root, "r");
    await mkdir(join(repo, "src"), { recursive: true });
    await writeFile(join(repo, "src/A.java"), HOUSE_FILES["src/A.java"]);
    await writeFile(join(repo, "house.yaml"), "app: demo\n");
    expect(await dialectRun(root, "house", repo, {}, c.io)).toBe(1);
    expect(c.out).toEqual([
      "invalid: Endpoint demo.queue.IN.Q from src/A.java:2: id: ids are lowercase slugs: a-z, 0-9, '.', '_' and '-'",
      "0 records from r.",
    ]);
  });
});

describe("atticus dialect kit and grade", () => {
  it("exports the kit to a folder", async () => {
    const out = await mkdtemp(join(tmpdir(), "atticus-cli-kit-"));
    const c = capture();
    expect(await dialectKit(out, c.io)).toBe(0);
    expect(c.out).toEqual([`Wrote the dialect build kit (12 files) to ${out}`]);
    expect(await readdir(out)).toContain("cli.md");
  });

  it("grades a dialect against the eval and exits 1 when it fails", async () => {
    const ok = capture();
    expect(await dialectGrade(REFERENCE, EVAL, ok.io)).toBe(0);
    expect(ok.out.at(-1)).toBe("PASS: 21 of 21 expected records, precision 1.00, recall 1.00");

    const broken = parse(readFileSync(REFERENCE, "utf8")) as { tests: unknown[] };
    broken.tests = [];
    const root = await tempRoot({ "forge-messaging": broken });
    const bad = capture();
    expect(
      await dialectGrade(join(root, "org-pack/dialects/forge-messaging.yaml"), EVAL, bad.io),
    ).toBe(1);
    expect(bad.out.at(-1)).toMatch(/^FAIL: /);
  });
});

describe("atticus dialect tree (ADR 0060)", () => {
  it("prints a file's syntax tree, and refuses a file no grammar reads", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { dialectTree } = await import("../src/dialect-commands.js");
    const dir = await mkdtemp(join(tmpdir(), "atticus-tree-"));
    await writeFile(join(dir, "A.kt"), 'fun f() = http.exchange(S.A, "POST", "/a")');
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
    expect(await dialectTree(join(dir, "A.kt"), {}, io)).toBe(0);
    expect(out[0]).toMatch(/^\(source_file \(function_declaration .*\(call_expression/);
    await writeFile(join(dir, "notes.txt"), "x");
    expect(await dialectTree(join(dir, "notes.txt"), {}, io)).toBe(2);
    expect(err[0]).toMatch(/^No grammar for .*notes\.txt\. Grammars: java, kotlin/);
  });
});
