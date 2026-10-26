import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { main } from "../src/main.js";

/**
 * ADR 0121 addendum (2026-10-26), the Copilot agent-mode path, end to end with a stub agent.
 *
 * Nobody can sign in to Copilot in CI, so the agent's part is played here: a stub that does only
 * what `plugins/copilot/.github/agents/*.agent.md` tells an agent to do — run the Atticus command
 * that starts the step, write its result to the file the command named, run the command that
 * checks it, and fix what the check hands back. Every command runs through `main()`, so the exit
 * codes are the ones a terminal would show, and nothing calls a model or a network (CLAUDE.md
 * rule 5): the reading loop runs no model at all, and the stage runs in hand-off mode, where the
 * agent is the model.
 *
 * What this proves is the path and its checks. What it cannot prove is Copilot itself picking the
 * agent and obeying it: docs/guide/copilot-agent-mode.md has the checklist a person runs for that.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "../../../fixtures");
const VERIFY_FIX = join(HERE, "../../verify/test/fixtures");
const REPO = "forge-ledger";
const COMMIT = "0123abc";
const CHANGE = "add-fraud-check";

/** The stub agent: it runs `atticus` and reads what it prints, as the agent files say to. */
function stubAgent(root: string) {
  const ran: string[] = [];
  return {
    ran,
    /** One `atticus` command, as the agent would run it in the workspace's terminal. */
    async atticus(...argv: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
      const out: string[] = [];
      const err: string[] = [];
      ran.push(`atticus ${argv.join(" ")}`);
      const code = await main(
        [...argv, "--root", root],
        { out: (l) => out.push(l), err: (l) => err.push(l) },
        { quiet: true },
      );
      return { code, out, err };
    },
    /** A file written where the command said, at that exact path, and nowhere else. */
    async write(rel: string, text: string): Promise<void> {
      await mkdir(dirname(join(root, rel)), { recursive: true });
      await writeFile(join(root, rel), text);
    },
    read: (rel: string) => readFile(join(root, rel), "utf8"),
    there: (rel: string) => existsSync(join(root, rel)),
  };
}

// ----------------------------------------------------------- reading a repo into facts

/** A Forge repo adopted in place, as `atticus adopt` leaves it: facts under `.atticus/facts/`. */
async function adoptedForgeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-copilot-read-"));
  await cp(join(VERIFY_FIX, "repo"), root, { recursive: true });
  await mkdir(join(root, ".atticus", "org-pack"), { recursive: true });
  await mkdir(join(root, ".atticus", "facts"), { recursive: true });
  return root;
}

const FACTS = join(VERIFY_FIX, "forge-ledger.facts.jsonl");
const factLines = () => readFileSync(FACTS, "utf8").trim().split("\n");

