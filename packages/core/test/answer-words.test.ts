import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  answerQuestion,
  editProfileSystem,
  HOSTS_STEP,
  ignoredAnswer,
  JOIN_IGNORE_LABEL,
  joinHostOfQuestion,
  addOutsideSystem,
  addProfileSystem,
  changedLines,
  forwardHostQuestion,
  namesKnownTarget,
  raiseQuestions,
  readsAsSentence,
  readQuestion,
  systemNameProblem,
  TARGETS_ANOTHER_LABEL,
  TARGETS_STEP_ID,
  TOPICS_STEP_ID,
} from "../src/index.js";

/**
 * Beta.24 review: a person answered join questions with words that meant "ignore this" ("ignore
 * this, its cicd related"), and the words became a box on the map. Words that name nothing are
 * refused now; Ignore is an answer of its own; and a system made from words is told apart. On the
 * invented bank-shaped estate (fixtures/link-estate).
 */

const ESTATE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/link-estate");
const AT = "2026-11-10T12:00:00.000Z";
const PROFILE = ["org-pack", "profiles", "forge", "profile.yaml"];

async function metarepo() {
  const root = await mkdtemp(join(tmpdir(), "atticus-words-"));
  await cp(join(ESTATE, "org-pack"), join(root, "org-pack"), { recursive: true });
  return root;
}

const draft = {
  question: "Which repo or system answers POST /hooks/outbound, which payments-api calls?",
  options: [
    { label: "forge-cards", means: "forge-cards, not read yet, answers it", changes: "joins it" },
    { label: TARGETS_ANOTHER_LABEL, means: "the picker", changes: "nothing until you name one" },
    { label: "None of these", means: "nothing", changes: "a loose end" },
  ],
  evidence: ["src/main/java/forge/payments/HooksClient.java:12"],
  scope: "repo" as const,
};
const by = (step: string) => ({
  step,
  repo: "forge-payments",
  command: "atticus verify forge-payments --write",
  rerun: "atticus verify forge-payments --write",
  at: AT,
});

async function asked(step = TARGETS_STEP_ID, d = draft) {
  const root = await metarepo();
  const q = (await raiseQuestions(root, [d], by(step))).raised[0]!;
  return { root, q };
}

