import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  addProfileSystem,
  answerQuestion,
  raiseQuestions,
  readQuestion,
  reopenQuestion,
  TARGETS_ANOTHER_LABEL,
  TARGETS_STEP_ID,
} from "../src/index.js";

/**
 * ADR 0162 (F8): a targets answer the code later disagrees with opens again, keeping the answer it
 * had; "Another repo…" is never an answer; and a system a person names is written into the
 * profile as a file change for review. On the invented bank-shaped estate (fixtures/link-estate).
 */

const ESTATE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/link-estate");
const AT = "2026-11-01T12:00:00.000Z";
const PROFILE = ["org-pack", "profiles", "forge", "profile.yaml"];

async function metarepo() {
  const root = await mkdtemp(join(tmpdir(), "atticus-targets-"));
  await cp(join(ESTATE, "org-pack"), join(root, "org-pack"), { recursive: true });
  return root;
}

const draft = {
  question: "Which repo or system answers GET /limits/{id}, which payments-api calls?",
  options: [
    { label: "forge-cards", means: "forge-cards, not read yet, answers it", changes: "joins it" },
    { label: TARGETS_ANOTHER_LABEL, means: "the picker", changes: "nothing until you name one" },
    { label: "None of these", means: "nothing", changes: "a loose end" },
  ],
  evidence: ["src/main/java/forge/payments/PaymentsService.java:24"],
  scope: "repo" as const,
};
const by = {
  step: TARGETS_STEP_ID,
  repo: "forge-payments",
  command: "atticus verify forge-payments --write",
  rerun: "atticus verify forge-payments --write",
  at: AT,
};

describe("a targets answer (ADR 0162)", () => {
  it("refuses Another repo… as an answer, and says to name one", async () => {
    const root = await metarepo();
    const q = (await raiseQuestions(root, [draft], by)).raised[0]!;
    await expect(answerQuestion(root, q.id, { option: 2, by: "pat", at: AT })).rejects.toThrow(
      /--target <id>/,
    );
  });

  it("reopens with why, keeping the answer it had; answered again, the reopening stays", async () => {
    const root = await metarepo();
    const q = (await raiseQuestions(root, [draft], by)).raised[0]!;
    await answerQuestion(root, q.id, { option: 1, by: "pat", at: AT });
    const why =
      "forge-cards is read now, and no route of it serves GET /limits/{id}: payments-api calls GET /limits/{id} on forge-cards, and no entry of forge-cards the facts name serves it";
    const open = await reopenQuestion(root, q.id, { why, at: AT });
    expect(open.state).toBe("open");
    expect(open.answer).toBeUndefined();
    expect(open.reopened).toMatchObject({ why, answer: { option: 1, by: "pat" } });
    const text = await readFile(join(root, "questions", `${q.id}.yaml`), "utf8");
    expect(text).toContain("schemaVersion: 4");
    expect(text).toContain("reopened:");
    await answerQuestion(root, q.id, { text: "forge-accounts", by: "pat", at: AT });
    const again = (await readQuestion(root, q.id))!;
    expect(again.state).toBe("answered");
    expect(again.reopened?.why).toBe(why);
    await expect(reopenQuestion(root, "q-000000000000", { why, at: AT })).rejects.toThrow(
      /no question/,
    );
  });
});

describe("addProfileSystem (ADR 0162)", () => {
  it("writes another team's system with the team as owner, once", async () => {
    const root = await metarepo();
    const r = await addProfileSystem(root, "forge-payments", {
      id: "team-ledger-ops-system",
      name: "Ledger Ops's system",
      boundary: "internal",
      owner: "team-ledger-ops",
    });
    expect(r).toMatchObject({
      id: "team-ledger-ops-system",
      profile: "org-pack/profiles/forge/profile.yaml",
      added: true,
    });
    // The lines the write made, the new system's among them (a preview shows the same).
    expect(r.changes!.some((c) => c.now?.includes("team-ledger-ops-system"))).toBe(true);
    const text = await readFile(join(root, ...PROFILE), "utf8");
    // The profile keeps its comments.
    expect(text).toContain("# Invented vendors, each named by the host the code calls it on.");
    const p = parse(text) as { systems: { id: string; owner?: string; boundary: string }[] };
    expect(p.systems.find((s) => s.id === "team-ledger-ops-system")).toMatchObject({
      boundary: "internal",
      owner: "team-ledger-ops",
    });
    expect(
      (
        await addProfileSystem(root, "forge-payments", {
          id: "northwind-pay",
          name: "x",
          boundary: "vendor",
        })
      ).added,
    ).toBe(false);
    await expect(
      addProfileSystem(root, "forge-nowhere", {
        id: "tidewater",
        name: "Tidewater",
        boundary: "vendor",
      }),
    ).rejects.toThrow(/isn't in any repos.manifest.yaml/);
  });
});
