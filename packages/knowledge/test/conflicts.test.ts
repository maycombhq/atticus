import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import {
  answerQuestion,
  parseRecord,
  QuestionDraft,
  questionFromDraft,
  recordPath,
  serializeRecord,
  writeQuestion,
} from "@maycombhq/core";
import {
  CONFLICT_STEP,
  codeSettles,
  conflictDraft,
  conflictKey,
  conflictKeyOfQuestion,
  conflictLine,
  conflictOwner,
  readConflicts,
  valuesOf,
  type KnowledgeConflict,
  type PageFacts,
} from "../src/index.js";
import { HERE } from "./helpers.js";

/**
 * Pages that disagree (ADR 0124 addendum B-task-knowledge): which page owns the topic, by the
 * signals a scan can read without a model, and the question a person answers when none decides.
 */

const SSO = join(HERE, "../../../fixtures/stages/sso");

const page = (p: Partial<PageFacts> & { page: string }): PageFacts => ({
  source: "forge-wiki",
  sourceKinds: [],
  ...p,
});
const two = {
  pages: [
    { source: "forge-wiki", page: "a.md" },
    { source: "forge-wiki", page: "b.md" },
  ],
};

describe("the ownership signals", () => {
  it("takes the page that says it replaces the other", () => {
    expect(
      conflictOwner(two, [page({ page: "a.md" }), page({ page: "b.md" })], {}, [
        {
          old: { source: "forge-wiki", page: "a.md" },
          new: { source: "forge-wiki", page: "b.md" },
          quote: "It replaces a.md.",
          quotedOn: { source: "forge-wiki", page: "b.md" },
        },
      ]),
    ).toEqual({
      source: "forge-wiki",
      page: "b.md",
      signal: "replaces",
      detail: "b.md says it replaces a.md",
    });
  });

  it("takes the page whose owner is the team that handles the item, page or source", () => {
    expect(
      conflictOwner(
        two,
        [
          page({ page: "a.md", pageOwner: "Service Management" }),
          page({ page: "b.md", pageOwner: "Network team" }),
        ],
        { handledBy: "Network team" },
      ),
    ).toMatchObject({ page: "b.md", signal: "owner" });
    // The source's owner (sources.yaml) when the page names none.
    expect(
      conflictOwner(
        {
          pages: [
            { source: "ops-wiki", page: "a.md" },
            { source: "forge-wiki", page: "b.md" },
          ],
        },
        [
          page({ source: "ops-wiki", page: "a.md", sourceOwner: "Network" }),
          page({ page: "b.md" }),
        ],
        { handledBy: "Network team" },
      ),
    ).toMatchObject({ source: "ops-wiki", page: "a.md", signal: "owner" });
  });

  it("goes on to the next signal when both pages have the owner", () => {
    expect(
      conflictOwner(
        two,
        [
          page({ page: "a.md", pageOwner: "Network team", date: "2026-02-17" }),
          page({ page: "b.md", pageOwner: "Network team", date: "2026-09-15" }),
        ],
        { handledBy: "Network team" },
      ),
    ).toMatchObject({ page: "b.md", signal: "last-edited" });
  });

  it("takes the one source tagged with the item's kind", () => {
    expect(
      conflictOwner(
        {
          pages: [
            { source: "standards-wiki", page: "tokens.md" },
            { source: "team-notes", page: "tokens.md" },
          ],
        },
        [
          page({
            source: "standards-wiki",
            page: "tokens.md",
            sourceKinds: ["security-standards"],
          }),
          page({ source: "team-notes", page: "tokens.md", sourceKinds: ["notes"] }),
        ],
        { kind: "standard" },
      ),
    ).toMatchObject({ source: "standards-wiki", signal: "source-kind" });
  });

  it("takes the page in the space of the team that handles it", () => {
    expect(
      conflictOwner(
        {
          pages: [
            { source: "forge-wiki", page: "identity/sso-setup.md" },
            { source: "forge-wiki", page: "orders/sso-notes.md" },
          ],
        },
        [
          page({ page: "identity/sso-setup.md", space: "identity" }),
          page({ page: "orders/sso-notes.md", space: "orders" }),
        ],
        { handledBy: "Identity team" },
      ),
    ).toMatchObject({ page: "identity/sso-setup.md", signal: "space" });
  });

  it("takes the page edited last when both say when", () => {
    expect(
      conflictOwner(
        two,
        [page({ page: "a.md", date: "2026-10-01" }), page({ page: "b.md", date: "2025-03-02" })],
        {},
      ),
    ).toEqual({
      source: "forge-wiki",
      page: "a.md",
      signal: "last-edited",
      detail: "a.md was last edited 2026-10-01, after b.md (2025-03-02)",
    });
  });

  it("decides nothing when no signal tells the pages apart: that is a person's question", () => {
    expect(
      conflictOwner(two, [page({ page: "a.md" }), page({ page: "b.md" })], {
        handledBy: "Identity team",
      }),
    ).toBeUndefined();
    // One date missing: the dates don't decide.
    expect(
      conflictOwner(two, [page({ page: "a.md", date: "2026-10-01" }), page({ page: "b.md" })], {}),
    ).toBeUndefined();
  });
});

