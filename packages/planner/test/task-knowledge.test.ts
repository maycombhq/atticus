import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import {
  MockRuntime,
  quantize,
  type AiRequest,
  type Embedder,
  type EmbedKind,
  type QuantVector,
} from "@maycombhq/ai";
import {
  answerQuestion,
  listQuestions,
  parseRecord,
  recordPath,
  serializeRecord,
} from "@maycombhq/core";
import { CONFLICT_STEP } from "@maycombhq/knowledge";
import {
  askKnowledgeConflicts,
  groupNearDuplicates,
  KEEP_BY_MEANING,
  nearDuplicates,
  rankPages,
  readKnowledgeApplies,
  renderTaskContext,
  setKnowledgeStatus,
  smallStage,
  storyKnowledgeLines,
  taskContext,
  wordsOnlyNote,
  type KnowledgePlace,
  type TaskKnowledge,
} from "../src/index.js";

/**
 * Knowledge per task and per story (ADR 0124 addendum B-task-knowledge). A change adds SSO to
 * placing an order in the invented forge-orders. The Forge wiki has two SSO setup pages that
 * disagree on the redirect URI, a quick start that agrees with the first, a standard on token
 * claims and an order events pattern no SSO task needs (fixtures/stages/sso). The SSO task's
 * context lists the how-to (also on the quick start) and the standard, never the pattern; the
 * disagreement is one question to a person; once answered, the task shows the chosen page and
 * marks the other.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "../../../fixtures");
const SSO = join(FIX, "stages/sso");
const NOW = new Date("2026-10-24T09:00:00Z");
const CHANGE = "add-sso";

async function writeRecords(root: string, dir: string, file: string): Promise<void> {
  for (const r of parse(readFileSync(file, "utf8")) as unknown[]) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(`bad fixture record: ${JSON.stringify(p.issues)}`);
    const f = join(root, dir, recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
}

/** The shop's estate, the SSO wiki snapshot, its items and scan, and the change planned. */
async function planned(o: { before?: (root: string) => Promise<void> } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-taskkn-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  await writeRecords(root, "catalog/generated", join(FIX, "specs/catalog.yaml"));
  await writeRecords(root, "catalog/generated", join(FIX, "stages/catalog-extra.yaml"));
  await writeRecords(root, "knowledge/items", join(SSO, "knowledge.yaml"));
  await cp(join(SSO, "snapshots"), join(root, "knowledge/snapshots"), { recursive: true });
  await cp(join(SSO, "scan.yaml"), join(root, "knowledge/scan.yaml"));
  await cp(join(FIX, "stages/specs"), join(root, "specs"), { recursive: true });
  await cp(join(SSO, CHANGE), join(root, "openspec/changes", CHANGE), { recursive: true });
  await o.before?.(root);
  const answer = readFileSync(join(SSO, "answer.yaml"), "utf8");
  const runtime = new MockRuntime(
    (req: AiRequest) => (req.agent.id.endsWith("-critic") ? "findings: []" : answer),
    { now: () => NOW },
  );
  expect((await smallStage(root, CHANGE, { runtime, now: NOW })).state).toBe("done");
  return root;
}

const conflictQuestions = async (root: string) =>
  (await listQuestions(root, { step: CONFLICT_STEP })).questions;

