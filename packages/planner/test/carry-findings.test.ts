import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import {
  answerQuestion,
  loadOrgPack,
  parseFacts,
  parseRecord,
  recordPath,
  serializeRecord,
  type Fact,
  type OrgPack,
} from "@maycombhq/core";
import { act, CriticError, gateStatus } from "@maycombhq/naysayer";
import { estateFromFacts } from "@maycombhq/scanner";
import {
  checkDeltas,
  checkStories,
  estateIndex,
  estateOf,
  featureStage,
  FeaturePlacement,
  FlowDelta,
  interfaceChanges,
  stageEnd,
  StoriesAnswerSchema,
  type Estate,
} from "../src/index.js";

/**
 * What a real change's run through feature, architecture and stories hit (ADR 0087, 0115 and 0111
 * addenda, 2026-10-25), each as the scenario that showed it, on the invented Forge estates:
 *
 * 1. The critic's blocking finding, in the round that also raised a question, goes to the next
 *    draft with what to fix once the question is answered.
 * 2. A risk finding gets one more draft, handed back with its fix; and a fix to a file a stage
 *    renders (feature.md from feature.yaml) is refused with a pointer to the source.
 * 4. Questions over the stop's cap are kept in the loop file, by their words.
 * 5. An outside system a call fact names (a model provider) is a call-out's target.
 * 6. design.md says an entry that exists today is existing, not planned-new.
 * 7. A critic finding left out is said, never dropped silently.
 * 8. A standard named as a request is a standard to follow, not a request to raise.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "../../../fixtures/stages");
const CARRY = join(FIX, "carry");
const NOW = new Date("2026-10-25T09:00:00Z");
const CHANGE = "add-fraud-check";
const REL = `openspec/changes/${CHANGE}`;
const text = (f: string) => readFileSync(join(CARRY, f), "utf8");
const ASKS = text("feature-asks.yaml");
const FIXED = text("feature-fixed.yaml");
const TRUE_FINDING = text("findings-true.yaml");
const RISK = text("findings-complete.yaml");
const CACHED_BY_ID = "the screen's verdict is cached by order id for an hour";

const NO_EXPANSION = `schemaVersion: 1
assistants: { allowed: [copilot], default: copilot }
retrieval: { expansion: false }
`;

async function estateRoot(o: { policy?: string } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-carry-"));
  await mkdir(join(root, "org-pack/process"), { recursive: true });
  await writeFile(join(root, "org-pack/runtime.yaml"), NO_EXPANSION);
  if (o.policy) await writeFile(join(root, "org-pack/process/change-policy.yaml"), o.policy);
  const rows = [
    ...(parse(readFileSync(join(FIX, "../specs/catalog.yaml"), "utf8")) as unknown[]),
    ...(parse(readFileSync(join(FIX, "catalog-extra.yaml"), "utf8")) as unknown[]),
  ];
  await writeRecords(root, "catalog/generated", rows);
  await writeRecords(
    root,
    "knowledge/items",
    parse(readFileSync(join(FIX, "knowledge.yaml"), "utf8")) as unknown[],
  );
  await cp(join(FIX, "specs"), join(root, "specs"), { recursive: true });
  await cp(join(FIX, "changes"), join(root, "openspec/changes"), { recursive: true });
  await cp(join(FIX, "lenses/checklists"), join(root, "org-pack/checklists"), { recursive: true });
  return root;
}

async function writeRecords(root: string, under: string, rows: unknown[]): Promise<void> {
  for (const r of rows) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(`bad fixture record: ${JSON.stringify(p.issues)}`);
    const f = join(root, under, recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
}

/** An assistant that drafts in turn and a critic whose lenses answer as given. */
function assistant(
  drafts: string[],
  lens: { true?: (prompt: string) => string; complete?: (prompt: string) => string },
  prompts: string[],
) {
  return new MockRuntime(
    (req: AiRequest) => {
      if (req.agent.id === "true-critic") return lens.true?.(req.pack.prompt) ?? "findings: []";
      if (req.agent.id === "complete-critic")
        return lens.complete?.(req.pack.prompt) ?? "findings: []";
      if (req.agent.id.endsWith("-critic")) return "findings: []";
      prompts.push(req.pack.prompt);
      return drafts.length > 1 ? drafts.shift()! : drafts[0]!;
    },
    { now: () => NOW },
  );
}