/** The SSO fixture's metarepo: its snapshot, items and scan report. */
async function ssoRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-conflicts-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  await cp(join(SSO, "snapshots"), join(root, "knowledge/snapshots"), { recursive: true });
  for (const r of parse(readFileSync(join(SSO, "knowledge.yaml"), "utf8")) as unknown[]) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(JSON.stringify(p.issues));
    const f = join(root, "knowledge/items", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(join(SSO, "scan.yaml"), join(root, "knowledge/scan.yaml"));
  return root;
}

const conflictOf = () =>
  (parse(readFileSync(join(SSO, "scan.yaml"), "utf8")) as { conflicts: KnowledgeConflict[] })
    .conflicts[0]!;

describe("a conflict as a question for a person", () => {
  it("is keyed by its topic and pages, in any order", () => {
    const c = conflictOf();
    expect(conflictKey(c)).toBe("sso-setup @ forge-wiki/sso-notes.md | forge-wiki/sso-setup.md");
    expect(conflictKey({ ...c, pages: [...c.pages].reverse() })).toBe(conflictKey(c));
  });

  it("quotes both pages, offers each page, both in different cases, and says what each changes", async () => {
    const root = await ssoRoot();
    const d = await conflictDraft(root, conflictOf());
    expect(QuestionDraft.parse(d)).toEqual(d);
    expect(d.question).toBe(
      'The wiki pages disagree on "Set up SSO for a Forge service" (sso-setup), the redirect URI: forge-wiki/sso-setup.md (last edited 2026-09-14) says "Set the redirect URI to /login/oauth2/code/forge-identity."; forge-wiki/sso-notes.md (last edited 2026-03-02) says "Set the redirect URI to /sso/callback.". Suggested: forge-wiki/sso-setup.md, by last-edited (sso-setup.md was last edited 2026-09-14, after sso-notes.md (2026-03-02)); a suggestion only. No fact verified from code settles it. Which page applies?',
    );
    expect(d.options[0]!.means).toBe(
      'Follow forge-wiki/sso-setup.md: "Set the redirect URI to /login/oauth2/code/forge-identity." Suggested, by last-edited: sso-setup.md was last edited 2026-09-14, after sso-notes.md (2026-03-02).',
    );
    expect(d.options.map((o) => o.label)).toEqual([
      "forge-wiki/sso-setup.md applies",
      "forge-wiki/sso-notes.md applies",
      "Both, in different cases",
    ]);
    expect(d.options[0]!.changes).toBe(
      "Tasks that use sso-setup show forge-wiki/sso-setup.md's words; forge-wiki/sso-notes.md is listed as disagreeing and not used.",
    );
    expect(d.options[2]!.means).toMatch(/say which case takes which page/);
    // The item's file, then each page's line in the snapshot, in the options' order.
    expect(d.evidence).toEqual([
      "knowledge/items/processdefinition/sso-setup.yaml:1",
      "knowledge/snapshots/forge-wiki/2026-10-20/sso-setup.md:6",
      "knowledge/snapshots/forge-wiki/2026-10-20/sso-notes.md:6",
    ]);
  });

  it("names each page's owner and last edit when the snapshot has them", async () => {
    const root = await ssoRoot();
    const f = join(root, "knowledge/snapshots/forge-wiki/2026-10-20/sso-notes.md");
    await writeFile(
      f,
      `---\nowner: Orders team\nupdated: 2026-03-02\n---\n${readFileSync(f, "utf8")}`,
    );
    const d = await conflictDraft(root, conflictOf());
    expect(d.question).toContain(
      'forge-wiki/sso-notes.md (owner Orders team, last edited 2026-03-02) says "Set the redirect URI to /sso/callback."',
    );
    expect(d.evidence).toContain("knowledge/snapshots/forge-wiki/2026-10-20/sso-notes.md:10");
  });

  it("reads the key back from the question, whatever the snapshot's date", async () => {
    const root = await ssoRoot();
    const c = conflictOf();
    const q = questionFromDraft(await conflictDraft(root, c), {
      step: CONFLICT_STEP,
      repo: "add-sso",
      command: "atticus plan small add-sso",
      rerun: "atticus task context add-sso 1.1",
      at: "2026-10-24T09:00:00Z",
    });
    expect(conflictKeyOfQuestion(root, q)).toBe(conflictKey(c));
    const later = {
      ...q,
      evidence: q.evidence.map((e) => e.replace("2026-10-20", "2026-11-02")),
    };
    expect(conflictKeyOfQuestion(root, later)).toBe(conflictKey(c));
    expect(conflictKeyOfQuestion(root, { ...q, askedBy: { ...q.askedBy, step: "other" } })).toBe(
      undefined,
    );
  });

  it("is undecided until a person answers, then applies the page they chose", async () => {
    const root = await ssoRoot();
    expect(await readConflicts(root)).toEqual([
      expect.objectContaining({ key: conflictKey(conflictOf()), applies: [] }),
    ]);
    const q = questionFromDraft(await conflictDraft(root, conflictOf()), {
      step: CONFLICT_STEP,
      repo: "add-sso",
      command: "atticus plan small add-sso",
      rerun: "atticus task context add-sso 1.1",
      at: "2026-10-24T09:00:00Z",
    });
    await writeQuestion(root, q);
    expect((await readConflicts(root))[0]).toMatchObject({
      question: { id: q.id, state: "open", repo: "add-sso" },
      applies: [],
    });
    await answerQuestion(root, q.id, { option: 2, by: "sam", at: "2026-10-24T10:00:00Z" });
    expect((await readConflicts(root))[0]).toMatchObject({
      question: { id: q.id, state: "answered" },
      applies: [{ source: "forge-wiki", page: "sso-notes.md" }],
      decided: { by: "person", who: "sam", at: "2026-10-24T10:00:00Z" },
    });
  });

  it("applies both pages when the person says both, in their own words", async () => {
    const root = await ssoRoot();
    const q = questionFromDraft(await conflictDraft(root, conflictOf()), {
      step: CONFLICT_STEP,
      repo: "add-sso",
      command: "atticus plan small add-sso",
      rerun: "atticus task context add-sso 1.1",
      at: "2026-10-24T09:00:00Z",
    });
    await writeQuestion(root, q);
    await answerQuestion(root, q.id, {
      text: "sso-setup.md for a web service, sso-notes.md for the batch jobs",
      by: "sam",
      at: "2026-10-24T10:00:00Z",
    });
    expect((await readConflicts(root))[0]).toMatchObject({
      applies: [
        { source: "forge-wiki", page: "sso-setup.md" },
        { source: "forge-wiki", page: "sso-notes.md" },
      ],
      decided: {
        by: "person",
        words: "sso-setup.md for a web service, sso-notes.md for the batch jobs",
      },
    });
  });

  it("keeps a signal the scan recorded as a suggestion, never a decision: nothing is picked silently", async () => {
    const root = await ssoRoot();
    const v = (await readConflicts(root))[0]!;
    expect(v.applies).toEqual([]);
    expect(v.decided).toBeUndefined();
    expect(v.suggested).toEqual({
      source: "forge-wiki",
      page: "sso-setup.md",
      signal: "last-edited",
      detail: "sso-setup.md was last edited 2026-09-14, after sso-notes.md (2026-03-02)",
    });
    expect(conflictLine(v)).toBe(
      'sso-setup (the redirect URI): forge-wiki/sso-setup.md says "Set the redirect URI to /login/oauth2/code/forge-identity."; forge-wiki/sso-notes.md says "Set the redirect URI to /sso/callback.". Undecided: a change that relies on it asks a person; forge-wiki/sso-setup.md suggested by last-edited (sso-setup.md was last edited 2026-09-14, after sso-notes.md (2026-03-02)).',
    );
  });
});

