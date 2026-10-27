import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  fileJudgments,
  makeJudgment,
  parseRecord,
  recordPath,
  serializeRecord,
} from "@maycombhq/core";
import { runCritic, type CriticResult } from "../src/index.js";
import { CHANGE, NOW, changeDir, forgeChangeRoot, write } from "./helpers.js";

/**
 * What the critic does with who a gateway route lets in (ADR 0124 addendum A-callers), on the
 * Forge change add-transfer-limit, which changes POST /transfers through the gateway route
 * gw-ledger-v1. The route's consumers are AccessGrants on it (the consumers its files name) and
 * asserted Interfaces through it (the systems a person declared). No new check beyond what the
 * facts support: `constitution.breaking-delta-consumers` lists them as affected, and a route nothing
 * names, declares or calls asks who calls it (`constitution.route-callers-known`, question
 * `complete`).
 */

const BREAKING = "constitution.breaking-delta-consumers";
const KNOWN = "constitution.route-callers-known";
const of = (r: CriticResult, rule: string) => r.findings.filter((f) => f.finding.rule === rule);

async function record(root: string, r: Record<string, unknown>) {
  const p = parseRecord({ schemaVersion: 1, status: "current", confidence: "verified", ...r });
  if (!p.ok) throw new Error(`bad record ${String(r.id)}: ${JSON.stringify(p)}`);
  await write(root, join("catalog/generated", recordPath(p.record)), serializeRecord(p.record));
}

async function edit(root: string, rel: string, from: string, to: string) {
  const p = join(changeDir(root), rel);
  const text = await readFile(p, "utf8");
  if (!text.includes(from)) throw new Error(`${rel} has no "${from}"`);
  await writeFile(p, text.replace(from, to));
}

const ROUTE_LINE = {
  source: "gateway",
  repo: "forge-gateway",
  path: "proxies/ledger-v1/apiproxy/proxies/default.xml",
  line: 9,
  side: "gateway",
};
const APPS = "resources/edge/org/developerApps.json";
/** The consumers gw-ledger-v1's files name: two developer apps and the API product. */
const GRANTS = [
  ["teller-app", "app", "oauth-client", 4],
  ["branch-desk-web", "app", "oauth-client", 9],
  ["ledger-partners", "product", "group", 3],
].map(([subject, as, subjectKind, line]) => ({
  kind: "AccessGrant",
  id: `ag-ledger-v1-${as}-${subject}`,
  subjectKind,
  subject,
  resource: "gw-ledger-v1",
  scopesOrPermissions: ["ledger.write"],
  flags: [`caller:${as}`],
  evidence: [
    {
      source: "gateway",
      repo: "forge-gateway",
      path: as === "product" ? "resources/edge/org/apiProducts.json" : APPS,
      line,
      side: "gateway",
    },
  ],
}));
/** Branch Desk, which nobody scans, declared by a person as the app branch-desk-web. */
const BRANCH_DESK = [
  {
    kind: "System",
    id: "branch-desk",
    name: "Branch Desk",
    boundary: "internal",
    owner: "team-branch",
    evidence: [{ source: "manual", by: "person" }],
  },
  {
    kind: "Interface",
    id: "if-15210260a0a316f6",
    confidence: "asserted",
    from: "branch-desk",
    to: "ledger-api",
    endpoint: "ledger-api.post-transfer",
    via: "gateway",
    route: "gw-ledger-v1",
    method: "POST",
    normalizedPath: "/transfers",
    auth: "oauth2",
    sync: "sync",
    flags: ["declared-caller"],
    evidence: [
      { source: "manual", path: "profiles/forge/profile.yaml", by: "person" },
      ROUTE_LINE,
      { source: "gateway", repo: "forge-gateway", path: APPS, line: 9, side: "gateway" },
    ],
  },
];

describe("a change to a route's contract lists everyone the route lets in", () => {
  it("names the consumers the route's files name, and a declared caller as a person's word", async () => {
    const root = await forgeChangeRoot();
    for (const r of [...GRANTS, ...BRANCH_DESK]) await record(root, r);
    const f = of(await runCritic(root, CHANGE, { now: NOW }), BREAKING);
    // Nobody has judged whether callers must change: asked, naming every one of them.
    expect(f.map((x) => x.finding.kind)).toEqual(["knowledge-gap"]);
    // The summary is capped; the question a person answers names them all.
    expect(f[0]!.finding.summary).toMatch(
      /^Nobody has judged whether the change to POST \/transfers breaks Branch Desk \(declared; app branch-desk-web\), app teller-app and product ledger-partners, /,
    );
    expect(f[0]!.finding.question?.text).toBe(
      "Must Branch Desk (declared; app branch-desk-web), app teller-app and product ledger-partners change their code to keep working once POST /transfers changes as interfaces.md says?",
    );
    expect(f[0]!.finding.why).toContain("through gw-ledger-v1");
    expect(f[0]!.finding.evidence).toEqual(
      expect.arrayContaining([
        { source: "catalog", record: "if-15210260a0a316f6" },
        { source: "catalog", record: "ag-ledger-v1-app-teller-app" },
        { source: "catalog", record: "ag-ledger-v1-product-ledger-partners" },
      ]),
    );
    // The linked app is named once, as the declared system it is.
    expect(f[0]!.finding.summary).not.toContain("app branch-desk-web,");
  });

  it("blocks when a caller must change, naming them all", async () => {
    const root = await forgeChangeRoot();
    for (const r of GRANTS) await record(root, r);
    await fileJudgments(root).put(
      makeJudgment({
        kind: "breaking",
        inputs: {
          v: 1,
          change: "planned-modify",
          operation: "POST /transfers",
          caller: "portal-bff",
          callee: "ledger-api",
          notes:
            "POST /transfers gains the LIMIT_EXCEEDED error (HTTP 422) and still goes through gw-ledger-v1.",
        },
        verdict: "yes",
        confirmedBy: { by: "person", name: "ari" },
        at: NOW,
      }),
    );
    const f = of(await runCritic(root, CHANGE, { now: NOW }), BREAKING);
    expect(f.map((x) => [x.finding.kind, x.finding.severity, x.finding.summary])).toEqual([
      [
        "issue",
        "blocking",
        "Changing POST /transfers breaks app branch-desk-web, app teller-app and product ledger-partners, which call it today and which the change doesn't plan for.",
      ],
    ]);
  });

  it("says nothing new where the route names nobody and nobody is declared", async () => {
    const f = of(await runCritic(await forgeChangeRoot(), CHANGE, { now: NOW }), BREAKING);
    expect(f).toEqual([]);
  });
});