describe("the agent reads a Forge repo into facts and loops on atticus verify", () => {
  it("writes the facts file the estimate named, fixes what verify rejected, and ends at exit 0", async () => {
    const root = await adoptedForgeRepo();
    const a = stubAgent(root);

    // 1. The step starts with Atticus, not with the agent's own reading of the repo.
    const estimate = await a.atticus("map", REPO, "--estimate", "--commit", COMMIT);
    expect(estimate.err).toEqual([]);
    expect(estimate.code).toBe(0);
    const said = estimate.out.join("\n");
    // The estimate names the facts file to write and says this is an agent-mode read.
    const factsFile = /Facts file: (\S+)/.exec(said)?.[1];
    expect(factsFile).toBe(".atticus/facts/forge-ledger.jsonl");
    expect(said).toContain("Copilot in VS Code agent mode");

    // 2. The agent writes its facts there. One of them doesn't hold: it cites a line that
    // doesn't say what the fact claims, as a read that guessed would.
    const lines = factLines();
    const wrong = JSON.parse(lines[0]!) as { id: string; cite: { value: string; quote: string } };
    wrong.id = "e-get-account-guessed";
    wrong.cite.value = "/accounts/{accountId}/balance";
    wrong.cite.quote = '@GetMapping("/accounts/{accountId}/balance")';
    await a.write(factsFile!, [...lines, JSON.stringify(wrong)].join("\n") + "\n");

    // 3. The agent runs Atticus's check, not one of its own. It finds the fact that doesn't hold.
    const first = await a.atticus("verify", REPO, "--commit", COMMIT);
    expect(first.code).toBe(1);
    expect(first.out[0]).toMatch(/17 facts kept, 1 rejected/);
    expect(first.out.join("\n")).toMatch(/run atticus verify forge-ledger again/);
    const rejected = (await a.read(".atticus/facts/forge-ledger.rejected.jsonl"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { code: string; message: string; fact: { id: string } });
    // Each rejected fact comes back with its reason, so the agent knows what to read again.
    expect(rejected.map((r) => r.fact.id)).toEqual(["e-get-account-guessed"]);
    expect(rejected[0]!.code).toBeTruthy();
    expect(rejected[0]!.message).toBeTruthy();

    // 4. The agent reads the cited line again and drops the fact the code doesn't say.
    await a.write(factsFile!, lines.join("\n") + "\n");
    const again = await a.atticus("verify", REPO, "--commit", COMMIT);
    expect(again.err).toEqual([]);
    expect(again.code).toBe(0);
    expect(again.out[0]).toMatch(/17 facts kept, 0 rejected/);
    expect(a.there(".atticus/facts/forge-ledger.rejected.jsonl")).toBe(false);

    // 5. The artifacts: the report Atticus wrote, and the facts carried with their verdict.
    const report = parse(await a.read(".atticus/facts/forge-ledger.verify.yaml")) as {
      accepted: number;
      rejected?: number;
    };
    expect(report.accepted).toBe(17);
    expect(await a.read(factsFile!)).toContain('"verified":"line"');

    // Every check the agent ran was Atticus's own.
    expect(a.ran).toEqual([
      `atticus map ${REPO} --estimate --commit ${COMMIT}`,
      `atticus verify ${REPO} --commit ${COMMIT}`,
      `atticus verify ${REPO} --commit ${COMMIT}`,
    ]);
  }, 120_000);

  it("hands a repo's description over as a draft a person confirms, never as a person's words", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-copilot-describe-"));
    await cp(join(FIXTURES, "estate/org-pack"), join(root, "org-pack"), { recursive: true });
    const a = stubAgent(root);

    // The agent read the files and hands one line over, with the lines it read it from.
    const drafted = await a.atticus(
      "repo",
      "describe",
      "forge-web",
      "--drafted",
      "The Forge web app: the pages a customer sees.",
      "--cites",
      "README.md:2",
    );
    expect(drafted.err).toEqual([]);
    expect(drafted.code).toBe(0);
    expect(drafted.out.join("\n")).toContain("unconfirmed");

    // It is a draft, marked as the assistant's, until a person confirms it (ADR 0128).
    const manifest = await a.read("org-pack/profiles/forge/repos.manifest.yaml");
    const d = (
      parse(manifest) as { repos: { id: string; description?: { trust: string; by: string } }[] }
    ).repos.find((r) => r.id === "forge-web")?.description;
    expect(d).toMatchObject({ trust: "suggested", by: "assistant" });

    // A draft with no citation is refused: the agent can't pass one off unsourced.
    const unsourced = await a.atticus(
      "repo",
      "describe",
      "forge-customers",
      "--drafted",
      "Customers.",
    );
    expect(unsourced.code).toBe(2);
    expect(unsourced.err.join("\n")).toContain("--cites");
  }, 60_000);
});

// ----------------------------------------------------------- a stage, with the critic

