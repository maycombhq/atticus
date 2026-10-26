import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { runCritic, type CriticResult } from "../src/index.js";
import { CHANGE, NOW, changeDir, forgeChangeRoot, write } from "./helpers.js";

/**
 * What the critic does with the scopes a gateway route demands (ADR 0124 addendum A-gateway2).
 * The route is read from the facts, so the catalog's GatewayRoute carries them; the check is
 * `constitution.public-entry-auth` (question `safe`), and the four questions are unchanged.
 */

const RULE = "constitution.public-entry-auth";
/** The rule's findings about scopes, told apart by what each says (a Finding keeps no key). */
const KINDS = {
  "scope-none": /demands no scope\.$/,
  "scope-caller": /^(GET|POST) .* and the token .* is itself called with holds /,
  "scope-unknown": /^The criteria ask for the scope /,
};
const of = (r: CriticResult, kind: keyof typeof KINDS) =>
  r.findings.filter((f) => f.finding.rule === RULE && KINDS[kind].test(f.finding.summary));

/** Add (or replace) a catalog record in a test metarepo. */
async function record(root: string, r: Record<string, unknown>) {
  const p = parseRecord({ schemaVersion: 1, status: "current", confidence: "verified", ...r });
  if (!p.ok) throw new Error(`bad record ${String(r.id)}: ${JSON.stringify(p)}`);
  await write(root, join("catalog/generated", recordPath(p.record)), serializeRecord(p.record));
}

const LEDGER_ROUTE = {
  kind: "GatewayRoute",
  id: "gw-ledger-v1",
  proxy: "ledger-v1",
  basepath: "/ledger/v1",
  target: "ledger-api",
  policies: ["VerifyOAuth", "SpikeArrest"],
  evidence: [
    {
      source: "gateway",
      repo: "forge-gateway",
      path: "proxies/ledger-v1/apiproxy/proxies/default.xml",
      line: 9,
      side: "gateway",
    },
  ],
};

/** An Interface into portal-bff through a route, so the facts say what its callers' tokens hold. */
const INTO_BFF = (scopes: string[]) => [
  {
    kind: "GatewayRoute",
    id: "gw-portal-v1",
    proxy: "portal-v1",
    basepath: "/portal/v1",
    target: "portal-bff",
    policies: ["VerifyOAuth"],
    scopes,
    evidence: [
      {
        source: "gateway",
        repo: "forge-gateway",
        path: "proxies/portal-v1/apiproxy/proxies/default.xml",
        line: 7,
        side: "gateway",
      },
    ],
  },
  {
    kind: "Interface",
    id: "if-7ef9be25808276f8",
    from: "portal-ui",
    to: "portal-bff",
    via: "gateway",
    route: "gw-portal-v1",
    method: "POST",
    normalizedPath: "/transfers",
    auth: "oauth2",
    sync: "sync",
    evidence: [
      {
        source: "code",
        repo: "forge-portal-ui",
        path: "src/app/transfer.service.ts",
        line: 20,
        side: "caller",
      },
    ],
  },
];

async function story(root: string, from: string, to: string) {
  const p = join(changeDir(root), "stories/s1-refuse-over-limit.md");
  const text = await readFile(p, "utf8");
  if (!text.includes(from)) throw new Error("story line not found");
  await writeFile(p, text.replace(from, to));
}

const CRITERION =
  "- Given an account with a limit of 1000 that has sent 900 today, when it asks to send 200, then the transfer is refused with LIMIT_EXCEEDED and nothing is posted.";