describe("a route whose callers are unknown is a question for the change (complete)", () => {
  const BARE_ROUTE = {
    kind: "GatewayRoute",
    id: "gw-transfers-v3",
    proxy: "transfers-v3",
    basepath: "/transfers/v3",
    target: "ledger-api",
    policies: ["VerifyOAuth"],
    scopes: ["ledger.write"],
    evidence: [
      {
        source: "gateway",
        repo: "forge-gateway",
        path: "proxies/transfers-v3/apiproxy/proxies/default.xml",
        line: 5,
        side: "gateway",
      },
      {
        source: "gateway",
        repo: "forge-gateway",
        path: "proxies/transfers-v3/apiproxy/proxies/default.xml",
        line: 5,
        side: "gateway",
      },
    ],
  };

  it("asks who calls a route the change names that nothing names, declares or calls", async () => {
    const root = await forgeChangeRoot();
    await record(root, BARE_ROUTE);
    await edit(
      root,
      "interfaces.md",
      "and still goes through gw-ledger-v1.",
      "and still goes through gw-ledger-v1, and now gw-transfers-v3 too.",
    );
    const f = of(await runCritic(root, CHANGE, { now: NOW }), KNOWN);
    expect(f.map((x) => [x.finding.kind, x.finding.artifact])).toEqual([
      ["knowledge-gap", "interfaces.md"],
    ]);
    expect(f[0]!.finding.summary).toBe(
      "Nobody knows who calls POST /transfers through the gateway route gw-transfers-v3.",
    );
    expect(f[0]!.finding.question?.text).toBe(
      "Who calls POST /transfers through gw-transfers-v3 (transfers-v3 /transfers/v3)? Its files name no consumer, nobody has declared one, and no repo Atticus reads calls through it.",
    );
    expect(f[0]!.finding.fix.text).toContain("profile");
    expect(f[0]!.finding.evidence).toContainEqual({ source: "catalog", record: "gw-transfers-v3" });
  });

  it("finds a route by the gateway's own forwarding call into the service", async () => {
    const root = await forgeChangeRoot();
    await record(root, {
      ...BARE_ROUTE,
      evidence: [
        BARE_ROUTE.evidence[0],
        {
          source: "gateway",
          repo: "forge-gateway",
          path: "proxies/transfers-v3/apiproxy/targets/ledger.xml",
          line: 3,
          side: "gateway",
        },
      ],
    });
    await record(root, {
      kind: "Interface",
      id: "if-732c17cd0e76c4fa",
      from: "forge-gateway",
      to: "ledger-api",
      endpoint: "ledger-api.post-transfer",
      via: "direct",
      method: "POST",
      normalizedPath: "/transfers",
      sync: "sync",
      evidence: [
        {
          source: "gateway",
          repo: "forge-gateway",
          path: "proxies/transfers-v3/apiproxy/targets/ledger.xml",
          line: 3,
          side: "caller",
        },
      ],
    });
    const f = of(await runCritic(root, CHANGE, { now: NOW }), KNOWN);
    expect(f.map((x) => x.finding.summary)).toEqual([
      "Nobody knows who calls POST /transfers through the gateway route gw-transfers-v3.",
    ]);
  });

  it("asks nothing where the route has a caller: the change's own hop, a named consumer or a declared one", async () => {
    // gw-ledger-v1 is called by portal-bff, the change's own hop.
    expect(of(await runCritic(await forgeChangeRoot(), CHANGE, { now: NOW }), KNOWN)).toEqual([]);
    const root = await forgeChangeRoot();
    await record(root, BARE_ROUTE);
    await record(root, {
      ...GRANTS[0]!,
      id: "ag-transfers-v3-app-teller-app",
      resource: "gw-transfers-v3",
    });
    await edit(
      root,
      "interfaces.md",
      "and still goes through gw-ledger-v1.",
      "and still goes through gw-ledger-v1, and now gw-transfers-v3 too.",
    );
    expect(of(await runCritic(root, CHANGE, { now: NOW }), KNOWN)).toEqual([]);
  });
});
