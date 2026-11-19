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
  checkStageDraft,
  consumerIssues,
  EXPAND_AGENT,
  featureStage,
  FeaturePlacement,
  FlowDelta,
  loadEstate,
  operationDeployIssues,
  OPERATIONS_FILE,
  OperationsFile,
  operationStories,
  readOperations,
  smallStage,
  storiesStage,
  suggestedOperationOrder,
  withOperationStories,
  type Estate,
  type Operation,
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
    expect(spec).toContain("### Requirement: Keep the stock timeout\n");
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
