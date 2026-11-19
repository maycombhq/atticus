import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import {
  Finding,
  parseRecord,
  recordPath,
  serializeRecord,
  toCanonicalYaml,
} from "@maycombhq/core";
import { loadChangeContext } from "@maycombhq/changes";
import { act } from "@maycombhq/naysayer";
import {
  EXPAND_AGENT,
  featureStage,
  FlowDelta,
  issueFingerprint,
  loadEstate,
  renderArchitecture,
  renderStoryFile,
  StoriesAnswerSchema,
  taskPromptFiles,
  type Accepted,
  type DeltaStory,
} from "../src/index.js";

/**
 * ADR 0203 A, the later stages and the drafter take what a person accepted: design.md lists a
 * consumer the draft leaves out as not affected; a task in a new folder says so and creates it;
 * a story file says which field has no criterion and who accepted that; the drafter is told the
 * acceptances as data; and a constitution rule is never accepted. Invented Forge names; a mock
 * model; no network.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "../../../fixtures");
const HOLD = join(FIX, "stages/hold-stock");
const NOW = new Date("2026-11-19T09:00:00Z");

const accepted = (
  rule: string,
  target: string,
  message: string,
  stage = "architecture",
): Accepted => ({
  finding: `stage-${issueFingerprint(rule, target)}`,
  fingerprint: issueFingerprint(rule, target),
  stage,
  rule,
  by: "pat",
  why: "Web moves off it first",
  at: "2026-11-19T10:00:00Z",
  message,
});
const byPrint = (...xs: Accepted[]) => new Map(xs.map((a) => [a.fingerprint, a]));

describe("design.md lists an accepted consumer the draft leaves out (delta.consumer-missing)", () => {
  it("as not affected, with who accepted it and why", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-accept-later-"));
    await mkdir(join(root, "org-pack"), { recursive: true });
    const rows = [
      ...(parse(readFileSync(join(FIX, "specs/catalog.yaml"), "utf8")) as unknown[]),
      ...(parse(readFileSync(join(FIX, "stages/catalog-extra.yaml"), "utf8")) as unknown[]),
      ...(parse(readFileSync(join(FIX, "stages/pin-table/catalog.yaml"), "utf8")) as unknown[]),
      ...(parse(readFileSync(join(HOLD, "catalog.yaml"), "utf8")) as unknown[]),
    ];
    for (const r of rows) {
      const p = parseRecord(r);
      if (!p.ok) throw new Error("bad fixture record");
      const f = join(root, "catalog/generated", recordPath(p.record));
      await mkdir(dirname(f), { recursive: true });
      await writeFile(f, serializeRecord(p.record));
    }
    await cp(join(FIX, "stages/specs"), join(root, "specs"), { recursive: true });
    const e = await loadEstate(root, (await loadChangeContext(root)).records);
    const marked = FlowDelta.parse({
      schemaVersion: 2,
      flow: "forge-orders.place-order",
      repo: "forge-orders",
      change: "modify",
      why: "Every order says which shop it is for.",
      steps: [
        {
          op: "change",
          step: 1,
          kind: "entry",
          fields: { reads: ["sku", "quantity", "shopId"] },
          breaking: true,
          why: "shopId is required.",
        },
      ],
    });
    expect(renderArchitecture([marked], e)).not.toContain("## Consumers not affected");
    e.acceptedFindings = byPrint(
      accepted(
        "delta.consumer-missing",
        "forge-orders.place-order",
        "Flow … doesn't list forge-web.",
      ),
    );
    expect(renderArchitecture([marked], e)).toContain(
      [
        "## Consumers not affected",
        "",
        "- forge-web (of forge-orders.place-order): not affected, accepted by pat: Web moves off it first.",
      ].join("\n"),
    );
  });
});

// --------------------------------------------------------------------------- the story file

const ONCE = join(FIX, "stages/stories-once");
const STORIES = parse(readFileSync(join(ONCE, "stories.yaml"), "utf8")) as DeltaStory[];
const words = StoriesAnswerSchema.parse(parse(readFileSync(join(ONCE, "answer.yaml"), "utf8")))
  .stories[0]!;
const NEW_FILE = "src/main/java/forge/orders/check/DeliverBy.java";
/** Task 1.2's code goes in a new file, in a folder forge-orders doesn't have yet. */
const story: DeltaStory = {
  ...STORIES[0]!,
  tasks: STORIES[0]!.tasks.map((t) =>
    t.id === "1.2" ? { ...t, placed: "new", newFile: `forge-orders:${NEW_FILE}`, evidence: [] } : t,
  ) as DeltaStory["tasks"],
};
/** The lines under a task's heading in a story file, to the next heading. */
const under = (md: string, task: string) => {
  const lines = md.split("\n");
  const at = lines.findIndex((l) => l.startsWith(`### Task ${task}:`));
  const end = lines.findIndex((l, i) => i > at && /^#{2,3} /.test(l));
  return lines.slice(at + 1, end);
};

describe("a story file takes what a person accepted", () => {
  it("an accepted new folder: the task says the folder is new and creates it, in its prompt too", () => {
    const x = {
      accepted: [
        accepted(
          "delta.new-folder",
          "forge-orders.place-order#2:new",
          `Change 2 to forge-orders.place-order puts the new code in a new file ${NEW_FILE}, but forge-orders has no folder src/main/java/forge/orders/check: name the file in the folder of its nearest kin, the repo's own layout.`,
        ),
      ],
    };
    const line =
      "- New folder: src/main/java/forge/orders/check, in forge-orders: create it (accepted by pat: Web moves off it first).";
    expect(under(renderStoryFile("add-deliver-by", story, words, [], x), "1.2")).toContain(line);
    expect(under(renderStoryFile("add-deliver-by", story, words), "1.2")).not.toContain(line);
    const prompt = Object.entries(taskPromptFiles("add-deliver-by", story, words, x)).find(([p]) =>
      p.includes("1.2"),
    )![1];
    expect(prompt).toContain(line);
  });

  it("accepted criteria findings: 'No criterion for <field>: accepted by <who>: <why>.' under the task", () => {
    const x = {
      accepted: [
        accepted(
          "stories.field-not-checked",
          "1.3",
          "Task 1.3's criteria check no value of deliver_by: write a criterion whose then clause asserts each, and list it under that criterion's checks.",
          "stories",
        ),
        accepted(
          "stories.field-no-validation",
          "s1-deliver-by:POST /orders:deliverBy",
          "Story s1-deliver-by: POST /orders gains or changes the request field deliverBy but says nothing it accepts: add its validation (required, format, length or range, and what is refused).",
          "stories",
        ),
        accepted(
          "stories.field-no-error-case",
          "s1-deliver-by:POST /orders:deliverBy",
          "Story s1-deliver-by: no criterion says what happens when deliverBy, a request field POST /orders gains or changes, is wrong: add one with outcome: error that checks deliverBy, saying the status and message the caller sees.",
          "stories",
        ),
        accepted(
          "stories.shape-uncovered",
          "stories-shape.yaml",
          'Story s1-deliver-by "A client places an order" has no task yet: put under it the tasks of its repo that do what it says.',
          "stories",
        ),
      ],
    };
    const md = renderStoryFile("add-deliver-by", story, words, [], x);
    expect(under(md, "1.3")).toContain(
      "- No criterion for deliver_by: accepted by pat: Web moves off it first.",
    );
    // A story's field is said under the first task that carries it.
    expect(under(md, "1.1")).toContain(
      "- No criterion for deliverBy's validation: accepted by pat: Web moves off it first.",
    );
    expect(under(md, "1.1")).toContain(
      "- No criterion for deliverBy's error case: accepted by pat: Web moves off it first.",
    );
    expect(md).toContain("No task for this story: accepted by pat: Web moves off it first.");
    expect(renderStoryFile("add-deliver-by", story, words)).not.toContain("No criterion for");
  });
});

// --------------------------------------------------------------- the drafter, and who accepts

const MANIFEST = `schemaVersion: 1
platform: forge
repos:
  - id: forge-orders
    url: https://git.example.com/forge/forge-orders.git
    type: spring-boot
    owner: team-orders
`;
async function estateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-accept-later-"));
  await mkdir(join(root, "org-pack/profiles/forge"), { recursive: true });
  await writeFile(join(root, "org-pack/profiles/forge/repos.manifest.yaml"), MANIFEST);
  const rows = [
    ...(parse(readFileSync(join(FIX, "specs/catalog.yaml"), "utf8")) as unknown[]),
    ...(parse(readFileSync(join(FIX, "stages/catalog-extra.yaml"), "utf8")) as unknown[]),
  ];
  for (const r of rows) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error("bad fixture record");
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(join(FIX, "stages/specs"), join(root, "specs"), { recursive: true });
  await cp(join(FIX, "stages/changes"), join(root, "openspec/changes"), { recursive: true });
  return root;
}
const CHANGE = "add-fraud-check";
const placed = `summary: Every new order is screened by Northwind Pay before stock is reserved.
features:
  - { id: cap-ordering, why: Placing an order gains the screen. }
flows:
  - { id: forge-orders.place-order, how: changed, why: The screen runs before stock is reserved. }
newFlows:
  - { name: Screening queue, repo: forge-screening, why: The screen needs a queue. }
`;