describe("knowledge per task (B-task-knowledge)", () => {
  it("lists the how-to and the standard for the SSO task, never the unrelated pattern", async () => {
    const root = await planned();
    const c = await taskContext(root, CHANGE, "1.1");
    const ids = c.knowledge.map((k) => k.id);
    expect(ids).toContain("sso-setup");
    expect(ids).toContain("sso-token-claims");
    expect(ids).not.toContain("order-events-topic");
    // The pages an item is read from are shown through the item, not again as sections.
    expect(ids.filter((i) => i.startsWith("forge-wiki/"))).toEqual([]);
    const how = c.knowledge.find((k) => k.id === "sso-setup")!;
    expect(how).toMatchObject({
      kind: "ProcessDefinition",
      knowledgeKind: "process",
      title: "Set up SSO for a Forge service",
      page: {
        source: "forge-wiki",
        page: "sso-setup.md",
        section: "Steps",
        line: 6,
        anchor: "sso-setup.md#steps",
      },
      alsoOn: [
        {
          source: "forge-wiki",
          page: "sso-quickstart.md",
          section: "Redirect URI",
          line: 5,
          anchor: "sso-quickstart.md#redirect-uri",
        },
      ],
      steps: [
        "Register the service as a client in Forge Identity and note its client id.",
        "Set the redirect URI to /login/oauth2/code/forge-identity.",
        "Read the client secret from the Forge vault at start-up, never from a file in the repo.",
        "Check the signature of every token against the Forge Identity keys before reading its claims.",
      ],
    });
    expect(how.why).toMatch(/sso/i);
    const std = c.knowledge.find((k) => k.id === "sso-token-claims")!;
    expect(std).toMatchObject({ knowledgeKind: "standard", page: { section: "Required claims" } });
    expect(std.says).toContain(
      "A service that accepts Forge SSO tokens refuses a token whose aud claim doesn't name the service.",
    );
  });

  it("asks a person once which page applies, quoting both pages, and shows the disagreement as open", async () => {
    const root = await planned();
    const qs = await conflictQuestions(root);
    expect(qs).toHaveLength(1);
    expect(qs[0]).toMatchObject({ repo: CHANGE, state: "open" });
    expect(qs[0]!.question).toContain(
      'forge-wiki/sso-notes.md (last edited 2026-03-02) says "Set the redirect URI to /sso/callback."',
    );
    // The signal the scan recorded is named as a suggestion; the person still decides.
    expect(qs[0]!.question).toContain(
      "Suggested: forge-wiki/sso-setup.md, by last-edited (sso-setup.md was last edited 2026-09-14, after sso-notes.md (2026-03-02)); a suggestion only.",
    );
    expect(qs[0]!.options.map((o) => o.label)).toEqual([
      "forge-wiki/sso-setup.md applies",
      "forge-wiki/sso-notes.md applies",
      "Both, in different cases",
    ]);
    const how = (await taskContext(root, CHANGE, "1.1")).knowledge.find(
      (k) => k.id === "sso-setup",
    )!;
    expect(how.conflicts).toEqual([
      expect.objectContaining({ state: "open", question: qs[0]!.id }),
    ]);
    // Asked again (a rerun, the change's knowledge list, the task context): not asked twice.
    const again = await askKnowledgeConflicts(root, CHANGE, {
      command: "atticus change knowledge add-sso",
      rerun: "atticus change knowledge add-sso",
      at: "2026-10-24T11:00:00Z",
    });
    expect(again.raised).toEqual([]);
    expect(again.open.map((q) => q.id)).toEqual([qs[0]!.id]);
    expect(await conflictQuestions(root)).toHaveLength(1);
  });

  it("shows the chosen page once a person answers, and marks the other as disagreeing and not used", async () => {
    const root = await planned();
    const q = (await conflictQuestions(root))[0]!;
    await answerQuestion(root, q.id, { option: 1, by: "sam", at: "2026-10-24T10:00:00Z" });
    const c = await taskContext(root, CHANGE, "1.1");
    const how = c.knowledge.find((k) => k.id === "sso-setup")!;
    expect(how.conflicts).toEqual([
      expect.objectContaining({
        state: "answered",
        by: "answered by sam",
        pages: [
          expect.objectContaining({ page: "sso-setup.md", applies: true }),
          expect.objectContaining({
            page: "sso-notes.md",
            section: "Steps",
            line: 6,
            says: "Set the redirect URI to /sso/callback.",
            applies: false,
          }),
        ],
      }),
    ]);
    const md = renderTaskContext(c);
    expect(md).toBe(readFileSync(join(SSO, "expected/task-context.md"), "utf8"));
    // Not asked again after the answer.
    await askKnowledgeConflicts(root, CHANGE, {
      command: "atticus change knowledge add-sso",
      rerun: "atticus change knowledge add-sso",
      at: "2026-10-24T11:00:00Z",
    });
    expect(await conflictQuestions(root)).toHaveLength(1);
  });

  it("shows the other page as what applies when the person chooses it", async () => {
    const root = await planned();
    const q = (await conflictQuestions(root))[0]!;
    await answerQuestion(root, q.id, { option: 2, by: "sam", at: "2026-10-24T10:00:00Z" });
    const md = renderTaskContext(await taskContext(root, CHANGE, "1.1"));
    expect(md).toContain(
      '- Applies instead (answered by sam): forge-wiki/sso-notes.md#steps, line 6: "Set the redirect URI to /sso/callback."',
    );
    expect(md).toContain(
      '- Disagrees, not used (answered by sam): forge-wiki/sso-setup.md#steps, line 6: "Set the redirect URI to /login/oauth2/code/forge-identity."',
    );
  });

  it("writes the knowledge per task in the story file and the tasks into the change's list", async () => {
    const root = await planned();
    const dir = join(root, "openspec/changes", CHANGE);
    const story = await readFile(join(dir, "stories/s1-place-order.md"), "utf8");
    const at = story.indexOf("### Task 1.1");
    const from = story.indexOf("- Knowledge that applies:", at);
    expect(from).toBeGreaterThan(at);
    const section = story.slice(from, story.indexOf("- Acceptance criteria:", from));
    expect(section).toMatch(
      /\n {2}- Set up SSO for a Forge service \(process\), forge-wiki\/sso-setup\.md#steps, line 6 \(updated 2026-09-14\): It is about .*"SSO".*, which this task changes\.\n {4}- Also described on forge-wiki\/sso-quickstart\.md#redirect-uri, line 5 \(updated 2026-08-01\)\.\n {4}- Pages disagree on the redirect URI: forge-wiki\/sso-setup\.md says "Set the redirect URI to \/login\/oauth2\/code\/forge-identity\."; forge-wiki\/sso-notes\.md says "Set the redirect URI to \/sso\/callback\."\. A person decides which applies \(question q-[0-9a-f]{12}\)\. Suggested, not decided: forge-wiki\/sso-setup\.md, by last-edited: .*\n/,
    );
    expect(section).toMatch(
      /\n {2}- SSO tokens carry the claims a service checks \(standard\), forge-wiki\/token-claims-standard\.md#required-claims, line 5 \(updated 2026-07-10\): It is about .*"claims".*, which this task changes\.\n/,
    );
    expect(story).not.toContain("order-events-topic");
    expect(story).not.toContain("Order changes are published as events");
    const list = await readKnowledgeApplies(root, CHANGE);
    expect(list?.items.find((i) => i.id === "sso-setup")).toMatchObject({ tasks: ["1.1"] });
    expect(list?.items.find((i) => i.id === "sso-token-claims")).toMatchObject({ tasks: ["1.1"] });
  });

  it("never shows an item the change excluded", async () => {
    const root = await planned();
    await setKnowledgeStatus(root, CHANGE, "sso-token-claims", "excluded");
    const c = await taskContext(root, CHANGE, "1.1");
    expect(c.knowledge.map((k) => k.id)).not.toContain("sso-token-claims");
    expect(c.knowledge.map((k) => k.id)).toContain("sso-setup");
  });

  it("boosts an item the change confirmed: it reaches the task on fewer words", async () => {
    const root = await planned();
    // The order events pattern shares only the flow's words with the task; confirmed for the
    // change, it is listed, marked so.
    await setKnowledgeStatus(root, CHANGE, "order-events-topic", "confirmed");
    const c = await taskContext(root, CHANGE, "1.1");
    expect(c.knowledge.find((k) => k.id === "order-events-topic")).toMatchObject({
      confirmed: true,
    });
  });

  it("asks nothing when code verified in the repo settles it, and says so with the fact", async () => {
    // forge-orders' config registers the redirect endpoint sso-setup.md names: a fact verified
    // from code, which no page overrides.
    const root = await planned({
      before: async (r) => {
        const f = join(r, "catalog/generated", recordPath(REDIRECT as never));
        await mkdir(dirname(f), { recursive: true });
        await writeFile(f, serializeRecord(REDIRECT as never));
      },
    });
    expect(await conflictQuestions(root)).toEqual([]);
    const c = await taskContext(root, CHANGE, "1.1");
    expect(c.knowledge.find((k) => k.id === "sso-setup")!.conflicts).toEqual([
      expect.objectContaining({ state: "code" }),
    ]);
    const md = renderTaskContext(c);
    expect(md).toContain(
      '- Disagrees, not used (settled by the code: Endpoint forge-orders.get-login-oauth2-code-forge-identity has /login/oauth2/code/forge-identity, verified from code at forge-orders:src/main/resources/application.yml:12): forge-wiki/sso-notes.md#steps, line 6: "Set the redirect URI to /sso/callback."',
    );
  });

  it("leads with the newest of the pages that say the same, the others as also", async () => {
    const root = await planned({
      before: async (r) => {
        const f = join(r, "knowledge/snapshots/forge-wiki/2026-10-20/snapshot.yaml");
        await writeFile(f, readFileSync(f, "utf8").replace("date: 2026-08-01", "date: 2026-10-02"));
      },
    });
    const how = (await taskContext(root, CHANGE, "1.1")).knowledge.find(
      (k) => k.id === "sso-setup",
    )!;
    expect(how.page).toMatchObject({ page: "sso-quickstart.md", updated: "2026-10-02" });
    expect(how.alsoOn).toEqual([
      expect.objectContaining({ page: "sso-setup.md", updated: "2026-09-14" }),
    ]);
  });

  it("names each page's author and owner when the page says, and its path in the snapshot", async () => {
    const root = await planned({
      before: async (r) => {
        const f = join(r, "knowledge/snapshots/forge-wiki/2026-10-20/token-claims-standard.md");
        await writeFile(
          f,
          `---\nauthor: kim\nowner: Identity team\n---\n${readFileSync(f, "utf8")}`,
        );
      },
    });
    const std = (await taskContext(root, CHANGE, "1.1")).knowledge.find(
      (k) => k.id === "sso-token-claims",
    )!;
    expect(std.page).toMatchObject({
      author: "kim",
      owner: "Identity team",
      updated: "2026-07-10",
      pageTitle: "Token claims standard",
      file: "knowledge/snapshots/forge-wiki/2026-10-20/token-claims-standard.md",
    });
    expect(storyKnowledgeLines([std])[1]).toContain(
      "(updated 2026-07-10 by kim, owner Identity team)",
    );
    expect(std.matched.terms).toEqual(expect.arrayContaining(["SSO", "claims"]));
  });
});

