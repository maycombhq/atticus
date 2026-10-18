import { readFileSync } from "node:fs";
import { cp, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  driftExitCode,
  DriftError,
  repoDrift,
  resolveCatalog,
  type DriftReport,
} from "../src/index.js";
import { metarepo, put, repoDir, SCANNED_AT } from "./helpers.js";

const FORGE_REPOS = [
  "forge-portal-ui",
  "forge-portal-bff",
  "forge-ledger",
  "forge-reports-job",
  "forge-gateway",
  "forge-events",
  "forge-infra",
];
const COMMIT = "a".repeat(40);

const run = (root: string, repo: string, extra: Partial<Parameters<typeof repoDrift>[0]> = {}) =>
  repoDrift({
    repoDir: repoDir(root, repo),
    catalog: root,
    commit: COMMIT,
    scannedAt: SCANNED_AT,
    ...extra,
  });

const view = (r: DriftReport) =>
  r.items.map((i) => ({
    kind: i.kind,
    subject: i.subject,
    id: i.subject === "loose-end" ? "(loose end)" : i.id,
    ...(i.change ? { change: i.change } : {}),
    ...(i.changes ? { changes: i.changes } : {}),
  }));

/**
 * The add-transfer-limit change built in forge-ledger, plus three things its design doesn't
 * have: a DELETE endpoint, a changed auth on the balance endpoint, the vendor call removed,
 * and a publish to a topic nobody subscribes to.
 */
async function buildLedger(root: string): Promise<string> {
  // A working copy beside the repos (the Forge dialect's own tests read repos/forge-ledger).
  const dir = join(root, "..", "work", "forge-ledger");
  await cp(repoDir(root, "forge-ledger"), dir, { recursive: true });
  await put(
    dir,
    "src/main/java/forge/ledger/LedgerEndpoints.java",
    `package forge.ledger;

import forge.framework.*;

@ForgeService(name = "ledger-api")
public class LedgerEndpoints {

  @ForgeEndpoint(method = "GET", path = "/accounts/{id}/balance", auth = "api-key")
  public Balance balance(String id) { return null; }

  @ForgeEndpoint(method = "POST", path = "/transfers", auth = "oauth2")
  public TransferResult transfer(TransferRequest request) { return null; }

  @ForgeEndpoint(method = "GET", path = "/accounts/{id}/limit", auth = "oauth2")
  public Limit limit(String id) { return null; }

  @ForgeEndpoint(method = "DELETE", path = "/transfers/{id}", auth = "oauth2")
  public void cancel(String id) { }
}
`,
  );
  await rm(join(dir, "src/main/java/forge/ledger/NorthwindClient.java"));
  await put(
    dir,
    "src/main/java/forge/ledger/LedgerEvents.java",
    `package forge.ledger;

import forge.framework.*;

public class LedgerEvents {
  @ForgeSubscribe(topic = "payments.initiated")
  public void onPaymentInitiated(Object payment) { }

  @ForgePublish(topic = "transfers.completed")
  public Object transferCompleted(Object transfer) { return transfer; }

  @ForgePublish(topic = "limits.changed")
  public Object limitChanged(Object change) { return change; }
}
`,
  );
  await put(
    dir,
    "src/main/resources/db/migration/V3__add_daily_limit.sql",
    "ALTER TABLE account ADD COLUMN daily_limit NUMERIC(18,2) NOT NULL DEFAULT 1000;\n",
  );
  await put(
    dir,
    "src/main/resources/db/migration/V4__create_limit_change.sql",
    `CREATE TABLE limit_change (
  id BIGINT PRIMARY KEY,
  account_id BIGINT NOT NULL,
  old_limit NUMERIC(18,2),
  new_limit NUMERIC(18,2),
  changed_by_email VARCHAR(200),
  changed_at TIMESTAMP
);
`,
  );
  return dir;
}

const runBuilt = (
  root: string,
  dir: string,
  extra: Partial<Parameters<typeof repoDrift>[0]> = {},
) =>
  repoDrift({
    repoDir: dir,
    catalog: root,
    repo: "forge-ledger",
    commit: COMMIT,
    scannedAt: SCANNED_AT,
    ...extra,
  });

const LIMIT_CHANGE_COLUMNS = [
  "account-id",
  "changed-at",
  "changed-by-email",
  "id",
  "new-limit",
  "old-limit",
];