describe("the drafter is told what people accepted, as data", () => {
  it("in a data block of its own, with an instruction that it is no problem to fix", async () => {
    const root = await estateRoot();
    const prompts: string[] = [];
    const runtime = new MockRuntime(
      (req: AiRequest) => {
        if (req.agent.id.endsWith("-critic")) return "findings: []";
        if (req.agent.id === EXPAND_AGENT) return "terms: []\nnames: []\n";
        prompts.push(req.pack.prompt);
        return placed;
      },
      { now: () => NOW },
    );
    await featureStage(root, CHANGE, { runtime, now: NOW });
    const id = `stage-${issueFingerprint("feature.unknown-repo", "Screening queue:forge-screening")}`;
    const why = "The screening repo is created this week";
    await act(root, CHANGE, id, "waive", { by: "pat", reason: why });
    prompts.length = 0;
    await featureStage(root, CHANGE, { runtime, now: NOW, force: true });
    expect(prompts.length).toBeGreaterThan(0);
    const p = prompts[0]!;
    const block = /<atticus-data id="accepted-by-people"[^>]*>\n([\s\S]*?)\n<\/atticus-data>/.exec(
      p,
    );
    expect(block?.[1]).toContain(
      `- feature.unknown-repo (Screening queue:forge-screening), accepted by pat: ${why}.`,
    );
    // The reason is only ever data: never in the trusted text before the data blocks.
    expect(p.slice(0, p.indexOf("<atticus-data id="))).not.toContain(why);
    expect(p).toContain(
      'People accepted findings of this stage; the "accepted-by-people" data block lists each with who and why. They are not problems to fix and not questions to ask: leave what each is about as it is.',
    );
  });
});

