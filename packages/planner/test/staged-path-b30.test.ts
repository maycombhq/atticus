import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import { listQuestions, parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { loadChangeContext } from "@maycombhq/changes";
import {
  checkStories,
  consumerIssues,
  deployIssues,
  estateOf,
  estateRepos,
  EXPAND_AGENT,
  featureStage,
  FlowDelta,
  knownFieldNames,
  loadEstate,
  placeIssues,
  planStories,
  quickPathHint,
  smallStage,
  stageRuleKind,
  StoriesAnswerSchema,
  storiesFromDeltas,
  type DeployStep,
  type Estate,
} from "../src/index.js";
import { CHANGE as FORGE_CHANGE_ID, changeDir, forgeChangeRoot } from "./helpers.js";

/**
 * ADR 0201 decision 8: the staged path says where to go. On the small two-repo Forge estate
 * (forge-orders, forge-stock) with a manifest that also lists forge-infra, a repo nobody read
 * (the trial got "deploys forge-infra, which isn't a repo the estate has"), and forge-mobile.
 * A mock model; no network.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "../../../fixtures");
const HOLD = join(FIX, "stages/hold-stock");
const NOW = new Date("2026-11-18T09:00:00Z");
const CHANGE = "add-fraud-check";
const HINT =
  "If this change alters no runtime step in a repo the map holds (a new product, a move to another platform, pipeline or configuration work), it belongs on the quick path: write its requirements file and run atticus change new --from <requirements.md>.";

const MANIFEST = `schemaVersion: 1
platform: forge
repos:
  - id: forge-orders
    url: https://git.example.com/forge/forge-orders.git
    type: spring-boot
    owner: team-orders
  - id: forge-infra
    url: https://git.example.com/forge/forge-infra.git
    type: infra
    owner: team-platform
  - id: forge-mobile
    url: https://git.example.com/forge/forge-mobile.git
    type: spa
    owner: team-mobile
`;

/** The stages' estate, with the manifest; `more` names further catalog files and change folders. */
async function estateRoot(o: { hold?: boolean; small?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-staged-b30-"));
  await mkdir(join(root, "org-pack/profiles/forge"), { recursive: true });
  await writeFile(join(root, "org-pack/profiles/forge/repos.manifest.yaml"), MANIFEST);
  const rows = [
    ...(parse(readFileSync(join(FIX, "specs/catalog.yaml"), "utf8")) as unknown[]),
    ...(parse(readFileSync(join(FIX, "stages/catalog-extra.yaml"), "utf8")) as unknown[]),
    ...(o.hold
      ? [
          ...(parse(readFileSync(join(FIX, "stages/pin-table/catalog.yaml"), "utf8")) as unknown[]),
          ...(parse(readFileSync(join(HOLD, "catalog.yaml"), "utf8")) as unknown[]),
        ]
      : []),
  ];
  for (const r of rows) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(`bad fixture record: ${JSON.stringify(p.issues)}`);
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(join(FIX, "stages/specs"), join(root, "specs"), { recursive: true });
  await cp(join(FIX, "stages/changes"), join(root, "openspec/changes"), { recursive: true });
  if (o.small)
    await cp(
      join(FIX, "stages/small/return-order-time"),
      join(root, "openspec/changes/return-order-time"),
      { recursive: true },
    );
  return root;
}

const estate = async (root: string): Promise<Estate> =>
  loadEstate(root, (await loadChangeContext(root)).records);

/** A mock assistant: critics and the expander find nothing; the drafter answers in turn. */
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

const placed = (
  newFlow: string,
) => `summary: Every new order is screened by Northwind Pay before stock is reserved.
features:
  - { id: cap-ordering, why: Placing an order gains the screen. }
flows:
  - { id: forge-orders.place-order, how: changed, why: The screen runs before stock is reserved. }
newFlows:
  - ${newFlow}
`;

const stopOf = async (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: Error & { code?: string; problems?: string[] }) => e,
  );

describe("the estate is every repo with a flow or a record, and every manifest's", () => {
  it("reads the manifests' repo ids into the estate", async () => {
    const e = await estate(await estateRoot());
    expect([...e.manifestRepos].sort()).toEqual(["forge-infra", "forge-mobile", "forge-orders"]);
    expect([...estateRepos(e)].sort()).toEqual([
      "forge-infra",
      "forge-mobile",
      "forge-orders",
      "forge-stock",
    ]);
    // An estate made without a manifest has none, as before.
    expect([...estateOf([], []).manifestRepos]).toEqual([]);
  });
});

describe("the feature stage and a repo nobody read, or that isn't there yet", () => {
  it("passes a new flow put in a manifest repo with nothing read in it", async () => {
    const root = await estateRoot();
    const r = await featureStage(root, CHANGE, {
      runtime: assistant([
        placed("{ name: Screening queue, repo: forge-infra, why: The screen needs a queue. }"),
      ]),
      now: NOW,
    });
    expect(r.state).toBe("done");
    expect(r.drafts).toBe(1);
    expect(r.findings).toEqual([]);
  });

  it("passes a repo the answer marks newRepo: true, with a note that names atticus repo add", async () => {
    const root = await estateRoot();
    const seen: string[] = [];
    const r = await featureStage(root, CHANGE, {
      runtime: assistant(
        [
          placed(
            "{ name: Storefront checkout, repo: forge-storefront, newRepo: true, why: The new product's own flow. }",
          ),
        ],
        seen,
      ),
      now: NOW,
    });
    expect(r.state).toBe("done");
    expect(r.drafts).toBe(1);
    expect(r.findings.map((f) => [f.rule, f.target, f.blocking, f.message])).toEqual([
      [
        "feature.planned-repo",
        "Storefront checkout:forge-storefront",
        false,
        'New flow "Storefront checkout" is put in forge-storefront, a new repo this change plans. Once it is created on your Git host, add it: atticus repo add <its clone URL> --id forge-storefront.',
      ],
    ]);
    // The mark stays in feature.yaml, and the prompt says how to make it.
    const file = parse(
      await readFile(join(root, "openspec/changes", CHANGE, "feature.yaml"), "utf8"),
    ) as { newFlows: unknown[] };
    expect(file.newFlows).toEqual([
      {
        name: "Storefront checkout",
        repo: "forge-storefront",
        newRepo: true,
        why: "The new product's own flow.",
      },
    ]);
    expect(seen[0]).toContain("newRepo: true");
  });

  it("refuses any other repo the estate doesn't have, as before", async () => {
    const root = await estateRoot();
    const r = await featureStage(root, CHANGE, {
      runtime: assistant([
        placed("{ name: Storefront checkout, repo: forge-storefront, why: The new product. }"),
      ]),
      now: NOW,
    }).catch((e: Error) => e);
    const words =
      'New flow "Storefront checkout" is put in repo forge-storefront, which the estate doesn\'t have.';
    if (r instanceof Error) expect(r.message).toContain(words);
    else
      expect(JSON.stringify([r.findings, r.questions])).toContain(
        JSON.stringify(words).slice(1, -1),
      );
  });

  it("stops on the first draft that places nothing, with the hint and no question (amends ADR 0087)", async () => {
    const root = await estateRoot();
    const seen: string[] = [];
    const e = await stopOf(
      featureStage(root, CHANGE, {
        runtime: assistant(["summary: A move of the order services to another platform.\n"], seen),
        now: NOW,
      }),
    );
    expect(e).toMatchObject({ name: "PlannerError", code: "stopped" });
    expect(e!.message.split("\n")).toEqual([
      "The feature stage stopped after 1 draft: it found nothing for the staged path to plan.",
      "  - The feature touches nothing: name the features and flows it touches, or the new flows it needs. (rule feature.nothing-placed; in openspec/changes/add-fraud-check/feature.yaml)",
      HINT,
    ]);
    expect(quickPathHint()).toBe(HINT);
    // One draft was asked for, and no question was raised.
    expect(seen).toHaveLength(1);
    expect((await listQuestions(root, { state: "open" })).questions).toEqual([]);
    const loop = parse(
      await readFile(join(root, "openspec/changes", CHANGE, "stage/feature.yaml"), "utf8"),
    ) as { state: string; iteration: number };
    expect(loop).toMatchObject({ state: "stopped", iteration: 1 });
  });
});

describe("the fast path that changes no step", () => {
  it("stops on the first draft with the hint", async () => {
    const root = await estateRoot({ small: true });
    const a = parse(readFileSync(join(FIX, "stages/small/answer.yaml"), "utf8")) as Record<
      string,
      unknown
    >;
    const seen: string[] = [];
    const e = await stopOf(
      smallStage(root, "return-order-time", {
        runtime: assistant([stringify({ ...a, targetFlows: [], stories: [] })], seen),
        now: NOW,
      }),
    );
    expect(e).toMatchObject({ name: "PlannerError", code: "stopped" });
    const lines = e!.message.split("\n");
    expect(lines[0]).toBe(
      "The small stage stopped after 1 draft: it found nothing for the staged path to plan.",
    );
    expect(lines).toContain(
      "  - The answer changes no step of any flow: write the target flow of every flow the change changes, under targetFlows. (rule small.no-target-flow; in openspec/changes/return-order-time/stage/small-answer.yaml)",
    );
    expect(lines.at(-1)).toBe(HINT);
    expect(seen).toHaveLength(1);
    expect((await listQuestions(root, { state: "open" })).questions).toEqual([]);
  });
});

describe("the stories of a change with nothing to plan", () => {
  it("are refused with the hint", async () => {
    const root = await forgeChangeRoot();
    const dir = changeDir(root);
    await rm(join(dir, "specs"), { recursive: true, force: true });
    for (const f of ["interfaces.md", "data.md", "mappings.md"]) await rm(join(dir, f));
    await writeFile(join(dir, "design.md"), "# Design\n\nNothing changes at run time.\n");
    const e = await stopOf(planStories(root, FORGE_CHANGE_ID, { now: NOW, draft: true }));
    expect(e).toMatchObject({
      code: "refused",
      message: `${FORGE_CHANGE_ID} has nothing to plan: no spec requirement, no new or changed interface and no data change. ${HINT}`,
    });
  });
});

describe("the deploy order and a manifest repo", () => {
  const draft = () => {
    const a = parse(readFileSync(join(HOLD, "drafts/clean.yaml"), "utf8")) as {
      flows: object[];
      deploy: DeployStep[];
    };
    return {
      flows: a.flows.map((f) => FlowDelta.parse({ schemaVersion: 2, ...f })),
      deploy: a.deploy,
    };
  };

  it("may deploy a repo the manifest lists and nobody read; any other is refused as before", async () => {
    const e = await estate(await estateRoot({ hold: true }));
    const d = draft();
    const deploy = [{ repo: "forge-infra" }, ...d.deploy, { repo: "forge-billing" }];
    expect(deployIssues(d.flows, deploy, e).map((i) => [i.rule, i.target, i.message])).toEqual([
      [
        "delta.deploy-unknown-repo",
        "deploy#5",
        "Step 5 of the deploy order deploys forge-billing, which isn't a repo the estate has or a component this change plans: name a repo from the index, or draw forge-billing as a new component.",
      ],
    ]);
  });

  it("a consumer the manifest lists, or the change plans, is a note; any other blocks as before", async () => {
    const e = await estate(await estateRoot({ hold: true }));
    const d = draft();
    d.flows[0]!.consumers = ["forge-orders", "forge-mobile", "forge-alerts", "forge-partner"];
    d.flows[0]!.steps.push({
      op: "add",
      after: 1,
      kind: "call-out",
      what: "The alerts service hears of the hold",
      to: { component: "forge-alerts", entry: "POST /alerts", new: true },
    } as FlowDelta["steps"][number]);
    const got = consumerIssues(d.flows, e).filter((i) => i.rule === "delta.unknown-consumer");
    expect(got.map((i) => [i.target, i.blocking, i.message])).toEqual([
      [
        "forge-stock.reserve-stock:forge-mobile",
        false,
        "Flow forge-stock.reserve-stock lists consumer forge-mobile, which is in the manifest and hasn't been read, so its use can't be checked: atticus map forge-mobile",
      ],
      [
        "forge-stock.reserve-stock:forge-alerts",
        false,
        "Flow forge-stock.reserve-stock lists consumer forge-alerts, which is planned in this change and hasn't been read, so its use can't be checked.",
      ],
      [
        "forge-stock.reserve-stock:forge-partner",
        true,
        "Flow forge-stock.reserve-stock lists consumer forge-partner, which isn't in the catalog. List components from the index.",
      ],
    ]);
    // finding-kind.ts is unchanged: it only matters for the blocking case.
    expect(stageRuleKind("delta.unknown-consumer")).toBe("drafting");
  });
});

describe("a new file's folder in an empty repo", () => {
  const delta = (file: string) => [
    FlowDelta.parse({
      schemaVersion: 2,
      flow: "forge-storefront.checkout",
      repo: "forge-storefront",
      change: "new",
      name: "Checkout",
      trigger: { kind: "endpoint", what: "A basket is checked out", entry: "POST /checkout" },
      why: "The new product's own flow.",
      steps: [{ op: "add", kind: "transform", what: "The basket is priced", new: file }],
    }),
  ];
  const rules = async (root: string, file = "src/checkout/Checkout.java") =>
    (await placeIssues(delta(file), estateOf([], []), root)).map(
      (i) => `${i.rule}${i.blocking ? "" : " (note)"}: ${i.message}`,
    );

  it("is a note while the checkout has no folder but hidden ones; it blocks once the repo has a layout", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-empty-repo-"));
    await mkdir(join(root, "workspace/forge-storefront/.git"), { recursive: true });
    await writeFile(join(root, "workspace/forge-storefront/README.md"), "# forge-storefront\n");
    expect(await rules(root)).toEqual([
      "delta.new-folder (note): Change 1 to forge-storefront.checkout puts the new code in a new file src/checkout/Checkout.java, and forge-storefront is an empty repo: the change gives it its layout, so the folder isn't checked.",
    ]);
    // Not a path at all still blocks.
    expect(await rules(root, "../forge-web/x.ts")).toEqual([
      "delta.new-folder: Change 1 to forge-storefront.checkout puts the new code in ../forge-web/x.ts, which isn't a path in forge-storefront: give the new file's path from the repo's root, in the folder of its nearest kin.",
    ]);
    await mkdir(join(root, "workspace/forge-storefront/app"), { recursive: true });
    expect(await rules(root)).toEqual([
      "delta.new-folder: Change 1 to forge-storefront.checkout puts the new code in a new file src/checkout/Checkout.java, but forge-storefront has no folder src/checkout: name the file in the folder of its nearest kin, the repo's own layout.",
    ]);
  });
});