/** A fact verified from code: the service's OAuth redirect endpoint (invented, Forge). */
const redirectEndpoint = {
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

describe("a conflict the code settles (a document never overrides a fact verified from code)", () => {
  it("reads the values code could hold: paths, URLs and dotted keys, never bare words", () => {
    expect(valuesOf("Set the redirect URI to /login/oauth2/code/forge-identity.")).toEqual([
      "/login/oauth2/code/forge-identity",
    ]);
    expect(
      valuesOf("Use `spring.security.oauth2.client` and https://id.forge.example/keys."),
    ).toEqual([
      "spring.security.oauth2.client",
      "https://id.forge.example/keys",
      "id.forge.example",
    ]);
    expect(valuesOf('Read the caller from the "email" claim.')).toEqual([]);
  });

  it("settles for the one page whose own value a verified record holds, and cites it", () => {
    const c = conflictOf();
    expect(codeSettles(c, [redirectEndpoint])).toEqual({
      page: { source: "forge-wiki", page: "sso-setup.md" },
      record: "forge-orders.get-login-oauth2-code-forge-identity",
      kind: "Endpoint",
      value: "/login/oauth2/code/forge-identity",
      at: "forge-orders:src/main/resources/application.yml:12",
    });
    // Inferred, or read from a document: not a fact verified from code.
    expect(codeSettles(c, [{ ...redirectEndpoint, confidence: "inferred" }])).toBeUndefined();
    expect(
      codeSettles(c, [{ ...redirectEndpoint, evidence: [{ source: "document", path: "x.md" }] }]),
    ).toBeUndefined();
    // Code that holds both pages' values settles nothing.
    expect(
      codeSettles(c, [
        redirectEndpoint,
        {
          ...redirectEndpoint,
          id: "forge-orders.get-sso-callback",
          pathOrTopic: "/sso/callback",
          normalizedPath: "/sso/callback",
        },
      ]),
    ).toBeUndefined();
  });

  it("is decided by the code before any answer, says so, and isn't a person's question", async () => {
    const root = await ssoRoot();
    const v = (await readConflicts(root, { records: [redirectEndpoint] }))[0]!;
    expect(v).toMatchObject({
      applies: [{ source: "forge-wiki", page: "sso-setup.md" }],
      decided: {
        by: "code",
        record: "forge-orders.get-login-oauth2-code-forge-identity",
        value: "/login/oauth2/code/forge-identity",
        at: "forge-orders:src/main/resources/application.yml:12",
      },
    });
    expect(conflictLine(v)).toContain(
      "The code settles it: forge-wiki/sso-setup.md applies (Endpoint forge-orders.get-login-oauth2-code-forge-identity has /login/oauth2/code/forge-identity, verified from code at forge-orders:src/main/resources/application.yml:12).",
    );
  });
});