/** A fact verified from code: forge-orders' OAuth redirect endpoint (invented, Forge). */
const REDIRECT = {
  kind: "Endpoint",
  schemaVersion: 2,
  id: "forge-orders.get-login-oauth2-code-forge-identity",
  status: "current",
  confidence: "verified",
  evidence: [
    {
      source: "config",
      repo: "forge-orders",
      path: "src/main/resources/application.yml",
      line: 12,
    },
  ],
  component: "forge-orders",
  endpointType: "rest",
  method: "GET",
  pathOrTopic: "/login/oauth2/code/forge-identity",
  normalizedPath: "/login/oauth2/code/forge-identity",
};

const place = (page: string, o: Partial<KnowledgePlace> = {}): KnowledgePlace => ({
  source: "forge-wiki",
  page,
  section: "Steps",
  anchor: `${page}#steps`,
  ...o,
});

const entry = (id: string, o: Partial<TaskKnowledge> = {}): TaskKnowledge => ({
  id,
  kind: "ProcessDefinition",
  knowledgeKind: "process",
  title: "Set up SSO for a Forge service",
  why: "",
  says: [],
  alsoOn: [],
  conflicts: [],
  matched: { terms: [], places: [] },
  verified: false,
  score: 1,
  line: id,
  ...o,
});