/** The estate the stage fixtures describe, with the lens checklists the critic runs. */
async function estateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-copilot-stage-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  await writeFile(
    join(root, "org-pack/runtime.yaml"),
    "schemaVersion: 1\nassistants: { allowed: [copilot], default: copilot }\nretrieval: { expansion: false }\n",
  );
  const rows = [
    ...(parse(readFileSync(join(FIXTURES, "specs/catalog.yaml"), "utf8")) as unknown[]),
    ...(parse(readFileSync(join(FIXTURES, "stages/catalog-extra.yaml"), "utf8")) as unknown[]),
  ];
  for (const r of rows) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(`bad fixture record: ${JSON.stringify(p.issues)}`);
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(join(FIXTURES, "stages/specs"), join(root, "specs"), { recursive: true });
  await cp(join(FIXTURES, "stages/changes"), join(root, "openspec/changes"), { recursive: true });
  await cp(join(FIXTURES, "stages/lenses/checklists"), join(root, "org-pack/checklists"), {
    recursive: true,
  });
  return root;
}

/** The draft the agent writes: a flow it marks read, which the critic's true lens disagrees with. */
const PLACED = `summary: Every new order is screened by Northwind Pay before stock is reserved; a rejected order is refused.
features:
  - id: cap-ordering
    why: Placing an order is the feature that gains the screen.
flows:
  - id: forge-orders.place-order
    how: changed
    why: The screen runs between receiving the order and reserving stock.
  - id: forge-stock.reserve-stock
    how: read
    why: Reserving stock happens only after the screen passes.
gaps:
  - what: No call to Northwind Pay exists yet.
    why: The estate never talks to the fraud screen today.
`;

/** The same draft with the lens's fix applied: the flow is changed, not read. */
const FIXED = PLACED.replace("how: read", "how: changed");

/** The finding the lens gives while the draft still says the flow is only read. */
const FINDING = `findings:
  - rule: flow-use-matches-estate
    artifact: feature.md
    summary: Reserving stock now waits for the screen's verdict, so its steps change.
    why: A flow marked read gets no target flow.
    fix: Mark forge-stock.reserve-stock as changed.
    evidence:
      - { path: feature.md, quote: "Flow forge-stock.reserve-stock (read)" }
`;

interface HandOff {
  state: string;
  runId: string;
  lens?: string;
  promptFile: string;
  resultFile: string;
  doneArgs: string[];
  resumeArgs: string[];
}

describe("the agent drafts a stage, the critic finds something, the agent fixes it", () => {
  it("writes each answer where the hand-off said, closes the loop, and ends done at exit 0", async () => {
    const root = await estateRoot();
    const a = stubAgent(root);
    const codes: number[] = [];
    const json = (r: { code: number; out: string[] }): HandOff => {
      codes.push(r.code);
      return JSON.parse(r.out.join("\n")) as HandOff;
    };

    // The step starts with Atticus. --handoff prints the prompt file, the result file and the two
    // commands that finish the step; the agent writes nothing else.
    let h = json(await a.atticus("change", "feature", CHANGE, "--handoff", "--json"));
    expect(h.state).toBe("handoff");
    expect(h.lens).toBeUndefined();
    expect(h.resultFile).toMatch(/feature-answer\.yaml$/);
    expect(await a.read(h.promptFile)).toBeTruthy();

    const lenses: string[] = [];
    const drafts: string[] = [];
    let fixed = false;
    for (let round = 0; h.state === "handoff" && round < 12; round++) {
      if (h.lens) {
        // A critic lens. It finds the flow marked read while the draft still says so.
        lenses.push(h.lens);
        const prompt = await a.read(h.promptFile);
        const says = /\n\d+: .*Flow forge-stock\.reserve-stock \(read\)/.test(prompt);
        await a.write(h.resultFile, says ? FINDING : "findings: []\n");
      } else {
        // A draft. The second one applies the fix the lens asked for.
        const answer = fixed ? FIXED : PLACED;
        drafts.push(answer === FIXED ? "fixed" : "first");
        await a.write(h.resultFile, answer);
        fixed = true;
      }
      const done = await a.atticus(...h.doneArgs.filter((x) => x !== "--root" && x !== root));
      codes.push(done.code);
      expect(done.code, `handoff done after ${h.lens ?? "the draft"}`).toBe(0);
      h = json(await a.atticus(...h.resumeArgs.filter((x) => x !== "--root" && x !== root)));
    }

    // Every command the agent ran ended 0: the loop never left a step half taken.
    expect(codes.every((c) => c === 0)).toBe(true);
    expect(h.state).toBe("done");

    // The critic found something, and a second draft fixed it.
    expect(lenses).toContain("true");
    expect(drafts).toEqual(["first", "fixed"]);

    // The artifacts Atticus wrote, not the agent: the stage's file and the round's record.
    expect(a.there("openspec/changes/add-fraud-check/feature.md")).toBe(true);
    const feature = await a.read("openspec/changes/add-fraud-check/feature.md");
    expect(feature).toContain("forge-stock.reserve-stock");
    expect(feature).not.toMatch(/reserve-stock \(read\)/);
    const round = parse(
      await a.read("openspec/changes/add-fraud-check/review/define/1/meta/round.yaml"),
    ) as { lenses: { lens: string; state: string }[] };
    expect(round.lenses.map((l) => l.lens)).toContain("true");

    // The agent ran Atticus's commands only: the stage, handoff done and the resume.
    expect(
      a.ran.every(
        (r) => r.startsWith("atticus change feature") || r.startsWith("atticus handoff done"),
      ),
    ).toBe(true);
  }, 300_000);
});