describe("a constitution rule is never accepted", () => {
  it("is refused, saying so, whatever gate its finding is on", async () => {
    const root = await estateRoot();
    for (const gate of ["stage-architecture", "design"]) {
      const f = Finding.parse({
        schemaVersion: 1,
        id: `c-${gate}`,
        kind: "issue",
        change: CHANGE,
        gate,
        round: 1,
        rule: "no-plaintext-secrets",
        layer: "constitution",
        lens: "safe",
        severity: "blocking",
        artifact: "target-flows/",
        locator: { heading: "forge-orders.place-order#2" },
        summary: "A secret is written in plain text.",
        why: "Rule 6.",
        fix: { text: "Keep it in the vault." },
        evidence: [{ source: "artifact", path: "target-flows/" }],
        waivable: false,
        createdAt: "2026-11-19T09:00:00Z",
      });
      const dir = join(root, "openspec/changes", CHANGE, "review", gate, "1");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${f.id}.yaml`), toCanonicalYaml(f, ["schemaVersion", "id"]));
      await expect(
        act(root, CHANGE, f.id, "waive", { by: "pat", reason: "We know better.", gate }),
      ).rejects.toThrow(
        `${f.id} comes from a constitution rule (no-plaintext-secrets), which can never be waived or accepted (rule 6). Fix it.`,
      );
    }
  });
});