describe("several pages on one topic", () => {
  it("ranks pages: verified, then newest, then owned, then the closest match", () => {
    const r = (p: KnowledgePlace, text = "") => ({ place: p, text });
    const pages = (xs: ReturnType<typeof r>[], words: string[] = []) =>
      rankPages(xs, words).map((p) => p.page);
    expect(
      pages([r(place("new.md", { updated: "2026-10-01" })), r(place("ok.md", { verified: true }))]),
    ).toEqual(["ok.md", "new.md"]);
    expect(
      pages([
        r(place("old.md", { updated: "2026-01-01" })),
        r(place("new.md", { updated: "2026-10-01" })),
      ]),
    ).toEqual(["new.md", "old.md"]);
    expect(pages([r(place("a.md")), r(place("owned.md", { owner: "Identity team" }))])).toEqual([
      "owned.md",
      "a.md",
    ]);
    expect(
      pages(
        [r(place("a.md"), "set up"), r(place("b.md"), "the redirect uri for sso")],
        ["sso", "redirect"],
      ),
    ).toEqual(["b.md", "a.md"]);
  });

  it("groups near-duplicates: the best leads, the others' pages are also, their ids sameAs", () => {
    const grouped = groupNearDuplicates([
      entry("sso-setup", { page: place("sso-setup.md", { updated: "2026-09-14" }), score: 3 }),
      entry("sso-claims", {
        kind: "Pattern",
        knowledgeKind: "standard",
        title: "SSO tokens carry the claims a service checks",
        score: 2,
      }),
      entry("sso-setup-2", {
        title: "Set up SSO for Forge services",
        page: place("sso-howto.md", { updated: "2026-10-01" }),
        alsoOn: [place("sso-setup.md", { updated: "2026-09-14" })],
        score: 1,
      }),
    ]);
    expect(grouped.map((k) => k.id)).toEqual(["sso-setup-2", "sso-claims"]);
    expect(grouped[0]).toMatchObject({
      page: { page: "sso-howto.md" },
      alsoOn: [expect.objectContaining({ page: "sso-setup.md" })],
      sameAs: ["sso-setup"],
      score: 3,
    });
    // A different kind is never a duplicate, whatever its words.
    expect(nearDuplicates(entry("a"), entry("b", { knowledgeKind: "standard" }))).toBe(false);
  });
});

