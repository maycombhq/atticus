import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { startServer } from "@maycombhq/server";
import { questionsCommand } from "../src/knowledge-commands.js";
import {
  answerOwnerQuestion,
  ownerQuestionCommand,
  ownerQuestions,
  OwnerQuestionError,
  recordOwnerAsk,
} from "../src/owner-questions.js";
import { scopeDirs } from "../src/propose.js";
import { uiQuestionRoutes } from "../src/ui-api-questions.js";

/**
 * UX review (2026-11-08): the owner questions of the knowledge gaps (ADR 0021) are answered in
 * the app as on the command line. `atticus questions owner <id> --text "..."` records the owner's
 * answer as a curated OwnerQuestion record, which every scan keeps; the gap itself closes only
 * once the fact is in the catalog.
 */
const FORGE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/forge");
const REPORTS = "q.unattended-workload-monitored.reports-job";
const FILE = `catalog/curated/ownerquestion/${REPORTS}.yaml`;
const NOW = new Date("2026-11-08T10:00:00Z");

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

async function forgeRoot(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "atticus-owner-q-"));
  const root = join(base, "metarepo");
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  for (const r of parse(readFileSync(join(FORGE, "expected/scan.yaml"), "utf8")) as Record<
    string,
    unknown
  >[]) {
    const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
    if (!p.ok) throw new Error(String(r.id));
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  return root;
}