/** The hand-backs data block of a prompt: what the drafter is given as data. */
const handBacks = (prompt: string) => {
  const at = prompt.indexOf('<atticus-data id="hand-backs"');
  return at < 0 ? "" : prompt.slice(at, prompt.indexOf("</atticus-data>", at));
};

const loopOf = async (root: string) =>
  parse(await readFile(join(root, REL, "stage/feature.yaml"), "utf8")) as {
    state: string;
    source?: string;
    waiting?: { question: string; evidence: string[] }[];
  };

describe("the critic's finding in the round that also asked a question (1)", () => {
  it("goes to the draft after the answer, with what to fix", async () => {
    const root = await estateRoot();
    const prompts: string[] = [];
    const rt = assistant(
      [ASKS, FIXED],
      { true: (p) => (p.includes(CACHED_BY_ID) ? TRUE_FINDING : "findings: []") },
      prompts,
    );
    const first = await featureStage(root, CHANGE, { runtime: rt, now: NOW });
    expect(first.state).toBe("questions");
    expect(first.findings.map((f) => f.rule)).toContain("critic:flow-use-matches-estate");
    for (const q of first.questions)
      await answerQuestion(root, q.id, { text: "Refuse it.", by: "pat", at: NOW.toISOString() });
    const second = await featureStage(root, CHANGE, { runtime: rt, now: NOW });
    expect(second.state).toBe("done");
    const back = handBacks(prompts[1]!);
    expect(back).toContain(
      "The verdict's cache key is the order id alone, so a verdict from an older screen data version is served.",
    );
    expect(back).toContain("Key the cached verdict by the order id and the screen's data version.");
  });
});

describe("a risk finding (2)", () => {
  it("gets one more draft, handed back with its fix, and never blocks", async () => {
    const root = await estateRoot();
    const prompts: string[] = [];
    const rt = assistant([FIXED], { complete: () => RISK }, prompts);
    const r = await featureStage(root, CHANGE, { runtime: rt, now: NOW });
    expect(r.state).toBe("done");
    expect(r.drafts).toBe(2);
    expect(prompts).toHaveLength(2);
    const back = handBacks(prompts[1]!);
    expect(back).toContain(
      "The brief's clear message for a refused order isn't placed on any flow.",
    );
    expect(back).toContain("Say which flow's response carries the refusal message.");
    // Run again: the risk on file has had its draft; nothing is drafted.
    const again = await featureStage(root, CHANGE, { runtime: rt, now: NOW });
    expect(again).toMatchObject({ state: "done", drafts: 0 });
  });
});