// ----------------------------------------------------------- the rules that don't bend

describe("what the agent cannot do, whatever its instructions say", () => {
  it("records an AI's claim on a finding as a proposal, and leaves it open for a person", async () => {
    const root = await estateRoot();
    const a = stubAgent(root);
    let h = JSON.parse(
      (await a.atticus("change", "feature", CHANGE, "--handoff", "--json")).out.join("\n"),
    ) as HandOff;
    // Draft once and let the lens find something, so there is an open finding to try to close.
    const step = async (text: string) => {
      await a.write(h.resultFile, text);
      expect(
        (await a.atticus(...h.doneArgs.filter((x) => x !== "--root" && x !== root))).code,
      ).toBe(0);
      h = JSON.parse(
        (await a.atticus(...h.resumeArgs.filter((x) => x !== "--root" && x !== root))).out.join(
          "\n",
        ),
      ) as HandOff;
    };
    await step(PLACED);
    let guard = 0;
    while (h.state === "handoff" && h.lens && guard++ < 8) {
      const prompt = await a.read(h.promptFile);
      await step(
        /\n\d+: .*Flow forge-stock\.reserve-stock \(read\)/.test(prompt)
          ? FINDING
          : "findings: []\n",
      );
    }

    type Gate = {
      gate: string;
      findings: { id: string; severity: string; state?: string; proposal?: unknown }[];
    };
    const readFindings = async () => {
      const r = await a.atticus("findings", CHANGE, "--json");
      expect(r.code).toBe(0);
      return (JSON.parse(r.out.join("\n")) as Gate[]).flatMap((g) => g.findings);
    };
    const blocking = (await readFindings()).find(
      (f) => f.severity === "blocking" || f.severity === "risk",
    );
    expect(blocking, "the critic's lens found something to close").toBeTruthy();

    // ADR 0115 addendum (2026-10-25): an AI's not-relevant is a proposal; the finding stays open.
    const tried = await a.atticus(
      "finding",
      CHANGE,
      blocking!.id,
      "not-relevant",
      "--by",
      "copilot",
      "--reason",
      "The agent thinks the flow is only read.",
    );
    const words = [...tried.out, ...tried.err].join("\n");
    expect(words).toMatch(/proposal|waiting on a person|stays open/i);
    const still = (await readFindings()).find((f) => f.id === blocking!.id);
    expect(still, blocking!.id).toBeTruthy();
    expect(still!.state ?? "open").toMatch(/^open/);
    expect(still!.proposal, "an AI's claim is recorded beside the finding").toBeTruthy();
  }, 300_000);
});