describe("a story's interface change and a consumer nobody read", () => {
  it("is a note for a manifest repo, with the same words; any other blocks as before", async () => {
    const root = await estateRoot();
    const e = await estate(root);
    const S = join(FIX, "stages/stories");
    const deltas = (
      parse(readFileSync(join(S, "deltas.yaml"), "utf8")) as { flows: unknown[] }
    ).flows.map((d) => FlowDelta.parse({ schemaVersion: 2, ...(d as object) }));
    const a = parse(readFileSync(join(S, "answer.yaml"), "utf8")) as {
      stories: { interfaces: { entry: string; consumers?: string[] }[] }[];
    };
    a.stories[0]!.interfaces.find((i) => i.entry === "POST /v1/screenings")!.consumers = [
      "forge-orders",
      "forge-mobile",
      "forge-partner",
    ];
    const got = checkStories(
      StoriesAnswerSchema.parse(a),
      storiesFromDeltas(deltas, e),
      deltas,
      [],
      { sections: true, known: knownFieldNames(e, deltas), estate: e },
    ).filter((i) => i.rule === "stories.unknown-consumer");
    expect(got.map((i) => [i.blocking, i.message.replace(/^Story \S+: /, "")])).toEqual([
      [
        false,
        "POST /v1/screenings's consumer forge-mobile is in the manifest and hasn't been read, so its use can't be checked: atticus map forge-mobile",
      ],
      [
        true,
        "POST /v1/screenings's consumer forge-partner isn't a component or system in the catalog. Name consumers by their catalog ids, or leave them out and say who calls it in why.",
      ],
    ]);
  });
});
