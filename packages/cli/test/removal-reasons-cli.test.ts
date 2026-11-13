import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, serializeRecord, type CatalogRecord } from "@maycombhq/core";
import type { BuildRefusal } from "@maycombhq/scanner";
import { refusalPlanOf } from "../src/build-report.js";
import { verifyCommand } from "../src/verify-commands.js";
import { verifyConfirmed } from "./seed-slots.js";

const { main } = await import("../src/main.js");

/**
 * beta.28 field report: the first `atticus verify <repo> --write` after `atticus upgrade` refused
 * 116 removals, each said as "<repo> is built from its facts snapshot now; <repo>'s facts
 * snapshot changed": true of every record of the repo, and nothing about each one. Here a
 * catalog from before the slots (beta.26, re-made with the invented Forge estate) whose
 * forge-payments has an endpoint under the id its readers gave (the facts' read keys it
 * otherwise) and one no fact makes; upgraded, then the repo verified from its facts: each removal
 * says which record comes back in its place, or that no fact of the read makes it, and the
 * refusal says how many records the same build adds. Files only, no network.
 */
const FIX = join(__dirname, "..", "..", "..", "fixtures", "gateway-facts", "policy-tokens");
const COMMIT: Record<string, string> = {
  "northwind_pay_1-0": "7777ccc",
  "forge-payments": "5555ddd",
  "forge-refunds": "6666eee",
  "forge-checkout": "4444fff",
};
const REPO = "forge-payments";
const AT = new Date("2026-11-12T10:00:00.000Z");

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

function metarepo(): string {
  const root = mkdtempSync(join(tmpdir(), "atticus-removal-reasons-"));
  temps.push(root);
  cpSync(join(FIX, "org-pack"), join(root, "org-pack"), { recursive: true });
  mkdirSync(join(root, "facts"), { recursive: true });
  for (const r of Object.keys(COMMIT)) {
    cpSync(join(FIX, "repos", r), join(root, "workspace", r), { recursive: true });
    writeFileSync(
      join(root, "facts", `${r}.jsonl`),
      readFileSync(join(FIX, "facts", `${r}.jsonl`), "utf8"),
    );
  }
  return root;
}

const opts = (root: string, repo: string) => ({
  commit: COMMIT[repo]!,
  dir: join(root, "workspace", repo),
  write: true,
  now: () => AT,
});

/** A catalog from before the slots with forge-payments' re-keyed and extra endpoints, upgraded. */
async function upgraded(): Promise<string> {
  const root = metarepo();
  const quiet = { out: () => {}, err: () => {} };
  for (const r of Object.keys(COMMIT))
    expect(await verifyConfirmed(root, r, opts(root, r), quiet)).toBe(0);
  // A catalog from before the slots: no sources, no build log.
  rmSync(join(root, "catalog", "sources"), { recursive: true, force: true });
  rmSync(join(root, ".atticus"), { recursive: true, force: true });
  const dir = join(root, "catalog", "generated", "endpoint");
  const read = (id: string) =>
    parse(readFileSync(join(dir, `${id}.yaml`), "utf8")) as CatalogRecord;
  const write = (r: CatalogRecord) => {
    expect(parseRecord(r).ok).toBe(true);
    writeFileSync(join(dir, `${r.id}.yaml`), serializeRecord(r));
  };
  // The readers keyed GET /payments/{id} by its path; the facts' read keys it by its handler.
  const get = read("payments-api.get-payment");
  rmSync(join(dir, "payments-api.get-payment.yaml"));
  write({ ...get, id: "payments-api.get-payments-id" });
  // And the readers found a DELETE the facts' read doesn't have.
  write({
    ...get,
    id: "payments-api.delete-payment",
    method: "DELETE",
  } as CatalogRecord);
  const up: string[] = [];
  const code = await main(["upgrade", "--yes", "--root", root], {
    out: (l) => up.push(l),
    err: (l) => up.push(l),
  });
  expect(code, up.join("\n")).toBe(0);
  return root;
}

describe("a removal says what it is to its record (beta.28)", () => {
  it("after the upgrade, names the record that comes back and the one no fact makes, and what the build adds", async () => {
    const root = await upgraded();
    const out: string[] = [];
    const refused = await verifyCommand(root, REPO, opts(root, REPO), {
      out: (l) => out.push(l),
      err: (l) => out.push(l),
    });
    const said = out.join("\n");
    expect(refused, said).not.toBe(0);
    expect(said).toContain(
      `This would remove 2 records (2 of ${REPO}'s 6, and adds 1), more than 10% of a repo's records`,
    );
    const why = (id: string) =>
      out
        .find((l) => l.startsWith(`  would remove Endpoint/${id}: `))
        ?.split(": ")
        .slice(1)
        .join(": ");
    // Each says what it is to its own record first, then what changed (kept as it was).
    expect(why("payments-api.get-payments-id")).toMatch(
      new RegExp(
        `^comes back as Endpoint/payments-api\\.get-payment; ${REPO} is built from its facts snapshot now \\(`,
      ),
    );
    expect(why("payments-api.delete-payment")).toMatch(
      new RegExp(
        `^no fact of ${REPO}'s read makes it; ${REPO} is built from its facts snapshot now \\(`,
      ),
    );
  }, 120_000);

  it("never says no fact makes a record a curated suppress removes, and lists the same each time", async () => {
    const root = await upgraded();
    // A person suppresses an endpoint the facts make.
    const dec = join(root, "catalog", "curated", "curateddecision");
    mkdirSync(dec, { recursive: true });
    writeFileSync(
      join(dec, "dec-suppress-post-payment.yaml"),
      [
        "schemaVersion: 2",
        "kind: CuratedDecision",
        "id: dec-suppress-post-payment",
        "status: current",
        "confidence: asserted",
        "evidence: []",
        "target: payments-api.post-payment",
        "action: suppress",
        "value: null",
        "reason: not ours",
        "by: pat",
        "at: 2026-11-12T00:00:00Z",
        "",
      ].join("\n"),
    );
    const refusal = async () => {
      const out: string[] = [];
      const code = await verifyCommand(
        root,
        REPO,
        { ...opts(root, REPO), json: true },
        { out: (l) => out.push(l), err: (l) => out.push(l) },
      );
      expect(code).not.toBe(0);
      const j = JSON.parse(out.find((l) => l.trimStart().startsWith("{")) ?? out.join("\n")) as {
        refused: Pick<BuildRefusal, "removals" | "edits">;
      };
      return j.refused;
    };
    const one = await refusal();
    const post = one.removals!.find((x) => x.id === "payments-api.post-payment");
    expect(post?.reasons).toContain("curated");
    expect(post?.explainedBy).toContain("a curated suppress");
    expect(post?.explainedBy.some((w) => w.startsWith("no fact of"))).toBe(false);
    expect(one.removals!.find((x) => x.id === "payments-api.delete-payment")?.explainedBy[0]).toBe(
      `no fact of ${REPO}'s read makes it`,
    );
    // The same build refused again lists the same, so a confirm of what was shown matches.
    const two = await refusal();
    expect(refusalPlanOf(two)).toBe(refusalPlanOf(one));
  }, 120_000);
});