describe("the critic and a gateway route's scopes (A-gateway2)", () => {
  it("passes a route that demands a scope, and says so when one demands none", async () => {
    // The fixture's gw-ledger-v1 demands ledger.read and ledger.write: nothing to say.
    const ok = await forgeChangeRoot();
    expect(of(await runCritic(ok, CHANGE, { now: NOW }), "scope-none")).toEqual([]);

    // The same route with its scopes empty: every token the gateway accepts gets through.
    const bare = await forgeChangeRoot();
    await record(bare, { ...LEDGER_ROUTE, scopes: [] });
    const hits = of(await runCritic(bare, CHANGE, { now: NOW }), "scope-none");
    expect(hits.map((x) => [x.finding.kind, x.finding.artifact])).toEqual([
      ["issue", "interfaces.md"],
      ["issue", "interfaces.md"],
    ]);
    expect(hits[0]!.finding.summary).toBe(
      "The gateway route gw-ledger-v1 that carries POST /transfers demands no scope.",
    );
    expect(hits[0]!.finding.why).toContain("any token the gateway accepts reaches ledger-api");
    expect(hits[0]!.finding.fix.text).toContain("OAuthV2 `<Scope>`");
    expect(hits[0]!.finding.evidence).toContainEqual({
      source: "catalog",
      record: "gw-ledger-v1",
    });
  });

  it("asks how a caller gets a token for a scope its own callers' tokens don't hold", async () => {
    const root = await forgeChangeRoot();
    for (const r of INTO_BFF(["portal.read"])) await record(root, r);
    const gaps = of(await runCritic(root, CHANGE, { now: NOW }), "scope-caller");
    expect(gaps.map((x) => x.finding.kind)).toEqual(["knowledge-gap", "knowledge-gap"]);
    expect(gaps[0]!.finding.summary).toBe(
      "POST /transfers demands ledger.read, ledger.write, and the token portal-bff is itself called with holds portal.read.",
    );
    expect(gaps[0]!.finding.question?.text).toBe(
      "How does portal-bff get a token holding ledger.read, ledger.write, which POST /transfers demands? The routes into portal-bff demand portal.read.",
    );
    expect(gaps[0]!.finding.question?.owner).toBeTruthy();
    expect(gaps[0]!.finding.evidence).toContainEqual({
      source: "catalog",
      record: "gw-ledger-v1",
    });

    // A token that does hold one of them: nothing to ask.
    const held = await forgeChangeRoot();
    for (const r of INTO_BFF(["ledger.read"])) await record(held, r);
    expect(of(await runCritic(held, CHANGE, { now: NOW }), "scope-caller")).toEqual([]);

    // And nothing is asked where the facts don't say what the caller's token holds.
    expect(
      of(await runCritic(await forgeChangeRoot(), CHANGE, { now: NOW }), "scope-caller"),
    ).toEqual([]);
  });

  it("says when a story's criteria ask for a scope no route demands", async () => {
    const root = await forgeChangeRoot();
    await story(
      root,
      CRITERION,
      `${CRITERION}\n- Given a caller whose token carries the \`ledger.admin\` scope, when it raises the limit, then the new limit is saved.`,
    );
    const hits = of(await runCritic(root, CHANGE, { now: NOW }), "scope-unknown");
    expect(hits.map((x) => [x.finding.kind, x.finding.artifact])).toEqual([
      ["issue", "stories/s1-refuse-over-limit.md"],
    ]);
    expect(hits[0]!.finding.summary).toBe(
      "The criteria ask for the scope ledger.admin, and no gateway route the change names demands it.",
    );
    expect(hits[0]!.finding.why).toContain("demand ledger.read, ledger.write");

    // A scope a route does demand passes, and so does prose that names no scope.
    const fine = await forgeChangeRoot();
    await story(
      fine,
      CRITERION,
      `${CRITERION}\n- Given a caller whose token carries the \`ledger.write\` scope, when it sends, then the transfer is posted.`,
    );
    expect(of(await runCritic(fine, CHANGE, { now: NOW }), "scope-unknown")).toEqual([]);
    const plain = await forgeChangeRoot();
    await story(
      plain,
      CRITERION,
      `${CRITERION}\n- Given \`forge.ledger.Transfer\`, when it is read, then nothing happens.`,
    );
    expect(of(await runCritic(plain, CHANGE, { now: NOW }), "scope-unknown")).toEqual([]);
  });
});
