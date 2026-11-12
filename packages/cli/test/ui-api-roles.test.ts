import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { MockNotifier } from "@maycombhq/adapters";
import {
  Api,
  parseRecord,
  questionFromDraft,
  QuestionDraft,
  recordPath,
  serializeRecord,
  writeQuestion,
} from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { extendUiRoutes } from "../src/ui-commands.js";
import { waitsOnOf } from "../src/cockpit.js";
import { confirmFor } from "./confirm-helpers.js";

/**
 * ADR 0191 through the local API: a question re-routed by role, owners suggested from roles.yaml,
 * who a change waits on, the plan's work items as manual steps (kept, so a second sync duplicates
 * nothing), the business analyst's shaping, an owner question sent through the notify adapter on
 * the person's confirmation, a suggested section opened in place, Ask answered from inputs/, and
 * search reading inputs/ with no snapshot. Invented Forge names; files only, no network.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const FORGE_CHANGE = join(HERE, "../../../fixtures/forge-change");
const CHANGE = "add-transfer-limit";
const NOW = "2026-11-09T09:00:00Z";

let root: string;
let srv: RunningServer;
const notifier = new MockNotifier();

async function call(path: string, method = "GET", body?: unknown) {
  const r = await fetch(srv.url + path, {
    method,
    headers: {
      "X-Atticus-Token": srv.token,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  return { status: r.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-ui-roles-"));
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  await cp(join(FORGE_CHANGE, "org-pack"), join(root, "org-pack"), { recursive: true });
  for (const row of parse(readFileSync(join(FORGE, "expected/scan.yaml"), "utf8")) as Record<
    string,
    unknown
  >[]) {
    const p = parseRecord({ schemaVersion: 1, status: "current", ...row });
    if (!p.ok) throw new Error("bad record");
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(join(FORGE_CHANGE, "openspec/changes", CHANGE), join(root, "openspec/changes", CHANGE), {
    recursive: true,
  });
  await cp(join(FORGE, "inputs"), join(root, "inputs"), { recursive: true });
  await writeFile(
    join(root, "org-pack/runtime.yaml"),
    "schemaVersion: 1\nassistants: { allowed: [copilot, claude-code], default: copilot }\nadapters:\n  workTracker: { type: manual }\n",
  );
  // roles.yaml version 3: the ledger team's architect and tech lead, the organisation's BA.
  await writeFile(
    join(root, "org-pack/roles.yaml"),
    stringify({
      schemaVersion: 3,
      teams: [
        {
          id: "team-ledger",
          name: "Ledger team",
          people: ["lee", "tia"],
          roles: { architect: ["lee"], "team-lead": ["tia"] },
        },
      ],
      defaults: { "business-analyst": ["bao"], "product-owner": ["pat"] },
    }),
  );
  srv = await startServer({
    root,
    port: 0,
    user: "pat",
    watch: false,
    extend: (r, ctx) => extendUiRoutes(r, ctx, { now: NOW, notify: notifier }),
  });
});
afterAll(async () => srv?.close());

describe("a question goes to the role that answers it", () => {
  it("is re-routed by a person, and the list says what it asks", async () => {
    const q = questionFromDraft(
      QuestionDraft.parse({
        question: "What happens when the account has too little money on the day?",
        evidence: [`openspec/changes/${CHANGE}/brief.md:3`],
      }),
      {
        step: "change-feature",
        repo: CHANGE,
        command: `atticus change feature ${CHANGE}`,
        rerun: `atticus change feature ${CHANGE}`,
        at: NOW,
      },
    );
    await writeQuestion(root, q);
    expect(q.role).toBe("architecture");
    const moved = await call(`/api/questions/${q.id}/route`, "POST", { role: "product" });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({
      role: "product",
      routed: { from: "architecture", by: "pat" },
    });
    const list = Api.QuestionList.parse((await call(`/api/questions?change=${CHANGE}`)).body);
    expect(list.about?.[q.id]).toMatchObject({ role: "product", asks: "business" });
    // the change's own id is no repo in the repo filter
    expect(Object.keys(list.counts?.byRepo ?? {})).not.toContain(CHANGE);
    expect((await call(`/api/questions/${q.id}/route`, "POST", { role: "wizard" })).status).toBe(
      400,
    );
  });
});

describe("owners and who a change waits on", () => {
  it("suggests owners from roles.yaml for the roles a change doesn't name", async () => {
    const id = "add-ledger-holds";
    const made = await call("/api/changes", "POST", {
      id,
      title: "Ledger holds",
      type: "feature",
      owners: { "product-owner": ["pat"] },
      systems: ["ledger"],
    });
    expect(made.status).toBeLessThan(300);
    const s = Api.OwnerSuggestionList.parse(
      (await call(`/api/changes/${id}/owners/suggested`)).body,
    );
    expect(s.suggestions).toEqual([
      {
        role: "architect",
        people: ["lee"],
        from: { team: "team-ledger", name: "Ledger team", repos: ["forge-ledger"] },
      },
      { role: "business-analyst", people: ["bao"], from: { default: true } },
      {
        role: "team-lead",
        people: ["tia"],
        from: { team: "team-ledger", name: "Ledger team", repos: ["forge-ledger"] },
      },
    ]);
    // nothing written by itself
    const yaml = await readFile(join(root, "openspec/changes", id, "change.yaml"), "utf8");
    expect(yaml).not.toContain("lee");
  });

  it("names whom the change waits on, by role", () => {
    const owners = {
      "product-owner": ["pat"],
      architect: ["ari"],
      "business-analyst": ["bao"],
      "team-lead": ["tia"],
    };
    const handoff = {
      phase: "define" as const,
      branch: "handoff/x/define",
      pr: { number: 1, url: "https://git.example.com/pr/1" },
      state: "open" as const,
      by: "pat",
      openedAt: NOW,
      reviewers: ["ari", "forge/platform"],
      approvals: [],
      artifacts: [],
    };
    expect(waitsOnOf({ state: "define", owners, handoffs: [handoff] }, false)).toEqual({
      role: "architect",
      people: ["ari"],
      because: "handoff",
      phase: "define",
    });
    expect(waitsOnOf({ state: "plan", owners, handoffs: [] }, false)?.people).toEqual(["bao"]);
    expect(waitsOnOf({ state: "plan", owners, handoffs: [] }, true)?.people).toEqual(["tia"]);
    expect(waitsOnOf({ state: "design", owners: {}, handoffs: [] }, false)).toEqual({
      role: "architect",
      people: [],
      because: "phase",
      phase: "design",
    });
  });

  it("names the people an alias, another case or a custom role of the phase's role names", () => {
    // The words people write in change.yaml, which Your changes already reads as the role.
    const aliased = { "Product-Owner": ["@Pat"], "tech-lead": ["@tia"], "lead-architect": ["ari"] };
    const custom = [{ id: "lead-architect", basedOn: "architect" }];
    expect(waitsOnOf({ state: "build", owners: aliased, handoffs: [] }, true)?.people).toEqual([
      "tia",
    ]);
    expect(waitsOnOf({ state: "define", owners: aliased, handoffs: [] }, false)?.people).toEqual([
      "Pat",
    ]);
    expect(
      waitsOnOf({ state: "design", owners: aliased, handoffs: [] }, false, custom)?.people,
    ).toEqual(["ari"]);
    const handoff = {
      phase: "plan" as const,
      branch: "handoff/x/plan",
      pr: { number: 2, url: "https://git.example.com/pr/2" },
      state: "open" as const,
      by: "bao",
      openedAt: NOW,
      reviewers: ["@tia"],
      approvals: [],
      artifacts: [],
    };
    expect(waitsOnOf({ state: "plan", owners: aliased, handoffs: [handoff] }, true)).toEqual({
      role: "team-lead",
      people: ["tia"],
      because: "handoff",
      phase: "plan",
    });
  });

  it("gives At a glance its waitsOn", async () => {
    const c = Api.ChangeCockpit.parse((await call(`/api/changes/${CHANGE}/cockpit`)).body);
    expect(c.waitsOn?.role).toBeDefined();
  });
});

describe("the plan's work items in the work tracker", () => {
  it("lists them, writes a manual step for each with the fields to copy, and duplicates nothing", async () => {
    const plan = Api.WorkItemPlan.parse((await call(`/api/changes/${CHANGE}/work-items`)).body);
    expect(plan.tracker).toBe("manual");
    expect(plan.items.filter((i) => i.type === "story").length).toBeGreaterThan(0);
    expect(plan.items.every((i) => i.action === "create")).toBe(true);
    // the manual tracker writes steps only: no confirmation needed
    const done = await call(`/api/changes/${CHANGE}/work-items`, "POST", {});
    expect(done.status).toBe(200);
    const r = Api.WorkItemSyncResult.parse(done.body);
    expect(r.done.length).toBe(plan.items.length);
    expect(r.plan.items.every((i) => i.action === "unchanged" && i.id?.startsWith("manual:"))).toBe(
      true,
    );
    const story = r.plan.items.find((i) => i.type === "story")!;
    expect(story.step).toBeDefined();
    const sync = parse(
      await readFile(join(root, "openspec/changes", CHANGE, "sync.yaml"), "utf8"),
    ) as {
      workItems: { key: string }[];
    };
    expect(sync.workItems.map((w) => w.key)).toContain(story.key);
    // a second sync creates nothing again
    const again = Api.WorkItemSyncResult.parse(
      (await call(`/api/changes/${CHANGE}/work-items`, "POST", {})).body,
    );
    expect(again.done).toEqual([]);
  });

  it("runs the sync as a job when asked, so an editor panel's request returns at once", async () => {
    const started = await call(`/api/changes/${CHANGE}/work-items`, "POST", { job: true });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    let j: Record<string, unknown> = {};
    for (let i = 0; i < 200; i++) {
      j = (await call(`/api/jobs/${String(started.body.jobId)}`)).body;
      if (j.state !== "running" && j.state !== "queued") break;
      await new Promise((x) => setTimeout(x, 20));
    }
    expect(j.state, JSON.stringify(j)).toBe("done");
    const r = Api.WorkItemSyncResult.parse((j.result as { answer: unknown }).answer);
    expect(r.done).toEqual([]);
  });
});

describe("the business analyst shapes the stories", () => {
  it("refuses before the stories are drafted, through the API", async () => {
    const r = await call(`/api/changes/${CHANGE}/stories/shape`, "POST", {
      op: "rename",
      story: "s1-x",
      name: "Something",
    });
    expect(r.status).toBe(422);
    expect(String(r.body.detail ?? JSON.stringify(r.body))).toMatch(/aren't drafted yet/);
    const v = Api.StoryShapeView.parse((await call(`/api/changes/${CHANGE}/stories/shape`)).body);
    expect(v.entries).toEqual([]);
  });
});

describe("an owner question, sent", () => {
  it("needs the person's confirmation for a live notifier, then sends it", async () => {
    // A critic knowledge gap a person asked of team-portal (Ask on the finding).
    await writeQuestion(root, {
      ...questionFromDraft(
        QuestionDraft.parse({
          question: "Which port does the portal call the gateway on?",
          evidence: [`openspec/changes/${CHANGE}/design.md:1`],
        }),
        {
          step: "critic-ask",
          repo: CHANGE,
          command: "atticus finding x ask",
          rerun: `atticus critic ${CHANGE}`,
          at: NOW,
        },
      ),
      askedOf: "team-portal",
      finding: { change: CHANGE, gate: "design", round: 1, id: "f-1" },
    });
    const list = Api.OwnerQuestionList.parse((await call("/api/owner-questions")).body);
    const q = list.questions.find((x) => x.owner === "team-portal")!;
    expect(q).toBeDefined();
    expect((await call(`/api/owner-questions/${q.id}/send`, "POST", {})).status).toBe(403);
    const confirmation = await confirmFor(srv, "owner-ask", q.id);
    const sent = Api.SentOwnerAsk.parse(
      (await call(`/api/owner-questions/${q.id}/send`, "POST", { confirmation })).body,
    );
    expect(sent.state).toBe("sent");
    expect(notifier.sent.at(-1)?.body).toContain(q.question);
    // Beta.27 review of the fix: a gap's question nobody sent has no sentAt; once sent, it has.
    const gap = list.questions.find((x) => !x.finding && x.state !== "answered")!;
    expect(gap.sentAt).toBeUndefined();
    const c2 = await confirmFor(srv, "owner-ask", gap.id);
    expect(
      (await call(`/api/owner-questions/${gap.id}/send`, "POST", { confirmation: c2 })).body,
    ).toMatchObject({ state: "sent" });
    const again = Api.OwnerQuestionList.parse((await call("/api/owner-questions")).body);
    expect(again.questions.find((x) => x.id === gap.id)?.sentAt).toBe(NOW);
    // Round 2: the send is in the question's own record, shared with everyone who has the
    // metarepo: without this machine's note it still says sent, and when.
    const file = join(root, `catalog/curated/ownerquestion/${gap.id}.yaml`);
    const rec = parse(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(rec).toMatchObject({ questionState: "sent" });
    expect((rec.evidence as unknown[])[0]).toEqual({
      source: "manual",
      by: "pat",
      scannedAt: NOW,
    });
    await rm(join(root, ".index/owner-asks.json"), { force: true });
    const shared = Api.OwnerQuestionList.parse((await call("/api/owner-questions")).body);
    expect(shared.questions.find((x) => x.id === gap.id)?.sentAt).toBe(NOW);
    // A second live send is refused (nothing posted), unless the person chose Send again.
    const posted = notifier.sent.length;
    const c3 = await confirmFor(srv, "owner-ask", gap.id);
    const twice = await call(`/api/owner-questions/${gap.id}/send`, "POST", { confirmation: c3 });
    expect(twice.status).toBe(409);
    expect(String(twice.body.detail)).toMatch(/Send again/);
    expect(notifier.sent.length).toBe(posted);
    const c4 = await confirmFor(srv, "owner-ask", gap.id);
    expect(
      (
        await call(`/api/owner-questions/${gap.id}/send`, "POST", {
          confirmation: c4,
          again: true,
        })
      ).body,
    ).toMatchObject({ state: "sent" });
    expect(notifier.sent.length).toBe(posted + 1);
    // Send again still takes the person's confirmation.
    expect(
      (await call(`/api/owner-questions/${gap.id}/send`, "POST", { again: true })).status,
    ).toBe(403);
  });
});

describe("knowledge, asked and opened in place", () => {
  it("answers how to request a firewall rule from inputs/, citing the page", async () => {
    const r = await call(`/api/ask?q=${encodeURIComponent("How do I request a firewall rule?")}`);
    expect(r.status).toBe(200);
    const k = Api.KnowledgeAnswerView.parse(r.body.knowledge);
    expect(k.passages[0]).toMatchObject({
      source: "inputs",
      page: "wiki/snow-firewall-request.md",
    });
  });

  it("opens a section by its id, and search reads inputs/ with no snapshot", async () => {
    const page = (await readFile(join(root, "inputs/wiki/snow-firewall-request.md"), "utf8")).split(
      "\n",
    );
    const heading = page.find((l) => /^#{1,6}\s/.test(l))!.replace(/^#+\s+/, "");
    const p = await call(
      `/api/knowledge/passage?id=${encodeURIComponent(`inputs/wiki/snow-firewall-request.md#${heading}`)}`,
    );
    expect(p.status).toBe(200);
    expect(Api.KnowledgePassageView.parse(p.body).heading).toContain(heading);
    expect(
      (await call(`/api/knowledge/passage?id=${encodeURIComponent("inputs/nope.md#x")}`)).status,
    ).toBe(404);
    const s = Api.WikiSearchResult.parse((await call("/api/knowledge/search?q=firewall")).body);
    expect(s.sources).toBe(1);
    expect(s.matches.some((m) => m.source === "inputs")).toBe(true);
  });

  it("reads inputs/ with no snapshot as a sync would: a page above the limit is not read", async () => {
    const secret = join(root, "inputs/wiki/zebra-secret.md");
    const bad = join(root, "inputs/wiki/zebra-bad.md");
    await writeFile(
      secret,
      "---\nclassification: restricted\n---\n# Zebra access\n\nAsk the zebra desk with code ZEBRA.\n",
    );
    await writeFile(bad, "---\nclassification: [\n---\n# Zebra access two\n\nZebra code two.\n");
    try {
      const a = Api.KnowledgeAnswerView.parse(
        (await call(`/api/ask?q=${encodeURIComponent("zebra access code")}`)).body.knowledge,
      );
      expect(a.passages.map((p) => p.page)).not.toContain("wiki/zebra-secret.md");
      expect(a.passages.map((p) => p.page)).not.toContain("wiki/zebra-bad.md");
      const s = Api.WikiSearchResult.parse((await call("/api/knowledge/search?q=zebra")).body);
      expect(s.matches).toEqual([]);
      const p = await call(
        `/api/knowledge/passage?id=${encodeURIComponent("inputs/wiki/zebra-secret.md#Zebra access")}`,
      );
      expect(p.status).toBe(404);
    } finally {
      await rm(secret, { force: true });
      await rm(bad, { force: true });
    }
  });

  it("never offers a command a pasted question could run code from", async () => {
    const q = 'How do I request a rule $(touch pwned) `id` "x" it\'s; & | %PATH% ^!';
    const a = Api.KnowledgeAnswerView.parse(
      (await call(`/api/ask?q=${encodeURIComponent(q)}`)).body.knowledge,
    );
    expect(a.command).toMatch(/^atticus knowledge ask "[^"$`'\\%^!;&|<>()]*"$/);
    expect(a.command).toContain("How do I request a rule");
    const s = Api.WikiSearchResult.parse(
      (await call(`/api/knowledge/search?q=${encodeURIComponent("firewall $(id)")}`)).body,
    );
    expect(s.command).toMatch(/^atticus knowledge find "[^"$`'\\%^!;&|<>()]*"$/);
  });
});

describe("a hand-off tells the next role", () => {
  it("sends each named reviewer of the next role a message through the notify adapter", async () => {
    const { notifyHandoffReviewers } = await import("../src/roles-work.js");
    const n = new MockNotifier();
    const c = {
      schemaVersion: 1 as const,
      id: CHANGE,
      title: "Add transfer limit",
      type: "feature",
      state: "define" as const,
      owners: { architect: ["ari"] },
      systems: [],
      touches: { interfaces: [], dataStores: [], tables: [], records: [], repos: [] },
      authors: {},
      createdAt: NOW,
      createdBy: "pat",
      history: [],
      handoffs: [],
    };
    const h = {
      phase: "define" as const,
      branch: `handoff/${CHANGE}/define`,
      pr: { number: 7, url: "https://git.example.com/forge/forge-metarepo/pull/7" },
      state: "open" as const,
      by: "pat",
      openedAt: NOW,
      reviewers: ["ari", "forge/platform"],
      approvals: [],
      artifacts: [],
    };
    const said = await notifyHandoffReviewers(root, c, h, { by: "pat", at: NOW, ref: h.branch }, n);
    expect(said).toEqual([expect.stringMatching(/^Told @ari \(architect\)/)]);
    expect(n.sent).toEqual([
      expect.objectContaining({ channel: "@ari", link: h.pr.url, mentions: ["ari"] }),
    ]);
    // ADR 0191 review: an owner named in another case (or with @) is the same reviewer.
    const m = new MockNotifier();
    const told = await notifyHandoffReviewers(
      root,
      { ...c, owners: { architect: ["@Ari"] } },
      h,
      { by: "pat", at: NOW, ref: h.branch },
      m,
    );
    expect(told).toHaveLength(1);
    expect(m.sent).toEqual([expect.objectContaining({ channel: "@Ari", mentions: ["Ari"] })]);
  });
});
