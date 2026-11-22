import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { loadChangeContext } from "@maycombhq/changes";
import {
  architectureStage,
  checkOperations,
  checkPlacement,
  checkStageDraft,
  consumerIssues,
  EXPAND_AGENT,
  featureStage,
  FeaturePlacement,
  FlowDelta,
  loadEstate,
  Operation,
  operationDeployIssues,
  operationRequirements,
  readConformDeltas,
  runsTodaySource,
  OPERATIONS_FILE,
  OperationsFile,
  operationStories,
  readOperations,
  smallStage,
  storiesStage,
  suggestedOperationOrder,
  withOperationStories,
  redactWords,
  type Estate,
} from "../src/index.js";

/**
 * ADR 0203 part B: work that is no runtime step goes through the stages. A move of the two Forge
 * services (and forge-infra, a manifest repo nobody read) to another platform, in two waves, with
 * no flow delta at all: `operations` in feature.yaml, `target-flows/_operations.yaml`, the seven
 * `operation.*` checks, today's Deployment and Setting records as evidence, one story an
 * operation and one task a repo, in wave order. Written before the code; a mock model.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "../../../fixtures");
const NOW = new Date("2026-11-18T09:00:00Z");
const CHANGE = "move-orders-platform";
const REPOS = ["forge-orders", "forge-stock", "forge-infra"];

const MANIFEST = `schemaVersion: 1
platform: forge
repos:
${REPOS.map((id) => `  - id: ${id}\n    url: https://git.example.com/forge/${id}.git\n    type: spring-boot\n    owner: team-orders\n`).join("")}`;

const CHANGE_YAML = (id: string, type = "feature", state = "define") => `schemaVersion: 1
id: ${id}
title: Move the order services to Forge Cloud
type: ${type}
template: ${type}
state: ${state}
createdAt: 2026-11-18T09:00:00Z
createdBy: pat
systems:
  - forge
history:
  - from: draft
    to: ${state}
    at: 2026-11-18T09:00:00Z
    by: pat
    reason: Created from the ${type} template
`;

async function estateRoot(o: { small?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "b30-ops-planner-"));
  await mkdir(join(root, "org-pack/profiles/forge"), { recursive: true });
  await writeFile(join(root, "org-pack/profiles/forge/repos.manifest.yaml"), MANIFEST);
  const rows = [
    "specs/catalog.yaml",
    "stages/catalog-extra.yaml",
    "stages/operations/catalog.yaml",
  ].flatMap((f) => parse(readFileSync(join(FIX, f), "utf8")) as unknown[]);
  for (const r of rows) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(`bad fixture record: ${JSON.stringify(p.issues)}`);
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(join(FIX, "stages/specs"), join(root, "specs"), { recursive: true });
  const dir = join(root, "openspec/changes", CHANGE);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "change.yaml"),
    o.small ? CHANGE_YAML(CHANGE, "small-change", "plan") : CHANGE_YAML(CHANGE),
  );
  await writeFile(
    join(dir, "brief.md"),
    "# Move the order services to Forge Cloud\n\nThe order and stock services and the infra repo move from forge-vm to Forge Cloud as they are, the order service first as the pilot. No entry, call or table changes.\n",
  );
  return root;
}

const estate = async (root: string): Promise<Estate> =>
  loadEstate(root, (await loadChangeContext(root)).records);

function assistant(drafts: string[], seen: string[] = []) {
  let n = 0;
  return new MockRuntime(
    (req: AiRequest) => {
      if (req.agent.id.endsWith("-critic")) return "findings: []";
      if (req.agent.id === EXPAND_AGENT) return "terms: []\nnames: []\n";
      seen.push(req.pack.prompt);
      return drafts[Math.min(n++, drafts.length - 1)]!;
    },
    { now: () => NOW },
  );
}

const FEATURE = `summary: The order services move from forge-vm to Forge Cloud, the order service first.
features: []
flows: []
operations:
  - kind: deployment
    repos: [forge-orders, forge-stock, forge-infra]
    what: Deploy each service on Forge Cloud beside the old one.
    why: The services move as they are.
  - kind: config
    repos: [forge-orders]
    what: Carry the stock timeout over.
    why: The new platform keeps settings in its own file.
  - kind: cut-over
    repos: [forge-orders, forge-stock, forge-infra]
    what: Point the route at the new deployment.
    why: Traffic moves once the new deployment is up.
outside:
  - { id: northwind-freight, what: The carrier's system that calls the order service, why: Its allow-list names the old host. }
`;

const OPERATIONS = `waves:
  - { repos: [forge-orders], why: The pilot. }
  - { repos: [forge-stock, forge-infra] }
operations:
  - id: deploy-new
    kind: deployment
    repos: [forge-orders, forge-stock, forge-infra]
    what: Deploy the service on Forge Cloud beside the old one.
    today: [forge-orders.deployment.prod, forge-stock.deployment.prod]
    sets: { platform: forge-cloud, env: prod }
  - id: stock-timeout
    kind: config
    repos: [forge-orders]
    what: Carry the stock timeout over to the new platform's settings.
    today: [forge-orders.setting.stock-timeout]
    sets: { key: stock.timeout }
    after: [deploy-new]
  - id: switch
    kind: cut-over
    repos: [forge-orders, forge-stock, forge-infra]
    what: Point the gateway route at the new deployment.
    after: [deploy-new]
    undo: Point the route back; the old deployment stays up for one release.
`;
const ARCHITECTURE = `flows: []\n${OPERATIONS}`;

const criteria = (repo: string, what: string) =>
  `      - repo: ${repo}\n        criteria:\n          - "Given ${repo} on forge-vm, when the change is in, then ${what}"\n`;
const STORIES = `stories: []
operations:
  - id: deploy-new
    title: Run each service on Forge Cloud
    asA: platform engineer
    iWant: each service deployed on Forge Cloud beside the old one
    soThat: traffic can move without a gap
    tasks:
${REPOS.map((r) => criteria(r, "a prod deployment on forge-cloud is in its deploy files")).join("")}  - id: stock-timeout
    title: Keep the stock timeout
    asA: platform engineer
    iWant: the stock timeout carried over
    soThat: orders time out as they do today
    tasks:
${criteria("forge-orders", "stock.timeout is set in the new platform's settings")}  - id: switch
    title: Move the traffic
    asA: platform engineer
    iWant: the route pointed at the new deployment
    soThat: customers reach the service on Forge Cloud
    tasks:
${REPOS.map((r) => criteria(r, "the route answers from the new deployment and the old one stays up")).join("")}`;

const ops = (text = OPERATIONS): { operations: Operation[]; waves: OperationsFile["waves"] } => {
  const f = OperationsFile.parse({ schemaVersion: 1, change: CHANGE, ...parse(text) });
  return { operations: f.operations, waves: f.waves };
};
const placement = () =>
  FeaturePlacement.parse({ schemaVersion: 1, change: CHANGE, entry: "brief", ...parse(FEATURE) });
const rules = (text: string, e: Estate) => {
  const o = ops(text);
  return checkOperations(o.operations, o.waves, e, placement()).map(
    (i) => `${i.rule}${i.blocking ? "" : " (note)"}: ${i.message}`,
  );
};

describe("target-flows/_operations.yaml, the planner's schema at version 1", () => {
  it("reads the ADR's example, and refuses a kind it doesn't have, an id twice and an unknown key", () => {
    expect(ops().operations.map((o) => [o.id, o.kind, o.repos.length])).toEqual([
      ["deploy-new", "deployment", 3],
      ["stock-timeout", "config", 1],
      ["switch", "cut-over", 3],
    ]);
    const bad = (text: string) =>
      OperationsFile.safeParse({ schemaVersion: 1, change: CHANGE, ...parse(text) }).success;
    expect(bad(OPERATIONS.replace("kind: config", "kind: rollback"))).toBe(false);
    expect(bad(OPERATIONS.replace("id: stock-timeout", "id: deploy-new"))).toBe(false);
    expect(bad(OPERATIONS.replace("sets: { key: stock.timeout }", "value: 2s"))).toBe(false);
    expect(OPERATIONS_FILE).toBe("target-flows/_operations.yaml");
  });
});

describe("the architecture stage's checks of operations, all blocking", () => {
  it("passes the migration, with nothing to say", async () => {
    expect(rules(OPERATIONS, await estate(await estateRoot()))).toEqual([]);
  });

  it("names each problem by its rule", async () => {
    const e = await estate(await estateRoot());
    expect(
      rules(
        OPERATIONS.replace("repos: [forge-orders]\n    what", "repos: [forge-billing]\n    what"),
        e,
      ),
    ).toEqual([
      "operation.unknown-repo: Operation stock-timeout names repo forge-billing, which the estate doesn't have and this change doesn't plan: name a repo from the index, or mark it newRepo: true in feature.yaml.",
      "operation.unknown-today: Operation stock-timeout cites forge-orders.setting.stock-timeout under today, which is no Component, Deployment, Setting, GatewayRoute or Endpoint record of forge-billing: cite records of the operation's own repos, from the runs-today block, or leave today out.",
      "operation.wave: Repo forge-billing of operation stock-timeout is in no wave: put every repo in exactly one wave, or leave waves out.",
      "operation.missing: The feature lists a config operation in forge-orders (Carry the stock timeout over.) and no operation here is of that kind in that repo: add it, or take it out of feature.yaml.",
    ]);
    expect(
      rules(
        OPERATIONS.replace(
          "today: [forge-orders.setting.stock-timeout]",
          "today: [forge-orders.post-orders, cap-ordering, forge-orders.nothing]",
        ),
        e,
      ),
    ).toEqual([
      "operation.unknown-today: Operation stock-timeout cites cap-ordering under today, which is no Component, Deployment, Setting, GatewayRoute or Endpoint record of forge-orders: cite records of the operation's own repos, from the runs-today block, or leave today out.",
      "operation.unknown-today: Operation stock-timeout cites forge-orders.nothing under today, which is no Component, Deployment, Setting, GatewayRoute or Endpoint record of forge-orders: cite records of the operation's own repos, from the runs-today block, or leave today out.",
    ]);
    expect(rules(OPERATIONS.replace(/ {4}undo: .*\n/, ""), e)).toEqual([
      "operation.no-undo: Operation switch is a cut-over and gives no undo: say under undo how it is taken back, in one or two sentences.",
    ]);
    expect(
      rules(OPERATIONS.replace("after: [deploy-new]\n    undo", "after: [warm-up]\n    undo"), e),
    ).toEqual([
      "operation.after: Operation switch comes after warm-up, which is no operation of this change (deploy-new, stock-timeout, switch).",
    ]);
    expect(
      rules(
        OPERATIONS.replace(
          "sets: { platform: forge-cloud, env: prod }",
          "sets: { platform: forge-cloud, env: prod }\n    after: [switch]",
        ),
        e,
      ),
    ).toEqual([
      "operation.after: Operations deploy-new and switch each come after the other: an operation can't wait for one that waits for it.",
    ]);
    expect(
      rules(
        OPERATIONS.replace(
          "repos: [forge-stock, forge-infra] }",
          "repos: [forge-stock, forge-orders] }",
        ),
        e,
      ),
    ).toEqual([
      "operation.wave: Repo forge-orders is in waves 1 and 2: put every repo in exactly one wave, or leave waves out.",
      "operation.wave: Repo forge-infra of operation deploy-new is in no wave: put every repo in exactly one wave, or leave waves out.",
    ]);
  });

  it("notes a deployment or route operation that cites none of the Deployment records the catalog has", async () => {
    const e = await estate(await estateRoot());
    expect(
      rules(
        OPERATIONS.replace(
          "    today: [forge-orders.deployment.prod, forge-stock.deployment.prod]\n",
          "",
        ),
        e,
      ),
    ).toEqual([
      "operation.today-uncited (note): Operation deploy-new is a deployment and cites nothing under today, and the catalog has Deployment records for its repos: forge-orders.deployment.prod, forge-stock.deployment.prod. Cite the ones it replaces or changes.",
    ]);
  });
});

describe("the deploy order of operations", () => {
  it("with none given, suggests waves first, then after, then file order", () => {
    const o = ops();
    expect(
      suggestedOperationOrder(o.operations, o.waves).map((s) => `${s.operation}@${s.repo}`),
    ).toEqual([
      "deploy-new@forge-orders",
      "stock-timeout@forge-orders",
      "switch@forge-orders",
      "deploy-new@forge-stock",
      "deploy-new@forge-infra",
      "switch@forge-stock",
      "switch@forge-infra",
    ]);
    expect(operationDeployIssues(o.operations, o.waves, undefined)).toEqual([]);
  });

  it("asks for every operation and repo once, after kept, and no step of a wave before the last of the wave before", () => {
    const o = ops();
    const good = suggestedOperationOrder(o.operations, o.waves);
    expect(operationDeployIssues(o.operations, o.waves, good)).toEqual([]);
    const said = (deploy: typeof good) =>
      operationDeployIssues(o.operations, o.waves, deploy).map((i) => `${i.rule}: ${i.message}`);
    expect(said(good.slice(0, -1))).toEqual([
      "delta.deploy-missing: The deploy order leaves out operation switch in forge-infra: add a step { repo: forge-infra, operation: switch }.",
    ]);
    expect(said([good[2]!, good[0]!, good[1]!, ...good.slice(3)])).toEqual([
      "delta.deploy-order: The deploy order puts operation switch in forge-orders (step 1) before deploy-new (step 2), which it comes after: deploy-new goes first.",
    ]);
    expect(said([good[3]!, ...good.slice(0, 3), ...good.slice(4)])).toEqual([
      "delta.deploy-order: The deploy order puts operation deploy-new in forge-stock (step 1), of wave 2, before the last step of wave 1 (step 4): a wave starts once the wave before it is done.",
    ]);
  });
});

describe("the feature stage and a change whose work is operations only", () => {
  it("is done on its first draft: nothing-placed counts operations, and feature.yaml keeps them and the outside party", async () => {
    const root = await estateRoot();
    const seen: string[] = [];
    const r = await featureStage(root, CHANGE, { runtime: assistant([FEATURE], seen), now: NOW });
    expect(r.findings.filter((f) => f.blocking)).toEqual([]);
    expect(r.state).toBe("done");
    expect(r.drafts).toBe(1);
    const file = parse(
      await readFile(join(root, "openspec/changes", CHANGE, "feature.yaml"), "utf8"),
    ) as {
      operations: { kind: string }[];
      outside: { id: string }[];
    };
    expect(file.operations.map((o) => o.kind)).toEqual(["deployment", "config", "cut-over"]);
    expect(file.outside.map((o) => o.id)).toEqual(["northwind-freight"]);
    // What runs today is in the prompt as data, each record with its id; a setting's value is not.
    expect(seen[0]).toContain("runs-today");
    expect(seen[0]).toContain(
      "forge-orders.deployment.prod: Deployment of forge-orders, env prod, platform forge-vm, ingress orders.forge.example/orders",
    );
    expect(seen[0]).toContain(
      "forge-orders.setting.stock-timeout: Setting stock.timeout (timeout)",
    );
    expect(seen[0]).not.toContain("2s");
    expect(seen[0]).toContain("operations:");
    const md = await readFile(join(root, "openspec/changes", CHANGE, "feature.md"), "utf8");
    expect(md).toContain(
      "- Operation (deployment) in forge-orders, forge-stock, forge-infra: Deploy each service on Forge Cloud beside the old one. The services move as they are.",
    );
    expect(md).toContain(
      "- Outside the map: northwind-freight (The carrier's system that calls the order service). Its allow-list names the old host.",
    );
  });

  it("checks an operation's repo as a new flow's, and refuses an outside id the catalog has", async () => {
    const root = await estateRoot();
    const issues = await checkStageDraft(
      root,
      CHANGE,
      "feature",
      FEATURE.replace("repos: [forge-orders]", "repos: [forge-billing]").replace(
        "northwind-freight",
        "northwind-pay",
      ),
    );
    expect(issues.map((i) => [i.rule, i.message])).toEqual([
      [
        "feature.unknown-repo",
        'Operation "Carry the stock timeout over." is put in repo forge-billing, which the estate doesn\'t have.',
      ],
      [
        "feature.outside-exists",
        "northwind-pay is declared outside the map, and the catalog has it (System): take it out of outside and name it where the change uses it.",
      ],
    ]);
    const planned = await checkStageDraft(
      root,
      CHANGE,
      "feature",
      FEATURE.replace("repos: [forge-orders]\n", "repos: [forge-billing]\n    newRepo: true\n"),
    );
    expect(planned).toEqual([]);
  });
});

describe("the architecture stage and operations", () => {
  const staged = async () => {
    const root = await estateRoot();
    await featureStage(root, CHANGE, { runtime: assistant([FEATURE]), now: NOW });
    return root;
  };

  it("is done with no flow delta: writes _operations.yaml and design.md's Operations and rollback rows", async () => {
    const root = await staged();
    const seen: string[] = [];
    const r = await architectureStage(root, CHANGE, {
      runtime: assistant([ARCHITECTURE], seen),
      now: NOW,
    });
    expect(r.findings.filter((f) => f.blocking).map((f) => f.message)).toEqual([]);
    expect(r.state).toBe("done");
    expect(seen[0]).toContain("runs-today");
    const dir = join(root, "openspec/changes", CHANGE);
    const read = await readOperations(dir);
    expect(read.problems).toEqual([]);
    expect(read.file).toMatchObject({ schemaVersion: 1, change: CHANGE });
    expect(read.file!.operations.map((o) => o.id)).toEqual([
      "deploy-new",
      "stock-timeout",
      "switch",
    ]);
    const design = await readFile(join(dir, "design.md"), "utf8");
    expect(design).toContain("## Target flows\n\nNone: the change alters no runtime step.\n");
    expect(design).toContain("## Operations\n");
    expect(design).toContain(
      "3. Operation switch, in forge-orders.\n4. Operation deploy-new, in forge-stock.",
    );
    expect(design).toContain(
      [
        "| Operation | Kind | Repo | Wave | Today | Becomes |",
        "| --- | --- | --- | --- | --- | --- |",
        "| deploy-new | deployment | forge-orders | 1 | forge-orders.deployment.prod: env prod, platform forge-vm (forge-orders:deploy/prod.yaml:3) | Deploy the service on Forge Cloud beside the old one. Sets platform forge-cloud, env prod. |",
        "| deploy-new | deployment | forge-stock | 2 | forge-stock.deployment.prod: env prod, platform forge-vm (forge-stock:deploy/prod.yaml:3) | Deploy the service on Forge Cloud beside the old one. Sets platform forge-cloud, env prod. |",
        "| deploy-new | deployment | forge-infra | 2 | not cited | Deploy the service on Forge Cloud beside the old one. Sets platform forge-cloud, env prod. |",
        "| stock-timeout | config | forge-orders | 1 | forge-orders.setting.stock-timeout: stock.timeout (timeout) (forge-orders:deploy/prod.yaml:11) | Carry the stock timeout over to the new platform's settings. Sets key stock.timeout. |",
      ].join("\n"),
    );
    expect(design).toContain(
      "| Operation switch | cut-over in forge-orders, forge-stock, forge-infra | Point the route back; the old deployment stays up for one release. | Nothing is stored by the operation itself |",
    );
    // A second run with nothing changed reads the stage's files and asks for no draft.
    const again: string[] = [];
    const r2 = await architectureStage(root, CHANGE, {
      runtime: assistant([ARCHITECTURE], again),
      now: NOW,
    });
    expect(r2.state).toBe("done");
    expect(again).toEqual([]);
  });

  it("refuses a cut-over without undo, and an operation the feature lists that is missing", async () => {
    const root = await staged();
    const issues = await checkStageDraft(
      root,
      CHANGE,
      "architecture",
      ARCHITECTURE.replace(/ {4}undo: .*\n/, ""),
    );
    expect(issues.map((i) => i.rule)).toEqual(["operation.no-undo"]);
    const none = await checkStageDraft(root, CHANGE, "architecture", "flows: []\n");
    expect(none.map((i) => i.rule)).toEqual(Array(7).fill("operation.missing"));
  });

  it("a consumer the feature declares outside is a note, with its standing", async () => {
    const root = await staged();
    const e = { ...(await estate(root)), outside: new Set(["northwind-freight"]) };
    const d = FlowDelta.parse({
      schemaVersion: 2,
      flow: "forge-orders.place-order",
      repo: "forge-orders",
      change: "modify",
      why: "The response changes.",
      consumers: ["northwind-freight", "northwind-rail"],
      steps: [{ op: "remove", step: 5 }],
    });
    expect(
      consumerIssues([d], e)
        .filter((i) => i.rule === "delta.unknown-consumer")
        .map((i) => [i.blocking, i.message]),
    ).toEqual([
      [
        false,
        "Flow forge-orders.place-order lists consumer northwind-freight, which is declared outside the map in feature.yaml, so its use can't be checked.",
      ],
      [
        true,
        "Flow forge-orders.place-order lists consumer northwind-rail, which isn't in the catalog. List components from the index.",
      ],
    ]);
  });
});

describe("stories and tasks from operations", () => {
  it("one story an operation, one task a repo, numbered in file order", () => {
    const o = ops();
    expect(
      operationStories(o.operations, o.waves).map((s) => [
        s.id,
        s.tasks.map((t) => `${t.label} ${t.repo} after ${t.after.join(",") || "-"}`),
      ]),
    ).toEqual([
      [
        "o1-deploy-new",
        ["o1.1 forge-orders after -", "o1.2 forge-stock after o3.1", "o1.3 forge-infra after o3.1"],
      ],
      ["o2-stock-timeout", ["o2.1 forge-orders after o1.1"]],
      [
        "o3-switch",
        [
          "o3.1 forge-orders after o1.1",
          "o3.2 forge-stock after o3.1,o1.2",
          "o3.3 forge-infra after o3.1,o1.3",
        ],
      ],
    ]);
  });

  it("adds its rows and lines to what the flows' stories wrote, a person's ticks kept", () => {
    const o = ops();
    const flowTasks =
      "<!-- mark -->\n# Tasks\n\n## forge-orders\n\n- [x] 1.1 Screen the order (story s1-place-order)\n\n## forge-web\n\n- [ ] 2.1 Show the verdict (story s2-show)\n";
    const out = withOperationStories(
      operationStories(o.operations, o.waves),
      undefined,
      {
        index:
          "# Stories\n\n| Story | Title | Repos | Depends on |\n| --- | --- | --- | --- |\n| s1-place-order | Screen | forge-orders |  |\n",
        tasks: flowTasks,
      },
      new Set(["o1.1 Deploy the service on Forge Cloud beside the old one (story o1-deploy-new)"]),
    );
    expect(out.tasks.split("\n").slice(3, 13)).toEqual([
      "## forge-orders",
      "",
      "- [x] 1.1 Screen the order (story s1-place-order)",
      "- [x] o1.1 Deploy the service on Forge Cloud beside the old one (story o1-deploy-new)",
      "- [ ] o2.1 Carry the stock timeout over to the new platform's settings (story o2-stock-timeout) (after o1.1)",
      "- [ ] o3.1 Point the gateway route at the new deployment (story o3-switch) (after o1.1)",
      "",
      "## forge-web",
      "",
      "- [ ] 2.1 Show the verdict (story s2-show)",
    ]);
    expect(out.tasks).toContain("\n\n## forge-stock\n\n- [ ] o1.2 ");
    expect(out.index.split("\n").slice(4, 6)).toEqual([
      "| s1-place-order | Screen | forge-orders |  |",
      "| o1-deploy-new | Deploy the service on Forge Cloud beside the old one | forge-orders, forge-stock, forge-infra |  |",
    ]);
    expect(Object.keys(out.files)).toEqual([
      "stories/o1-deploy-new.md",
      "stories/o2-stock-timeout.md",
      "stories/o3-switch.md",
    ]);
  });

  it("the stories stage runs with operations and no flow delta, and writes the same files", async () => {
    const root = await estateRoot();
    await featureStage(root, CHANGE, { runtime: assistant([FEATURE]), now: NOW });
    await architectureStage(root, CHANGE, { runtime: assistant([ARCHITECTURE]), now: NOW });
    const seen: string[] = [];
    const r = await storiesStage(root, CHANGE, { runtime: assistant([STORIES], seen), now: NOW });
    expect(r.findings.filter((f) => f.blocking).map((f) => f.message)).toEqual([]);
    expect(r.state).toBe("done");
    expect(seen[0]).toContain("story o1-deploy-new: deployment operation deploy-new");
    const dir = join(root, "openspec/changes", CHANGE);
    const tasks = await readFile(join(dir, "tasks.md"), "utf8");
    expect(tasks.split("\n").slice(1)).toEqual([
      "# Tasks",
      "",
      "## forge-orders",
      "",
      "- [ ] o1.1 Deploy the service on Forge Cloud beside the old one (story o1-deploy-new)",
      "- [ ] o2.1 Carry the stock timeout over to the new platform's settings (story o2-stock-timeout) (after o1.1)",
      "- [ ] o3.1 Point the gateway route at the new deployment (story o3-switch) (after o1.1)",
      "",
      "## forge-stock",
      "",
      "- [ ] o1.2 Deploy the service on Forge Cloud beside the old one (story o1-deploy-new) (after o3.1)",
      "- [ ] o3.2 Point the gateway route at the new deployment (story o3-switch) (after o3.1, o1.2)",
      "",
      "## forge-infra",
      "",
      "- [ ] o1.3 Deploy the service on Forge Cloud beside the old one (story o1-deploy-new) (after o3.1)",
      "- [ ] o3.3 Point the gateway route at the new deployment (story o3-switch) (after o3.1, o1.3)",
      "",
    ]);
    const index = await readFile(join(dir, "stories.md"), "utf8");
    expect(index).toContain(
      "| o1-deploy-new | Run each service on Forge Cloud | forge-orders, forge-stock, forge-infra |  |",
    );
    expect(index).toContain(
      "| o3-switch | Move the traffic | forge-orders, forge-stock, forge-infra |  |",
    );
    const story = await readFile(join(dir, "stories/o3-switch.md"), "utf8");
    expect(story).toContain("# Move the traffic");
    expect(story).toContain(
      "As a platform engineer I want the route pointed at the new deployment so that customers reach the service on Forge Cloud.",
    );
    expect(story).toContain(
      "### Task o3.2: Point the gateway route at the new deployment (forge-stock)",
    );
    expect(story).toContain(
      "- Undo: Point the route back; the old deployment stays up for one release.",
    );
    expect(story).toContain(
      "- Given forge-stock on forge-vm, when the change is in, then the route answers from the new deployment and the old one stays up",
    );
    // One capability a repo, a requirement an operation story, a scenario a criterion.
    const spec = await readFile(join(dir, "specs/forge-orders-operations/spec.md"), "utf8");
    expect(spec.match(/^### Requirement: /gm)).toHaveLength(3);
    expect(spec).toContain(`### Requirement: Keep the stock timeout (${CHANGE})\n`);
    expect(spec).not.toContain("## MODIFIED");
    expect(spec).toContain("SHALL");
    expect(spec).toContain("- **THEN** stock.timeout is set in the new platform's settings");
    // Done stays done: a second run asks for no draft.
    const again: string[] = [];
    const r2 = await storiesStage(root, CHANGE, { runtime: assistant([STORIES], again), now: NOW });
    expect(r2.state).toBe("done");
    expect(again).toEqual([]);
  });

  it("holds stories.no-criteria for a repo's task, and asks for every operation's words", async () => {
    const root = await estateRoot();
    await featureStage(root, CHANGE, { runtime: assistant([FEATURE]), now: NOW });
    await architectureStage(root, CHANGE, { runtime: assistant([ARCHITECTURE]), now: NOW });
    const cut = STORIES.slice(0, STORIES.indexOf("  - id: switch")).replace(
      criteria("forge-orders", "stock.timeout is set in the new platform's settings"),
      "      - repo: forge-orders\n        criteria: []\n",
    );
    const issues = await checkStageDraft(root, CHANGE, "stories", cut);
    expect(issues.map((i) => [i.rule, i.message])).toEqual([
      [
        "stories.no-criteria",
        "Task o2.1 (operation stock-timeout in forge-orders) has no acceptance criteria: write at least one a person or a test can check.",
      ],
      [
        "stories.missing-story",
        "Story o3-switch (operation switch) has no wording: write its title, who, what and why, and a task with criteria for each of forge-orders, forge-stock, forge-infra.",
      ],
    ]);
  });
});

describe("the fast path takes operations too", () => {
  it("is done with operations and no target flow, and writes the three stages' files", async () => {
    const root = await estateRoot({ small: true });
    const answer = `summary: The stock timeout moves to the new platform's settings file.
features: []
flows: []
targetFlows: []
stories: []
operations:
  - id: stock-timeout
    kind: config
    repos: [forge-orders]
    what: Carry the stock timeout over to the new platform's settings.
    today: [forge-orders.setting.stock-timeout]
    sets: { key: stock.timeout }
    title: Keep the stock timeout
    asA: platform engineer
    iWant: the stock timeout carried over
    soThat: orders time out as they do today
    tasks:
${criteria("forge-orders", "stock.timeout is set in the new platform's settings")}`;
    const r = await smallStage(root, CHANGE, { runtime: assistant([answer]), now: NOW });
    expect(r.findings.filter((f) => f.blocking).map((f) => f.message)).toEqual([]);
    expect(r.state).toBe("done");
    const dir = join(root, "openspec/changes", CHANGE);
    expect((await readOperations(dir)).file!.operations.map((o) => o.id)).toEqual([
      "stock-timeout",
    ]);
    expect(await readFile(join(dir, "tasks.md"), "utf8")).toContain(
      "- [ ] o1.1 Carry the stock timeout over to the new platform's settings (story o1-stock-timeout)",
    );
    expect(await readFile(join(dir, "design.md"), "utf8")).toContain("## Operations");
  });
});

// ------------------------------------------------------------------ the review of part B

const RING = `waves:
  - { repos: [forge-stock] }
  - { repos: [forge-orders] }
operations:
  - id: northwind-config
    kind: config
    repos: [forge-orders]
    what: Give the order service the carrier's endpoint.
  - id: deploy-new
    kind: deployment
    repos: [forge-stock, forge-orders]
    what: Deploy the service on Forge Cloud.
    after: [northwind-config]
  - id: switch
    kind: cut-over
    repos: [forge-stock, forge-orders]
    what: Point the route at the new deployment.
    after: [deploy-new]
    undo: Point the route back at the old deployment.
`;

describe("a plan whose tasks could never be scheduled is refused at the architecture stage", () => {
  const free = { newFlows: [], operations: [] };
  const order = (text: string, e: Estate) => {
    const o = ops(text);
    return checkOperations(o.operations, o.waves, e, free)
      .filter((i) => i.rule === "operation.order")
      .map((i) => i.message);
  };

  it("names the ring: a wave-1 task that comes after an operation done only in wave 2", async () => {
    const e = await estate(await estateRoot());
    expect(order(RING, e)).toEqual([
      "The operations can't be put in an order: northwind-config in forge-orders (wave 2) waits for switch in forge-stock (wave 1), which waits for deploy-new in forge-stock (wave 1), which waits for northwind-config in forge-orders (wave 2). A wave starts once the wave before it is done, and an operation that comes after another waits for it: move a repo to another wave, take an after away, or leave waves out.",
    ]);
    // The same plan without waves can be scheduled.
    expect(order(RING.slice(RING.indexOf("operations:")), e)).toEqual([]);
  });

  it("a wave-1 cleanup after a cut-over that spans both waves is refused too", async () => {
    const e = await estate(await estateRoot());
    const text = `waves:
  - { repos: [forge-stock] }
  - { repos: [forge-orders] }
operations:
  - id: switch
    kind: cut-over
    repos: [forge-stock, forge-orders]
    what: Point the route at the new deployment.
    undo: Point the route back at the old deployment.
  - id: retire
    kind: deployment
    repos: [forge-infra]
    what: Take the old hosts away.
    after: [switch]
`.replace("repos: [forge-stock] }", "repos: [forge-stock, forge-infra] }");
    expect(order(text, e)).toHaveLength(1);
    expect(order(text, e)[0]).toContain(
      "retire in forge-infra (wave 1), which waits for switch in forge-orders (wave 2)",
    );
  });

  it("the suggested order and the tasks' waits are one graph: every wait is earlier in the order", () => {
    for (const text of [OPERATIONS, RING.slice(RING.indexOf("operations:"))]) {
      const o = ops(text);
      const steps = suggestedOperationOrder(o.operations, o.waves);
      const at = new Map<string, number>();
      const stories = operationStories(o.operations, o.waves);
      for (const s of stories)
        for (const t of s.tasks)
          at.set(
            t.label,
            steps.findIndex((x) => x.operation === s.operation.id && x.repo === t.repo),
          );
      expect([...at.values()].sort((a, b) => a - b)).toEqual(steps.map((_, i) => i));
      for (const s of stories)
        for (const t of s.tasks)
          for (const a of t.after) expect(at.get(a)!).toBeLessThan(at.get(t.label)!);
    }
  });

  it("a wave with no operation in it doesn't let the next wait for nothing", () => {
    const o = ops(`waves:
  - { repos: [forge-orders] }
  - { repos: [forge-infra] }
  - { repos: [forge-stock] }
operations:
  - id: deploy-new
    kind: deployment
    repos: [forge-orders, forge-stock]
    what: Deploy the service on Forge Cloud.
`);
    expect(
      operationStories(o.operations, o.waves)[0]!.tasks.map((t) => [t.label, t.wave, t.after]),
    ).toEqual([
      ["o1.1", 1, []],
      ["o1.2", 3, ["o1.1"]],
    ]);
  });
});

describe("the review's other refusals", () => {
  it("an undo is a real sentence: n/a, none, a dash or a few letters are refused", async () => {
    const e = await estate(await estateRoot());
    for (const undo of ["n/a", "None.", "-", "tbd", "redeploy"])
      expect(rules(OPERATIONS.replace(/ {4}undo: .*\n/, `    undo: "${undo}"\n`), e)).toEqual([
        "operation.no-undo: Operation switch is a cut-over and gives no undo: say under undo how it is taken back, in one or two sentences.",
      ]);
  });

  it("an undo that only says it doesn't apply is refused for a cut-over", async () => {
    const e = await estate(await estateRoot());
    for (const undo of [
      "Not applicable here.",
      "Not applicable to this cut-over.",
      "None needed for this one.",
      "Nothing to undo here.",
      "No undo is needed.",
      "It doesn't apply to a cut-over.",
      "This does not apply here.",
      "There is nothing to roll back.",
      "There's nothing to revert.",
      "Nothing to back out here.",
      "No rollback is possible.",
      "No revert is needed.",
      "No undo is possible here.",
      "It can't be rolled back.",
      "This cannot be undone.",
    ])
      expect(rules(OPERATIONS.replace(/ {4}undo: .*\n/, `    undo: "${undo}"\n`), e), undo).toEqual(
        [
          "operation.no-undo: Operation switch is a cut-over and gives no undo: say under undo how it is taken back, in one or two sentences.",
        ],
      );
    // A real one passes, even when it says what doesn't need undoing.
    expect(
      rules(
        OPERATIONS.replace(
          / {4}undo: .*\n/,
          "    undo: Roll back by pointing the route at the old deployment; there is nothing else to revert.\n",
        ),
        e,
      ),
    ).toEqual([]);
  });

  it("an explicit deploy order may not put an operation before the flow migration or code it needs", () => {
    const o = ops();
    const flows: { repo: string; migration?: string; operation?: string }[] = [
      { repo: "forge-orders", migration: "V4__add_fraud_verdict.sql" },
      { repo: "forge-orders" },
    ];
    const good = [...flows, ...suggestedOperationOrder(o.operations, o.waves)];
    expect(operationDeployIssues(o.operations, o.waves, good, flows)).toEqual([]);
    // The cut-over in forge-orders before forge-orders' migration and code.
    const cut = good.findIndex((x) => x.operation === "switch" && x.repo === "forge-orders");
    const early = [good[cut]!, ...good.filter((_, i) => i !== cut)];
    expect(
      operationDeployIssues(o.operations, o.waves, early, flows).map(
        (i) => `${i.rule}: ${i.message}`,
      ),
    ).toEqual([
      "delta.deploy-order: The deploy order puts operation switch in forge-orders (step 1) before deploy-new (step 4), which it comes after: deploy-new goes first.",
      "delta.deploy-order: The deploy order puts operation switch in forge-orders (step 1) before migration V4__add_fraud_verdict.sql in forge-orders (step 2), which it needs: a cut-over moves traffic once its repo's migrations and code are in. Put it after.",
      "delta.deploy-order: The deploy order puts operation switch in forge-orders (step 1) before forge-orders's code (step 3), which it needs: a cut-over moves traffic once its repo's migrations and code are in. Put it after.",
    ]);
    // An operation that names the migration comes after it, in any repo.
    const named = OperationsFile.parse({
      schemaVersion: 1,
      change: CHANGE,
      operations: [
        {
          id: "backfill",
          kind: "config",
          repos: ["forge-infra"],
          what: "Turn the backfill job on once V4__add_fraud_verdict.sql has run.",
        },
      ],
    });
    const order = [{ repo: "forge-infra", operation: "backfill" }, ...flows];
    expect(
      operationDeployIssues(named.operations, undefined, order, flows).map((i) => i.message),
    ).toEqual([
      "The deploy order puts operation backfill in forge-infra (step 1) before migration V4__add_fraud_verdict.sql in forge-orders (step 2), which it needs: its words name that migration. Put it after.",
    ]);
  });

  it("an archived repo is refused, though the catalog still has its records", async () => {
    const root = await estateRoot();
    await mkdir(join(root, "org-pack/profiles/forge-old"), { recursive: true });
    await writeFile(
      join(root, "org-pack/profiles/forge-old/repos.manifest.yaml"),
      "schemaVersion: 1\nplatform: forge-old\nrepos:\n  - id: forge-stock\n    url: https://git.example.com/forge/forge-stock.git\n    type: spring-boot\n    owner: team-orders\n    archived: true\n",
    );
    await writeFile(
      join(root, "org-pack/profiles/forge/repos.manifest.yaml"),
      MANIFEST.replace(/ {2}- id: forge-stock\n(?: {4}.*\n){3}/, ""),
    );
    const all = rules(OPERATIONS, await estate(root));
    // Its own rule, which a person can't accept (ADR 0203 B addendum): never unknown-repo.
    expect(all.filter((m) => m.startsWith("operation.unknown-repo"))).toEqual([]);
    const got = all.filter((m) => m.startsWith("operation.archived-repo"));
    expect(got).toHaveLength(2);
    // A new flow there too, though its records are still in the catalog; and an operation the
    // feature lists there.
    const placed = FeaturePlacement.parse({
      ...placement(),
      newFlows: [{ name: "Stock screen", repo: "forge-stock", why: "Screens stock." }],
    });
    expect(
      checkPlacement(placed, await estate(root))
        .filter((i) => i.rule.endsWith("-repo"))
        .map((i) => [i.rule, i.target, i.blocking]),
    ).toEqual(
      expect.arrayContaining([
        ["feature.archived-repo", "Stock screen:forge-stock", true],
        ["feature.archived-repo", "deployment:forge-stock", true],
      ]),
    );
    expect(
      checkPlacement(placed, await estate(root)).filter((i) => i.rule === "feature.unknown-repo"),
    ).toEqual([]);
    expect(got[0]).toBe(
      "operation.archived-repo: Operation deploy-new names repo forge-stock, which the manifest marks archived: an archived repo takes no new work, and that can't be accepted. Name the repo that took over its work, or take archived off in the manifest.",
    );
  });

  it("the stories stage checks the operations file again: an undo deleted after architecture is refused", async () => {
    const root = await estateRoot();
    await featureStage(root, CHANGE, { runtime: assistant([FEATURE]), now: NOW });
    await architectureStage(root, CHANGE, { runtime: assistant([ARCHITECTURE]), now: NOW });
    const file = join(root, "openspec/changes", CHANGE, OPERATIONS_FILE);
    await writeFile(file, (await readFile(file, "utf8")).replace(/ {4}undo: .*\n/, ""));
    const issues = await checkStageDraft(root, CHANGE, "stories", STORIES);
    expect(issues.map((i) => i.rule)).toEqual(["operation.no-undo"]);
  });

  it("an operation's requirement is named for its change and always added", () => {
    const o = ops();
    const words = (parse(STORIES) as { operations: Parameters<typeof operationRequirements>[2] })
      .operations;
    const reqs = operationRequirements(CHANGE, operationStories(o.operations, o.waves), words);
    expect(reqs.filter((r) => r.repo === "forge-stock").map((r) => r.name)).toEqual([
      `Run each service on Forge Cloud (${CHANGE})`,
      `Move the traffic (${CHANGE})`,
    ]);
  });

  it("a secret-looking value in an operation's words or in what runs today is redacted", async () => {
    const o = Operation.parse({
      id: "carrier-key",
      kind: "secret",
      repos: ["forge-orders"],
      what: "Set carrier.password=hunter2-s3cret-value in the vault.",
      // Built from parts, so no key-shaped literal sits in the repository.
      sets: { key: `carrier.api-key=${["sk", "live", "q8Rt2Lm9Wx4Zp7Kc3Vn6Bh1J"].join("_")}` },
      undo: "Put password: 'old-s3cret-value-9' back.",
    });
    expect(JSON.stringify(o)).not.toMatch(/hunter2|sk_live|old-s3cret/);
    expect(o.what).toContain("<redacted>");
    const e = await estate(await estateRoot());
    const setting = e.records.find(
      (r) => r.id === "forge-orders.setting.stock-timeout",
    ) as unknown as { key: string };
    setting.key = "carrier.password=hunter2-s3cret-value";
    const text = runsTodaySource(e, ["forge-orders"])[0]!.text;
    expect(text).not.toContain("hunter2");
    expect(text).toContain(
      "forge-orders.setting.stock-timeout: Setting carrier.password=<redacted>",
    );
  });

  it("redacts by the facts' rules: a password in prose, a credential with no scheme, only the value, and never a record id", async () => {
    // Built from parts, so no credential-shaped literal sits in the repository.
    const pass = ["hunter2", "s3cret"].join("-");
    const dbPass = ["Tr0ub4dor", "x9"].join("-");
    const key = ["pay", "api", "key"].join("-");
    const token = ["sk", "live", "q8Rt2Lm9Wx4Zp7Kc3Vn6Bh1J"].join("_");
    const cases: [string, string][] = [
      [`Set the password ${pass} in the vault.`, "Set the password <redacted> in the vault."],
      [`Set the password to ${pass}.`, "Set the password to <redacted>."],
      [
        `Point it at svc:${dbPass}@db.forge.example:5432.`,
        "Point it at svc:<redacted>@db.forge.example:5432.",
      ],
      [
        `Point it at postgres://svc:${dbPass}@db.forge.example/orders.`,
        "Point it at postgres://svc:<redacted>@db.forge.example/orders.",
      ],
      [`Give it ${key}: ${token} from the vault.`, `Give it ${key}: <redacted> from the vault.`],
      [`Set ${key}=${token}.`, `Set ${key}=<redacted>.`],
      // What names a secret stays, with nothing after it to hide.
      [`Move ${key} to the new vault.`, `Move ${key} to the new vault.`],
      [
        `forge-orders.setting.${key}: Setting ${key} (config)`,
        `forge-orders.setting.${key}: Setting ${key} (config)`,
      ],
      [
        "Set the password policy from the vault: ${VAULT_PASS}.",
        "Set the password policy from the vault: ${VAULT_PASS}.",
      ],
    ];
    // What core's redactSecrets catches stays caught: a password or a token in a URL's query.
    const query = ["s3cr", "etPass9"].join("");
    const tok = ["q8Rt2Lm9", "Wx4Zp7Kc"].join("");
    cases.push(
      [
        `Point the app at jdbc:postgresql://db:5432/orders?user=app&password=${query}`,
        "Point the app at jdbc:postgresql://db:5432/orders?user=app&password=<redacted>",
      ],
      [
        `Call https://api.forge.example/v1/rates?token=${tok} from the job.`,
        "Call https://api.forge.example/v1/rates?token=<redacted> from the job.",
      ],
    );
    for (const [input, out] of cases) expect(redactWords(input), input).toBe(out);
    // The same under sets.host, as the operations file keeps it.
    const host = Operation.parse({
      id: "db",
      kind: "config",
      repos: ["forge-orders"],
      what: "Point the app at the new database.",
      sets: { host: `jdbc:postgresql://db:5432/orders?user=app&password=${query}` },
    }).sets!.host!;
    expect(host).not.toContain(query);
    expect(host).toContain("password=<redacted>");
    // What runs today: the Setting's record id and key stay, so the model can cite them.
    const e = await estate(await estateRoot());
    const setting = e.records.find(
      (r) => r.id === "forge-orders.setting.stock-timeout",
    ) as unknown as { id: string; key: string };
    setting.key = key;
    expect(runsTodaySource(e, ["forge-orders"])[0]!.text).toContain(
      `forge-orders.setting.stock-timeout: Setting ${key} (timeout)`,
    );
  });

  it("a change with no operation gets stories.md and tasks.md exactly as the flows' stories wrote them", () => {
    const written = {
      index: "# Stories\n\n| Story | Title |\n",
      tasks: "# Tasks\n\n## forge-orders\n\n- [ ] 1.1 x\n",
    };
    const out = withOperationStories([], undefined, written);
    expect(out.index).toBe(written.index);
    expect(out.tasks).toBe(written.tasks);
    expect(out.files).toEqual({});
  });

  it("a deploy order that gives only flow steps is told which operation steps it leaves out", () => {
    const o = ops();
    const got = operationDeployIssues(o.operations, o.waves, [{ repo: "forge-orders" }]);
    expect(got).toHaveLength(7);
    expect(got.every((i) => i.rule === "delta.deploy-missing")).toBe(true);
  });

  it("the conformance reader passes the operations file by: it is no target flow", async () => {
    const root = await estateRoot();
    await featureStage(root, CHANGE, { runtime: assistant([FEATURE]), now: NOW });
    await architectureStage(root, CHANGE, { runtime: assistant([ARCHITECTURE]), now: NOW });
    expect(await readConformDeltas(join(root, "openspec/changes", CHANGE))).toEqual({
      deltas: [],
      problems: [],
    });
  });

  it("an operations-only design that names a table's column is done at architecture, never asked for data.md", async () => {
    const root = await estateRoot();
    await featureStage(root, CHANGE, { runtime: assistant([FEATURE]), now: NOW });
    const drafts: string[] = [];
    const r = await architectureStage(root, CHANGE, {
      runtime: assistant(
        [
          ARCHITECTURE.replace(
            "what: Carry the stock timeout over to the new platform's settings.",
            "what: Carry the stock timeout over; orders.status is read as before.",
          ),
        ],
        drafts,
      ),
      now: NOW,
    });
    expect(r.findings.filter((f) => f.blocking).map((f) => f.rule)).toEqual([]);
    expect(r.state).toBe("done");
    expect(drafts).toHaveLength(1);
  });
});
