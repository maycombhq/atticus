import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Api, serializeAuditFile, type AuditFileT } from "@maycombhq/core";
import { repoFactsView } from "../src/ui-api-facts.js";
import { trustView } from "../src/ui-api-trust.js";

/**
 * P3 (ADR 0148, C4 2.37.0): the sample audit on Map › Trust, and a fact answered right shown as
 * `verified: sample` in the repo's facts while it still cites the line the person saw.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FACTS = join(HERE, "../../verify/test/fixtures/forge-ledger.facts.jsonl");

const AUDIT: AuditFileT = {
  schema: 1,
  repo: "forge-ledger",
  draws: [{ seed: "s", size: 2, commit: "0123abc", at: "2026-10-31T10:00:00.000Z" }],
  items: [
    {
      id: "fact:e-get-account",
      kind: "fact",
      of: "entry",
      claim: "entry GET /accounts/{accountId}",
      cites: ["src/main/java/forge/ledger/AccountController.java:18"],
      fact: "e-get-account",
      value: "/accounts/{accountId}",
      answer: "right",
    },
    {
      id: "fact:e-post-entry",
      kind: "fact",
      of: "entry",
      claim: "entry POST /accounts/{accountId}/entries",
      // The fact was read again since: it cites line 22 now, so this answer is gone.
      cites: ["src/main/java/forge/ledger/EntryController.java:21"],
      fact: "e-post-entry",
      answer: "right",
    },
    {
      id: "link:c-x",
      kind: "link",
      of: "joined-by-host",
      claim: "forge-ledger POST /x -> forge-audit POST /x",
      cites: ["forge-ledger src/X.java:3"],
      fact: "c-x",
      to: "forge-audit",
      answer: "wrong",
    },
  ],
};

describe("the sample audit in the app", () => {
  it("gives Trust the precision, and the facts list verified: sample where it still holds", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-audit-trust-"));
    await mkdir(join(root, "facts"), { recursive: true });
    const text = (await readFile(FACTS, "utf8")).split("\n").filter(Boolean).slice(0, 2).join("\n");
    await writeFile(join(root, "facts/forge-ledger.jsonl"), `${text}\n`);
    await writeFile(join(root, "facts/forge-ledger.audit.yaml"), serializeAuditFile(AUDIT));

    const view = Api.TrustView.parse(await trustView(root));
    const r = view.repos.find((x) => x.repo === "forge-ledger")!;
    expect(r.audit?.path).toBe("facts/forge-ledger.audit.yaml");
    expect(r.audit?.facts).toMatchObject({ drawn: 2, right: 1, gone: 1, precision: 1 });
    expect(r.audit?.links).toMatchObject({ drawn: 1, wrong: 1, precision: 0 });
    expect(r.audit?.byKind.entry).toMatchObject({ right: 1 });
    // The audit file is a companion, never a repo of its own.
    expect(view.repos.filter((x) => x.repo.includes("audit"))).toEqual([]);

    const facts = await repoFactsView(root, "forge-ledger");
    expect(facts.facts.find((f) => f.id === "e-get-account")?.verified).toBe("sample");
    expect(facts.facts.find((f) => f.id === "e-post-entry")?.verified).toBe("line");
    // The facts file itself keeps the verifier's mark.
    expect(await readFile(join(root, "facts/forge-ledger.jsonl"), "utf8")).not.toContain(
      '"sample"',
    );
  });
});