describe("words that name nothing (beta.24 review)", () => {
  it("refuses 'ignore this, its cicd related' as a targets answer, and says what to do", async () => {
    const { root, q } = await asked();
    const err = await answerQuestion(root, q.id, {
      text: "ignore this, its cicd related",
      by: "pat",
      at: AT,
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const m = (err as Error).message;
    expect(m).toMatch(/names no repo, component or system/);
    expect(m).toMatch(/An outside system \(new\)/);
    expect(m).toContain(JOIN_IGNORE_LABEL);
    expect((await readQuestion(root, q.id))!.state).toBe("open");
  });

  it("refuses a sentence on a hosts or topics question too", async () => {
    for (const step of [HOSTS_STEP, TOPICS_STEP_ID]) {
      const { root, q } = await asked(step, {
        ...draft,
        question:
          step === HOSTS_STEP
            ? "Which repo answers on hooks.forge.internal?"
            : "Who owns the topic forge.hooks, which payments-api publishes to?",
      });
      await expect(
        answerQuestion(root, q.id, {
          text: "this is a proxy to send outbound webhook to merchants",
          by: "pat",
          at: AT,
        }),
      ).rejects.toThrow(/names no repo, component or system/);
    }
  });

  it("takes words that name a repo or system of the org pack", async () => {
    const { root, q } = await asked();
    const r = await answerQuestion(root, q.id, { text: "forge-accounts", by: "pat", at: AT });
    expect(r.question.answer?.text).toBe("forge-accounts");
  });

  it("still takes words on a question that isn't about where calls go", async () => {
    const { root, q } = await asked("survey-pattern");
    const r = await answerQuestion(root, q.id, { text: "ignore this one", by: "pat", at: AT });
    expect(r.question.answer?.text).toBe("ignore this one");
  });
});

describe("Ignore (beta.24 review)", () => {
  it("adds the Ignore option to a question asked before it, and picks it", async () => {
    const { root, q } = await asked();
    const r = await answerQuestion(root, q.id, { ignore: {}, by: "pat", at: AT });
    expect(r.question.options.at(-1)?.label).toBe(JOIN_IGNORE_LABEL);
    expect(r.question.answer?.option).toBe(4);
    expect(ignoredAnswer(r.question)).toEqual({});
    const file = parse(await readFile(join(root, "questions", `${q.id}.yaml`), "utf8")) as {
      options: { label: string }[];
    };
    expect(file.options.map((o) => o.label)).toContain(JOIN_IGNORE_LABEL);
  });

  it("keeps a reason as the answer's words", async () => {
    const { root, q } = await asked();
    const r = await answerQuestion(root, q.id, {
      ignore: { reason: "its cicd related" },
      by: "pat",
      at: AT,
    });
    expect(r.question.answer?.text).toBe("Ignore: its cicd related");
    expect(ignoredAnswer(r.question)).toEqual({ reason: "its cicd related" });
  });

  it("is only for a question about where calls go, a person's, and alone", async () => {
    const other = await asked("survey-pattern");
    await expect(
      answerQuestion(other.root, other.q.id, { ignore: {}, by: "pat", at: AT }),
    ).rejects.toThrow(/where calls go/);
    const { root, q } = await asked();
    await expect(
      answerQuestion(root, q.id, { ignore: {}, option: 1, by: "pat", at: AT }),
    ).rejects.toThrow(/alone/);
    await expect(
      answerQuestion(root, q.id, {
        ignore: {},
        by: { kind: "ai", runtime: "copilot-acp", run: "r-1" },
        at: AT,
      }),
    ).rejects.toThrow(/person/);
  });

  it("writes nothing to the manifest for a hosts question", async () => {
    const { root, q } = await asked(HOSTS_STEP, {
      ...draft,
      question: "Which repo answers on hooks.forge.internal?",
    });
    const before = await readFile(
      join(root, "org-pack", "profiles", "forge", "repos.manifest.yaml"),
      "utf8",
    );
    const r = await answerQuestion(root, q.id, { ignore: {}, by: "pat", at: AT });
    expect(r.hosts).toBeUndefined();
    expect(r.system).toBeUndefined();
    expect(
      await readFile(join(root, "org-pack", "profiles", "forge", "repos.manifest.yaml"), "utf8"),
    ).toBe(before);
  });
});

describe("a system's name (beta.24 review)", () => {
  it("is short, letters, digits, spaces and dashes, and not a sentence", () => {
    expect(systemNameProblem("Northwind Pay")).toBeUndefined();
    expect(systemNameProblem("Lantern-Mail 2")).toBeUndefined();
    expect(systemNameProblem("ignore this, its cicd related")).toBeDefined();
    expect(systemNameProblem("this is a proxy")).toMatch(/sentence/);
    expect(systemNameProblem("x".repeat(41))).toMatch(/40/);
    expect(systemNameProblem("")).toBeDefined();
  });

  it("tells words that read as a sentence from a name (beta.25)", () => {
    expect(readsAsSentence("ignore this, its cicd related")).toBe(true);
    expect(readsAsSentence("ignore this its cicd related")).toBe(true);
    expect(readsAsSentence("this is a proxy to send outbound webhook")).toBe(true);
    expect(readsAsSentence("a proxy that sends outbound webhooks to merchants")).toBe(true);
    // Names, of any length in words, with one small word, or a host's dots.
    for (const name of [
      "Northwind Pay",
      "forge-ledger-api",
      "IT Service Desk",
      "it-service-desk",
      "Plan A",
      "plan-a",
      "To Do",
      "to-do",
      "Payments API Gateway North East",
      "payments-api-gateway-north-east",
      "api.payments.northwind.example.com",
      "api-payments-northwind-example-com",
    ])
      expect(readsAsSentence(name), name).toBe(false);
  });

  it("takes a name with one small word, or five words, as a system's name (beta.25)", () => {
    expect(systemNameProblem("IT Service Desk")).toBeUndefined();
    expect(systemNameProblem("Plan A")).toBeUndefined();
    expect(systemNameProblem("Payments Gateway North East Two")).toBeUndefined();
    expect(systemNameProblem("ignore this its cicd related")).toMatch(/sentence/);
  });

  it("takes a system out of the profile, or renames it, previewed first", async () => {
    const root = await metarepo();
    const file = join(root, ...PROFILE);
    const before = await readFile(file, "utf8");
    const id = "harbor-audit";
    const look = await editProfileSystem(root, id, { preview: true });
    expect(look?.written).toBe(false);
    expect(look?.changes.some((c) => c.was?.includes(id))).toBe(true);
    expect(await readFile(file, "utf8")).toBe(before);
    const renamed = await editProfileSystem(root, id, {
      rename: { id: "northwind-hooks", name: "Northwind Hooks" },
    });
    expect(renamed?.written).toBe(true);
    const now = parse(await readFile(file, "utf8")) as { systems: { id: string; name: string }[] };
    expect(now.systems.find((s) => s.id === "northwind-hooks")?.name).toBe("Northwind Hooks");
    expect(now.systems.some((s) => s.id === id)).toBe(false);
    await editProfileSystem(root, "northwind-hooks");
    const gone = parse(await readFile(file, "utf8")) as { systems: { id: string }[] };
    expect(gone.systems.some((s) => s.id === "northwind-hooks")).toBe(false);
    expect(await editProfileSystem(root, "no-such-system")).toBeUndefined();
  });
});

/** The golden profile edits keep: its comments, and its flow lists as written (`[a]`, `{ a }`). */
describe("a profile edit changes only its own lines (beta.25)", () => {
  const AUDIT =
    "  - { id: harbor-audit, name: Harbor Audit, boundary: internal, owner: team-harbor, aliases: [] }\n";
  const SSO =
    "  - { id: forge-sso, name: Forge SSO, boundary: internal, owner: team-identity, aliases: [sso.forge.internal] }\n";

  it("keeps the group comment above a system taken out, and every other line as it was", async () => {
    const root = await metarepo();
    const file = join(root, ...PROFILE);
    const before = await readFile(file, "utf8");
    expect(before).toContain(`# Other teams' systems no repo here belongs to`);
    const look = await editProfileSystem(root, "harbor-audit", { preview: true });
    expect(look?.changes).toEqual([{ was: AUDIT.slice(0, -1) }]);
    await editProfileSystem(root, "harbor-audit");
    expect(await readFile(file, "utf8")).toBe(before.replace(AUDIT, ""));
  });

  it("keeps a comment when the first system of a group goes, and a rename is one line", async () => {
    const root = await metarepo();
    const file = join(root, ...PROFILE);
    const before = await readFile(file, "utf8");
    await editProfileSystem(root, "harbor-audit");
    await editProfileSystem(root, "forge-sso");
    const after = await readFile(file, "utf8");
    expect(after).toBe(before.replace(AUDIT, "").replace(SSO, ""));
    expect(after).toMatch(/# Other teams' systems[^\n]*\n {2}# Invented vendors/);
    const r = await editProfileSystem(root, "lantern-mail", {
      rename: { id: "lantern-post", name: "Lantern Post" },
      preview: true,
    });
    expect(r?.changes.filter((c) => c.was !== undefined)).toHaveLength(1);
    expect(r?.changes.filter((c) => c.now !== undefined)).toHaveLength(1);
  });

  it("adds an outside system's or a named system's lines and changes no other", async () => {
    const root = await metarepo();
    const file = join(root, ...PROFILE);
    const before = await readFile(file, "utf8");
    // A long host: no line folded, no flow list re-padded.
    const host = "api.payments.northwind.example.com";
    await addOutsideSystem(root, "forge-payments", host, "vendor");
    const mid = await readFile(file, "utf8");
    expect(changedLines(before, mid).every((c) => c.was === undefined)).toBe(true);
    expect(mid).toContain(SSO);
    const r = await addProfileSystem(
      root,
      "forge-payments",
      { id: "forge-it-service-desk", name: "Forge IT Service Desk", boundary: "internal" },
      { preview: true },
    );
    expect(r.changes?.every((c) => c.was === undefined)).toBe(true);
    expect(r.write?.after).toContain(SSO);
  });
});

describe("join questions read back (beta.25)", () => {
  it("reads a spaced token's host back from the join's words", () => {
    const q = forwardHostQuestion("{{ vendor_url }}", "forge-proxy-northwind-v1");
    expect(joinHostOfQuestion({ question: q })).toBe("{{ vendor_url }}");
    expect(
      joinHostOfQuestion({ question: forwardHostQuestion("@targetVendorUrl@", "forge-proxy") }),
    ).toBe("@targetVendorUrl@");
    expect(joinHostOfQuestion({ question: "Which repo answers on rates-cache:8080?" })).toBe(
      "rates-cache:8080",
    );
    expect(
      joinHostOfQuestion({ question: "Which repo or system answers POST /hooks, which x calls?" }),
    ).toBeUndefined();
  });

  it("never takes a sentence as a known system, even one a profile holds", async () => {
    const root = await metarepo();
    const file = join(root, ...PROFILE);
    await writeFile(
      file,
      (await readFile(file, "utf8")).replace(
        "environments:",
        `  - { id: ignore-this-its-cicd-related, name: "ignore this, its cicd related", boundary: vendor, aliases: [] }\nenvironments:`,
      ),
    );
    expect(await namesKnownTarget(root, "ignore this, its cicd related")).toBe(false);
    expect(await namesKnownTarget(root, "ignore-this-its-cicd-related")).toBe(true);
    expect(
      await namesKnownTarget(root, "ignore-this-its-cicd-related", {
        except: new Set(["ignore-this-its-cicd-related"]),
      }),
    ).toBe(false);
    expect(await namesKnownTarget(root, "Northwind Pay")).toBe(true);
  });

  it("refuses an Ignore's reason longer than 300 characters", async () => {
    const { root, q } = await asked();
    await expect(
      answerQuestion(root, q.id, { ignore: { reason: "x".repeat(301) }, by: "pat", at: AT }),
    ).rejects.toThrow(/at most 300/);
    expect((await readQuestion(root, q.id))!.state).toBe("open");
  });
});