// ADR 0132 addendum: keeping a task's knowledge by words and meaning. The acronym fixture
// (fixtures/stages/sso-acronym): the step says "single sign-on", the how-to it needs only "SSO"
// (no word in common, no glossary alias); another item shares one common word ("shopper").
const ACRONYM = join(FIX, "stages/sso-acronym");
const ACRONYM_CHANGE = "sign-in-to-order";

/**
 * A stand-in for the model that knows one thing: "SSO" and "single sign-on" mean the same. Each
 * text is a vector over three concepts (sign-on, history, anything else), so the test fixes what
 * is close in meaning without a model file.
 */
class ConceptEmbedder implements Embedder {
  readonly id = "concepts@1";
  readonly dim = 3;
  readonly maxTokens = 512;
  readonly backend = "mock";
  async embed(texts: string[], _kind: EmbedKind): Promise<QuantVector[]> {
    return texts.map((t) =>
      quantize([/\bSSO\b|single sign-on/i.test(t) ? 1 : 0, /history/i.test(t) ? 1 : 0, 0.05]),
    );
  }
}

async function plannedAcronym(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-taskkn-acronym-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  await writeRecords(root, "catalog/generated", join(FIX, "specs/catalog.yaml"));
  await writeRecords(root, "catalog/generated", join(FIX, "stages/catalog-extra.yaml"));
  await writeRecords(root, "knowledge/items", join(ACRONYM, "knowledge.yaml"));
  await cp(join(FIX, "stages/specs"), join(root, "specs"), { recursive: true });
  await cp(join(ACRONYM, ACRONYM_CHANGE), join(root, "openspec/changes", ACRONYM_CHANGE), {
    recursive: true,
  });
  const answer = readFileSync(join(ACRONYM, "answer.yaml"), "utf8");
  const runtime = new MockRuntime(
    (req: AiRequest) => (req.agent.id.endsWith("-critic") ? "findings: []" : answer),
    { now: () => NOW },
  );
  expect((await smallStage(root, ACRONYM_CHANGE, { runtime, now: NOW })).state).toBe("done");
  return root;
}

describe("keeping a task's knowledge by words and meaning (ADR 0132 addendum)", () => {
  it("without the meaning model, keeps by words as before and says so in the task context", async () => {
    const root = await plannedAcronym();
    const c = await taskContext(root, ACRONYM_CHANGE, "1.1");
    const ids = c.knowledge.map((k) => k.id);
    // One common word kept it before, and still does without a model: nothing changes.
    expect(ids).toContain("order-history-years");
    expect(ids).not.toContain("sso-login-gate");
    expect(c.knowledge.every((k) => k.matched.meaning === undefined)).toBe(true);
    expect(c.notes).toContain(
      "Knowledge matched by words only: ATTICUS_EMBEDDINGS is off for this process.",
    );
    expect(renderTaskContext(c)).toContain(
      "- Knowledge matched by words only: ATTICUS_EMBEDDINGS is off for this process.",
    );
    expect(
      wordsOnlyNote(
        "similar in meaning is off: the bundled model (@maycombhq/embed-model) isn't installed",
      ),
    ).toBe("matched by words only: the meaning model isn't installed");
  });

  it("keeps a page close in meaning that shares no word, says why with the similarity, and drops one whose only link is a common word", async () => {
    const root = await plannedAcronym();
    const embeddings = new ConceptEmbedder();
    const c = await taskContext(root, ACRONYM_CHANGE, "1.1", { embeddings });
    const ids = c.knowledge.map((k) => k.id);
    expect(ids).toContain("sso-login-gate");
    expect(ids).not.toContain("order-history-years");
    const gate = c.knowledge.find((k) => k.id === "sso-login-gate")!;
    expect(gate.why).toMatch(
      /^It is close in meaning to the task's step \("OrderController\.place takes the order only from a shopper signed in through single sign-on", similarity [01]\.\d\d\)\.$/,
    );
    expect(gate.matched.meaning).toBeGreaterThanOrEqual(KEEP_BY_MEANING);
    expect(c.notes.some((n) => /matched by words only/.test(n))).toBe(false);
    // The same files give the same list.
    const again = await taskContext(root, ACRONYM_CHANGE, "1.1", { embeddings });
    expect(again.knowledge).toEqual(c.knowledge);
    // Kept by words alone (the bench's before), it is the list without a model.
    const words = await taskContext(root, ACRONYM_CHANGE, "1.1", { embeddings, keep: "words" });
    expect(words.knowledge.map((k) => k.id)).toContain("order-history-years");
    expect(words.knowledge.map((k) => k.id)).not.toContain("sso-login-gate");
  });
});