describe("owner questions", () => {
  it("lists the gaps' owner questions, each open until answered", async () => {
    const root = await forgeRoot();
    const list = await ownerQuestions(root);
    expect(list.empty).toBe(false);
    expect(list.questions.map((q) => q.id)).toEqual([
      "q.call-resilience-known.if-e7344c9455608119",
      REPORTS,
      "q.component-source-known.audit-svc",
    ]);
    expect(list.open).toBe(3);
    const q = list.questions.find((x) => x.id === REPORTS)!;
    expect(q).toMatchObject({
      system: "reports",
      owner: "team-reports",
      state: "sent",
      file: FILE,
    });
    expect(q.neededFact).toMatch(/ObservabilityAsset/);
  });

  it("says a question was sent only once a send is on file (beta.27 review of the fix)", async () => {
    const root = await forgeRoot();
    const before = (await ownerQuestions(root)).questions.find((q) => q.id === REPORTS)!;
    expect(before.sentAt).toBeUndefined();
    await recordOwnerAsk(root, REPORTS, { at: "2026-11-09T22:30:00Z", to: before.owner });
    const after = (await ownerQuestions(root)).questions.find((q) => q.id === REPORTS)!;
    expect(after.sentAt).toBe("2026-11-09T22:30:00Z");
    // The others still aren't.
    expect((await ownerQuestions(root)).questions.filter((q) => q.sentAt)).toHaveLength(1);
  });

  it("records the answer as a curated record, which the questions read back", async () => {
    const root = await forgeRoot();
    const r = await answerOwnerQuestion(
      root,
      REPORTS,
      "  The reports-failed alert pages team-reports.  ",
      {
        by: "pat",
        now: NOW,
      },
    );
    expect(r.file).toBe(FILE);
    const p = parseRecord(parse(await readFile(join(root, FILE), "utf8")));
    expect(p.ok).toBe(true);
    const rec = p.ok ? (p.record as Record<string, unknown>) : {};
    expect(rec).toMatchObject({
      kind: "OwnerQuestion",
      id: REPORTS,
      confidence: "asserted",
      questionState: "answered",
      answer: "The reports-failed alert pages team-reports.",
      owner: "team-reports",
    });
    expect((rec.evidence as { source: string; by?: string }[])[0]).toEqual({
      source: "manual",
      by: "pat",
      scannedAt: "2026-11-08T10:00:00Z",
    });
    const after = await ownerQuestions(root);
    expect(after.open).toBe(2);
    expect(after.questions.find((x) => x.id === REPORTS)).toMatchObject({
      state: "answered",
      answer: "The reports-failed alert pages team-reports.",
    });
    // The gap stays until the fact is in the catalog (ADR 0021): the old command still lists it.
    const c = capture();
    await questionsCommand(root, c.io, {});
    expect(c.out.join("\n")).toMatch(
      /Answer: The reports-failed alert pages team-reports\. \(record it in the catalog/,
    );
  });

  it("refuses an empty answer and a question that isn't open", async () => {
    const root = await forgeRoot();
    await expect(answerOwnerQuestion(root, REPORTS, "  ", { by: "pat" })).rejects.toThrow(
      OwnerQuestionError,
    );
    await expect(answerOwnerQuestion(root, "q.nothing.here", "yes", { by: "pat" })).rejects.toThrow(
      /There is no owner question q\.nothing\.here/,
    );
  });

  it("atticus questions owner <id> --text writes the same file and says what's next", async () => {
    const root = await forgeRoot();
    const c = capture();
    expect(
      await ownerQuestionCommand(
        root,
        ["questions", "owner", REPORTS, "--text", "An alert", "--by", "pat"],
        c.io,
        { now: NOW },
      ),
    ).toBe(0);
    expect(c.out.join("\n")).toMatch(new RegExp(`Wrote ${FILE.replace(/\./g, "\\.")}`));
    expect(c.out.join("\n")).toMatch(/closes once the fact is in the catalog/);
    const u = capture();
    expect(await ownerQuestionCommand(root, ["questions", "owner"], u.io)).toBe(2);
    expect(u.err.join("\n")).toMatch(/Usage: atticus questions owner/);
  });

  it("proposes owner answers from their folder, and the baseline from the catalog", () => {
    expect(scopeDirs("/m", "owner-answers")).toEqual(["catalog/curated/ownerquestion"]);
    expect(scopeDirs("/m", "baseline")).toEqual(["catalog"]);
  });
});

describe("the owner questions API", () => {
  it("lists them and writes an answer as the signed-in person", async () => {
    const root = await forgeRoot();
    const s = await startServer({
      root,
      port: 0,
      user: "pat",
      extend: (r, ctx) => uiQuestionRoutes(r, ctx, { now: () => NOW }),
    });
    const h = { "X-Atticus-Token": s.token, "Content-Type": "application/json" };
    try {
      const list = await fetch(`${s.url}/api/owner-questions`, { headers: h });
      expect(list.status).toBe(200);
      const body = (await list.json()) as { open: number; questions: { id: string }[] };
      expect(body.open).toBe(3);
      const res = await fetch(`${s.url}/api/owner-questions/${REPORTS}/answer`, {
        method: "POST",
        headers: h,
        body: JSON.stringify({ answer: "An alert" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        file: FILE,
        question: { id: REPORTS, state: "answered", answer: "An alert" },
      });
      expect(await readFile(join(root, FILE), "utf8")).toMatch(/by: pat/);
      const bad = await fetch(`${s.url}/api/owner-questions/${REPORTS}/answer`, {
        method: "POST",
        headers: h,
        body: JSON.stringify({ answer: "" }),
      });
      expect(bad.status).toBe(400);
      const none = await fetch(`${s.url}/api/owner-questions/q.nothing/answer`, {
        method: "POST",
        headers: h,
        body: JSON.stringify({ answer: "yes" }),
      });
      expect(none.status).toBe(404);
    } finally {
      await s.close();
    }
  }, 60_000);

  it("says an empty catalog as empty, not as an error", async () => {
    const base = await mkdtemp(join(tmpdir(), "atticus-owner-q-empty-"));
    await cp(join(FORGE, "metarepo/org-pack"), join(base, "org-pack"), { recursive: true });
    const s = await startServer({
      root: base,
      port: 0,
      user: "pat",
      extend: (r, ctx) => uiQuestionRoutes(r, ctx),
    });
    try {
      const res = await fetch(`${s.url}/api/owner-questions`, {
        headers: { "X-Atticus-Token": s.token },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ empty: true, open: 0, questions: [] });
    } finally {
      await s.close();
    }
  }, 60_000);
});