describe("drift check (pipeline)", () => {
  it("finds no drift in any Forge repo against the Forge catalog", async () => {
    const root = await metarepo();
    for (const repo of FORGE_REPOS) {
      const r = await run(root, repo);
      expect(r.problems, repo).toEqual([]);
      expect(view(r), repo).toEqual([]);
      expect(r.drift).toBe(false);
      expect(driftExitCode(r)).toBe(0);
    }
  });

  it("reports what an approved design plans as planned, and the rest as drift", async () => {
    const root = await metarepo({ change: "build" });
    const r = await runBuilt(root, await buildLedger(root));
    expect(r.problems).toEqual([]);
    expect(r.changes).toEqual(["add-transfer-limit"]);
    expect(view(r)).toEqual([
      { kind: "added", subject: "endpoint", id: "ledger-api.delete-transfer" },
      {
        kind: "changed",
        subject: "endpoint",
        id: "ledger-api.get-balance",
        changes: [{ field: "auth", catalog: "oauth2", code: "api-key" }],
      },
      { kind: "removed", subject: "call", id: "if-e7344c9455608119" },
      { kind: "unknown", subject: "loose-end", id: "(loose end)" },
      // ALTER TABLE ... ADD COLUMN gives a column record (migrations extractor 1.1.0).
      {
        kind: "planned",
        subject: "column",
        id: "ledger-db.account.daily-limit",
        change: "add-transfer-limit",
      },
      ...LIMIT_CHANGE_COLUMNS.map((c) => ({
        kind: "planned",
        subject: "column",
        id: `ledger-db.limit-change.${c}`,
        change: "add-transfer-limit",
      })),
      {
        kind: "planned",
        subject: "endpoint",
        id: "ledger-api.get-limit",
        change: "add-transfer-limit",
      },
      { kind: "planned", subject: "migration", id: "ledger-db.v3", change: "add-transfer-limit" },
      { kind: "planned", subject: "migration", id: "ledger-db.v4", change: "add-transfer-limit" },
      {
        kind: "planned",
        subject: "table",
        id: "ledger-db.limit-change",
        change: "add-transfer-limit",
      },
    ]);
    expect(r.items.find((i) => i.kind === "unknown")!.summary).toBe(
      "event-publish limits.changed from ledger-api: Atticus can't tell where it goes.",
    );
    expect(r.items.find((i) => i.kind === "removed")!.summary).toBe(
      "ledger-api calls northwind-pay POST /v2/payments is in the catalog but no longer in the code.",
    );
    expect(r.counts).toEqual({ added: 1, changed: 1, removed: 1, unknown: 1, planned: 11 });
    expect(r.drift).toBe(true);
    expect(driftExitCode(r)).toBe(1);
  });

  it("treats everything new as drift when no approved change plans it", async () => {
    const root = await metarepo();
    const r = await runBuilt(root, await buildLedger(root));
    expect(r.changes).toEqual([]);
    expect(r.counts).toEqual({ added: 12, changed: 1, removed: 1, unknown: 1, planned: 0 });
  });

  it("only warns when the org pack or the pipeline says so, and ignores what the org pack lists", async () => {
    const root = await metarepo({
      ciYaml: "schemaVersion: 1\ndrift:\n  mode: warn\n  ignore: [ledger-api.delete-*]\n",
    });
    const r = await runBuilt(root, await buildLedger(root));
    expect(r.mode).toBe("warn");
    expect(r.items.some((i) => i.id === "ledger-api.delete-transfer")).toBe(false);
    expect(r.drift).toBe(true);
    expect(driftExitCode(r)).toBe(0);
    const plain = await metarepo();
    const w = await runBuilt(plain, await buildLedger(plain), { warnOnly: true });
    expect(w.mode).toBe("warn");
    expect(driftExitCode(w)).toBe(0);
  });

  it("reads a fetched copy of the catalog folder as well as a metarepo", async () => {
    const root = await metarepo();
    await cp(join(root, "catalog"), join(root, "..", "catalog-copy"), { recursive: true });
    expect(resolveCatalog(root).root).toBe(root);
    expect(resolveCatalog(join(root, "..", "catalog-copy")).generated).toBe(
      join(root, "..", "catalog-copy", "generated"),
    );
    // Without the org pack, the catalog says which component the repo builds.
    const r = await run(root, "forge-portal-bff", {
      catalog: join(root, "..", "catalog-copy"),
      repo: "forge-portal-bff",
    });
    expect(view(r)).toEqual([]);
  });

  it("fails with a plain message when the repo or the catalog isn't there", async () => {
    const root = await metarepo();
    await expect(run(root, "forge-nope")).rejects.toThrow(DriftError);
    await expect(run(root, "forge-ledger", { catalog: join(root, "no-catalog") })).rejects.toThrow(
      /There is no catalog at/,
    );
  });

  it("never reads the metarepo checked out inside the repo as code", async () => {
    const root = await metarepo();
    const inner = join(repoDir(root, "forge-portal-ui"), "atticus-metarepo");
    await cp(root, inner, { recursive: true });
    const r = await repoDrift({
      repoDir: repoDir(root, "forge-portal-ui"),
      catalog: inner,
      commit: COMMIT,
      scannedAt: SCANNED_AT,
    });
    expect(view(r)).toEqual([]);
    expect(readFileSync(join(inner, "org-pack/pack.yaml"), "utf8")).toContain("forge");
  });
});