describe("a fix to a file the stage renders (2)", () => {
  async function stuck() {
    const root = await estateRoot();
    const rt = assistant([ASKS], { true: () => TRUE_FINDING }, []);
    expect((await featureStage(root, CHANGE, { runtime: rt, now: NOW })).state).toBe("questions");
    expect((await loopOf(root)).source).toBe("feature.yaml");
    const s = await gateStatus(root, CHANGE, "define");
    const id = s.findings.find((f) => f.finding.rule === "flow-use-matches-estate")!.finding.id;
    return { root, id };
  }
  const refused = async (p: Promise<unknown>) => {
    const e = await p.then(
      () => undefined,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(CriticError);
    return (e as CriticError).message;
  };

  it("refuses a patch to feature.md, naming feature.yaml, the file it is rendered from", async () => {
    const { root, id } = await stuck();
    const patch = ["--- a/feature.md", "+++ b/feature.md", "@@ -4 +4 @@", "-x", "+y", ""].join(
      "\n",
    );
    const m = await refused(act(root, CHANGE, id, "edit-and-apply", { by: "pat", edit: patch }));
    expect(m).toContain("feature.md is written by the feature stage from feature.yaml");
    expect(m).toContain("atticus change feature add-fraud-check");
  });

  it("refuses to record a hand edit of feature.md alone; one of feature.yaml is recorded", async () => {
    const { root, id } = await stuck();
    const md = join(root, REL, "feature.md");
    await writeFile(
      md,
      (await readFile(md, "utf8")).replace("by order id", "by order id and version"),
    );
    const m = await refused(
      act(root, CHANGE, id, "edit-and-apply", { by: "pat", reason: "Keyed by version." }),
    );
    expect(m).toContain("feature.md is written by the feature stage from feature.yaml");
    const yml = join(root, REL, "feature.yaml");
    await writeFile(
      yml,
      (await readFile(yml, "utf8")).replace("by order id", "by order id and the data version"),
    );
    const ok = await act(root, CHANGE, id, "edit-and-apply", {
      by: "pat",
      reason: "Keyed by version.",
    });
    expect(ok.message).toContain("feature.yaml");
  });
});

describe("questions over the stop's cap (4)", () => {
  it("are kept in the loop file by their words, and the stop names them", async () => {
    const root = await estateRoot({ policy: "schemaVersion: 1\nquestionsPerStop: 1\n" });
    const three = FIXED.replace(
      "questions: []",
      [
        "questions:",
        "  - question: Should an order the screen can't reach be refused?",
        `    evidence: [${REL}/brief.md:9]`,
        "  - question: How long is a verdict kept?",
        `    evidence: [${REL}/brief.md:14]`,
        "  - question: Who reads a refused order's verdict?",
        `    evidence: [${REL}/brief.md:10]`,
      ].join("\n"),
    );
    const r = await featureStage(root, CHANGE, {
      runtime: assistant([three], {}, []),
      now: NOW,
    });
    expect(r.state).toBe("questions");
    expect(r.questions).toHaveLength(1);
    expect(r.moreQuestions).toBe(2);
    expect((await loopOf(root)).waiting).toEqual([
      { question: "How long is a verdict kept?", evidence: [`${REL}/brief.md:14`] },
      { question: "Who reads a refused order's verdict?", evidence: [`${REL}/brief.md:10`] },
    ]);
    const end = stageEnd(r, `atticus change feature ${CHANGE}`).join("\n");
    expect(end).toContain("2 more questions wait; they are asked once these are answered:");
    expect(end).toContain("  - How long is a verdict kept?");
  });
});

describe("a critic finding left out (7)", () => {
  it("is said in the stage's notes, and a short quote on its cited line is kept", async () => {
    const root = await estateRoot();
    // The summary is line 4 of feature.md; "for an hour" is on it, word for word.
    const short = `findings:
  - rule: flow-use-matches-estate
    artifact: feature.md
    summary: The verdict is cached for an hour with no way to clear it.
    why: A verdict the screen withdraws is still served.
    fix: Say how a cached verdict is cleared.
    evidence:
      - { path: feature.md, line: 4, quote: "for an hour" }
  - rule: flow-use-matches-estate
    artifact: feature.md
    summary: The verdict is cached by the wrong key.
    why: x
    evidence:
      - { path: feature.md, quote: "by id" }
`;
    const prompts: string[] = [];
    let n = 0;
    const r = await featureStage(root, CHANGE, {
      runtime: assistant([FIXED], { true: () => (n++ === 0 ? short : "findings: []") }, prompts),
      now: NOW,
    });
    expect(r.state).toBe("done");
    expect(handBacks(prompts[1]!)).toContain(
      "The verdict is cached for an hour with no way to clear it.",
    );
    expect(r.notes.join("\n")).toContain(
      "The critic's true lens gave a finding Atticus couldn't check, so it was left out: \"The verdict is cached by the wrong key.\"",
    );
  });
});

describe("a standard named as a request (8)", () => {
  it("is a standard to follow, not a request to raise", () => {
    const a = StoriesAnswerSchema.parse({
      stories: [],
      requests: [
        {
          item: "audit-logging-standard",
          flow: "forge-orders.place-order",
          step: 1,
          why: "The screen's verdict is logged.",
          quote: "a service writes an audit record",
        },
      ],
    });
    const issues = checkStories(a, [], [], [], {
      standards: new Set(["audit-logging-standard"]),
    });
    expect(issues.map((i) => i.rule)).toContain("stories.standard-as-request");
    expect(issues.map((i) => i.rule)).not.toContain("stories.unknown-request");
    expect(issues.find((i) => i.rule === "stories.standard-as-request")!.message).toContain(
      "audit-logging-standard is a standard to follow, not a request to raise",
    );
  });
});

// ---- the C-join estate the facts make, with an outside system's call added (5, 6)

const ESTATE = join(HERE, "../../../fixtures/estate-facts");
const REPOS = ["forge-web", "forge-customers", "forge-ledger"];
let op: OrgPack;
let facts: Estate;
beforeAll(async () => {
  op = await loadOrgPack(join(ESTATE, "org-pack"));
  const factsOf = (repo: string): Fact[] => {
    let t = readFileSync(join(ESTATE, "facts", `${repo}.jsonl`), "utf8");
    if (repo === "forge-customers")
      t += readFileSync(join(ESTATE, "outside", `${repo}.jsonl`), "utf8");
    const r = parseFacts(t);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    return r.facts;
  };
  const est = estateFromFacts({ op, repos: REPOS.map((repo) => ({ repo, facts: factsOf(repo) })) });
  facts = estateOf(
    est.records,
    est.specs.flatMap((s) => s.flows.map((flow) => ({ repo: s.repo, flow }))),
  );
});

const delta = (d: Record<string, unknown>) => FlowDelta.parse({ schemaVersion: 2, ...d });
const callOut = (to: Record<string, unknown>) =>
  delta({
    flow: "customers-api.create-a-customer",
    repo: "forge-customers",
    change: "modify",
    why: "A summary of the customer is written",
    steps: [{ op: "add", after: 1, kind: "call-out", what: "The model writes a summary", to }],
  });
const placement = FeaturePlacement.parse({
  schemaVersion: 1,
  change: "customer-summary",
  entry: "brief",
  summary: "A customer gets a summary.",
  flows: [{ id: "customers-api.create-a-customer", why: "It creates the customer" }],
});
const rules = (d: FlowDelta) =>
  checkDeltas([d], facts, placement, [])
    .filter((i) => i.rule.startsWith("delta.unknown-") || i.rule === "delta.entry-uncited")
    .map((i) => i.rule);

describe("an outside system a call fact names (5)", () => {
  it("is a call-out's target, with the entry the call fact gives", () => {
    expect(rules(callOut({ component: "llm", entry: "POST /v1/messages" }))).toEqual([]);
    // An entry no call fact gives is for a person to confirm, never refused.
    expect(rules(callOut({ component: "llm", entry: "POST /v1/embeddings" }))).toEqual([
      "delta.entry-uncited",
    ]);
    // The estate's own step names the vendor it can't resolve; a target flow may name it too.
    expect(
      rules(callOut({ component: "unresolved.c-risk-score", entry: "POST /v2/score" })),
    ).toEqual([]);
    // A name nothing gives is still refused.
    expect(rules(callOut({ component: "nowhere", entry: "POST /x" }))).toEqual([
      "delta.unknown-component",
    ]);
  });

  it("is in the estate index the drafter reads", () => {
    expect(estateIndex(facts)).toContain(
      "outside system llm: called by customers-api at POST /v1/messages",
    );
  });
});

describe("design.md's interface changes (6)", () => {
  const view = (to: Record<string, unknown>) =>
    interfaceChanges(
      [
        delta({
          flow: "web-app.add-a-customer",
          repo: "forge-web",
          change: "modify",
          why: "The new customer is shown",
          steps: [{ op: "add", after: 2, kind: "call-out", what: "The customer is read", to }],
        }),
      ],
      facts,
    ).map((i) => [i.operation, i.status]);

  it("says an entry the catalog has is existing, and only a new one planned-new", () => {
    expect(view({ component: "customers-api", entry: "GET /api/customers/{id}" })).toEqual([
      ["GET /api/customers/{id}", "existing"],
    ]);
    expect(
      view({ component: "customers-api", entry: "GET /api/customers/{id}/summary", new: true }),
    ).toEqual([["GET /api/customers/{id}/summary", "planned-new"]]);
  });
});
