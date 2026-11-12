import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  listQuestions,
  parseFacts,
  parseRecord,
  serializeRecord,
  TARGETS_STEP_ID,
  type CatalogRecord,
} from "@maycombhq/core";
import { readCatalog } from "@maycombhq/scanner";
import { projectFactsIntoCatalog } from "../src/map-render-commands.js";
// ADR 0195 (CS2): --write confirms the removals a build lists, as a person would.
import { verifyConfirmed as verifyCommand } from "./seed-slots.js";

const { main } = await import("../src/main.js");

/**
 * Beta.27 (a user's estate, re-made with invented names): an Apigee proxy repo whose target URL
 * is the deploy token `@targetVendorUrl@`, which the deploy's `config.json` sets per environment
 * by the token's name (`fixtures/gateway-facts/policy-tokens/`). The proxy's forwarding calls
 * leave the estate for the hosts the vendor system lists, never joining the estate's services
 * that serve the same paths; a token nothing sets is asked about once per token and path prefix.
 * And a route whose forwarding call a person said isn't a call (or that no read gave one) draws
 * nothing: an arrow an earlier write drew by the path guess goes when the proxy is written again,
 * whether the build drew it or a catalog from before the slots (beta.26) was adopted with it.
 * Files only, no network.
 */
const FIX = join(__dirname, "..", "..", "..", "fixtures", "gateway-facts", "policy-tokens");
const COMMIT: Record<string, string> = {
  "northwind_pay_1-0": "7777ccc",
  "forge-payments": "5555ddd",
  "forge-refunds": "6666eee",
  "forge-checkout": "4444fff",
};
const PROXY = "northwind_pay_1-0";
const AT = new Date("2026-11-12T10:00:00.000Z");
const TOKEN = "@targetVendorUrl@";
const TO_VENDOR = [
  ["call.get.payments-id", "devapi.northwind-pay.example"],
  ["call.get.refunds-id", "devapi.northwind-pay.example"],
  ["call.post.payments", "devapi.northwind-pay.example"],
  ["call.post.refunds", "devapi.northwind-pay.example"],
];

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const factsOf = (repo: string) => readFileSync(join(FIX, "facts", `${repo}.jsonl`), "utf8");
const lines = (text: string) => text.split("\n").filter((l) => l.trim());
/** The proxy's facts as a read before beta.27 wrote them: no host, no setting of the token. */
const beta26 = () =>
  lines(factsOf(PROXY))
    .filter((l) => !l.includes('"kind":"config"'))
    .map((l) => l.replace(`"host":"${TOKEN}",`, ""))
    .join("\n") + "\n";
/**
 * As beta.26 joined them: forwarding calls whose lines write no target URL, which the join takes
 * for a proxy chained to another and joins by their path (the guess, as the user's Map drew it).
 */
const pathGuessed = () =>
  lines(beta26())
    .map((l) =>
      l.replace(
        '{"file":"apiproxy/targets/TE-Vendor.xml","line":3,"value":"@targetVendorUrl@"}',
        '{"file":"apiproxy/proxies/default.xml","line":20,"value":"TE-Vendor"}',
      ),
    )
    .join("\n") + "\n";

function metarepo(proxyFacts = factsOf(PROXY)): string {
  const root = mkdtempSync(join(tmpdir(), "atticus-policy-tokens-"));
  temps.push(root);
  cpSync(join(FIX, "org-pack"), join(root, "org-pack"), { recursive: true });
  mkdirSync(join(root, "facts"), { recursive: true });
  for (const r of Object.keys(COMMIT)) {
    cpSync(join(FIX, "repos", r), join(root, "workspace", r), { recursive: true });
    writeFileSync(join(root, "facts", `${r}.jsonl`), r === PROXY ? proxyFacts : factsOf(r));
  }
  return root;
}

async function verify(root: string, repo: string): Promise<string> {
  const out: string[] = [];
  const code = await verifyCommand(
    root,
    repo,
    { commit: COMMIT[repo]!, dir: join(root, "workspace", repo), write: true, now: () => AT },
    { out: (l) => out.push(l), err: (l) => out.push(`ERR ${l}`) },
  );
  expect(code, out.join("\n")).toBe(0);
  return out.join("\n");
}

async function joinOf(root: string, repo: string) {
  const facts = parseFacts(readFileSync(join(root, "facts", `${repo}.jsonl`), "utf8"));
  if (!facts.ok) throw new Error("facts don't parse");
  return projectFactsIntoCatalog(root, repo, facts.facts);
}

type Iface = Extract<CatalogRecord, { kind: "Interface" }>;
const golden = (name: string, got: unknown) => {
  // UPDATE_GOLDEN=1 writes what the build gives now, to be checked by hand before it's committed.
  if (process.env.UPDATE_GOLDEN) writeFileSync(join(FIX, "expected", name), stringify(got));
  return parse(readFileSync(join(FIX, "expected", name), "utf8")) as unknown;
};
/** The proxy's arrows as the catalog on disk holds them, the parts a person reads on the Map. */
const proxyArrows = async (root: string) =>
  (await readCatalog(join(root, "catalog", "generated"), { fresh: true })).records
    .filter((r): r is Iface => r.kind === "Interface" && r.from === "northwind-pay-proxy")
    .map((i) => ({
      id: i.id,
      from: i.from,
      to: i.to,
      method: i.method,
      normalizedPath: i.normalizedPath,
      confidence: i.confidence,
      flags: i.flags ?? [],
      evidence: i.evidence.map((e) => ({
        repo: e.repo,
        side: e.side,
        at: `${e.path}:${e.line}`,
      })),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
/** The arrows out of the proxy's box, as the catalog on disk has them. */
const fromProxy = async (root: string) =>
  (await readCatalog(join(root, "catalog", "generated"), { fresh: true })).records
    .filter((r): r is Iface => r.kind === "Interface" && r.from === "northwind-pay-proxy")
    .map((i) => [i.to, i.method, i.normalizedPath])
    .sort();
const outsideOf = async (root: string) =>
  ((await joinOf(root, PROXY)).result.join!.outside ?? [])
    .map((o) => [o.call.fact, o.target])
    .sort();
const notACall = (fact: string, line: number, value: string) =>
  JSON.stringify({
    schemaVersion: 1,
    fact,
    target: { kind: "call", file: "apiproxy/proxies/default.xml", line, value },
    action: "wrong",
    reason: "This isn't a call",
    by: "pat",
    at: AT.toISOString(),
  });
/** The read again: the token's settings recorded, one route's forwarding call never read. */
const rereadWithout = (id: string) =>
  lines(factsOf(PROXY))
    .filter((l) => !l.includes(`"id":"${id}"`))
    .join("\n") + "\n";
const GUESSED = [
  ["payments-api", "GET", "/payments/{}"],
  ["payments-api", "POST", "/payments"],
  ["refunds-api", "GET", "/refunds/{}"],
  ["refunds-api", "POST", "/refunds"],
];
/**
 * The review of beta.27: a forwarding call the join leaves to a vendor by a host the profile
 * lists as its alias is drawn to that system on the Map, as a call written with the host is.
 */
const VENDOR_ARROW: Record<string, string[]> = {
  "call.get.payments-id": ["northwind-pay", "GET", "/api/v1/payments/{}"],
  "call.get.refunds-id": ["northwind-pay", "GET", "/api/v1/refunds/{}"],
  "call.post.payments": ["northwind-pay", "POST", "/api/v1/payments"],
  "call.post.refunds": ["northwind-pay", "POST", "/api/v1/refunds"],
};
const toVendor = (...ids: string[]) => ids.map((id) => VENDOR_ARROW[id]!).sort();
const ALL_TO_VENDOR = toVendor(...Object.keys(VENDOR_ARROW));

describe("a proxy whose target URL a config.json token sets by its name (beta.27)", () => {
  it("sends the proxy's calls out of the estate to the vendor's hosts, never to a service by its path", async () => {
    const root = metarepo();
    for (const r of Object.keys(COMMIT)) await verify(root, r);
    expect(await fromProxy(root)).toEqual(ALL_TO_VENDOR);
    // The arrows to the vendor as the catalog holds them (golden): each a guess's confidence
    // (inferred), citing its caller's line and no callee's (the vendor's code isn't read).
    const vendor = await proxyArrows(root);
    expect(vendor).toEqual(golden("catalog-to-vendor.yaml", vendor));
    expect(await outsideOf(root)).toEqual(TO_VENDOR);
    expect((await listQuestions(root, { repo: PROXY })).questions).toEqual([]);
  }, 120_000);

  it("asks about the token once per path prefix when nothing sets it, and draws no arrow", async () => {
    const root = metarepo(beta26());
    const out = (await verify(root, PROXY)).split("\n");
    for (const r of Object.keys(COMMIT)) if (r !== PROXY) await verify(root, r);
    expect(await fromProxy(root)).toEqual([]);
    const qs = (await listQuestions(root, { repo: PROXY })).questions.filter(
      (q) => q.askedBy.step === TARGETS_STEP_ID,
    );
    expect(qs.map((q) => [q.state, q.evidence]).sort()).toEqual([
      ["open", ["apiproxy/proxies/default.xml:10", "apiproxy/proxies/default.xml:13"]],
      ["open", ["apiproxy/proxies/default.xml:4", "apiproxy/proxies/default.xml:7"]],
    ]);
    for (const q of qs) expect(q.question).toMatch(/^Which repo answers on @targetVendorUrl@\? /);
    expect(qs.some((q) => q.question.includes("routes under /payments/**"))).toBe(true);
    expect(qs.some((q) => q.question.includes("routes under /refunds/**"))).toBe(true);
    expect(
      out.filter((l) => /^2 calls go to @targetVendorUrl@, a token no fact sets/.test(l)),
    ).toHaveLength(2);
  }, 120_000);
});

describe("a route with no forwarding call draws nothing (beta.27, the user's second case)", () => {
  it("takes away the arrows an earlier write drew by the path guess", async () => {
    const root = metarepo(pathGuessed());
    for (const r of Object.keys(COMMIT)) await verify(root, r);
    expect(await fromProxy(root)).toEqual(GUESSED);
    // The path guess as the catalog holds it (golden): each arrow cites its caller's line and
    // its callee's, and is a guess, never verified because the callee's line was found.
    const guessed = await proxyArrows(root);
    expect(guessed).toEqual(golden("catalog-path-guess.yaml", guessed));
    for (const i of guessed) {
      expect(i.confidence).toBe("inferred");
      expect(i.flags).toEqual(["joined-by-path"]);
      expect(i.evidence.map((e) => e.side)).toEqual(["caller", "callee"]);
    }

    // A person says one route's forwarding call isn't a call, and it is written.
    writeFileSync(
      join(root, "facts", `${PROXY}.corrections.jsonl`),
      `${notACall("call.get.refunds-id", 13, "/refunds/*")}\n`,
    );
    await verify(root, PROXY);
    expect(await fromProxy(root)).toEqual(GUESSED.filter((g) => g[2] !== "/refunds/{}"));

    // The read again records the token's settings, and gives another route no forwarding call.
    writeFileSync(join(root, "facts", `${PROXY}.jsonl`), rereadWithout("call.post.payments"));
    await verify(root, PROXY);
    expect(await fromProxy(root)).toEqual(toVendor("call.get.payments-id", "call.post.refunds"));
    expect(await outsideOf(root)).toEqual(
      TO_VENDOR.filter(([f]) => f === "call.get.payments-id" || f === "call.post.refunds"),
    );
  }, 180_000);

  it("takes away the path-guessed arrows a beta.26 catalog was adopted with, once the proxy is read from facts", async () => {
    // A beta.26 metarepo: the catalog its writes left, with the path-guessed arrows; one of them
    // had lost its caller's line when the proxy was written again ("No line cited at this end").
    const root = metarepo(pathGuessed());
    for (const r of Object.keys(COMMIT)) await verify(root, r);
    rmSync(join(root, "catalog", "sources"), { recursive: true, force: true });
    rmSync(join(root, ".atticus"), { recursive: true, force: true });
    const dir = join(root, "catalog", "generated", "interface");
    let stripped = 0;
    for (const f of readdirSync(dir)) {
      const r = parse(readFileSync(join(dir, f), "utf8")) as Iface;
      if (r.from !== "northwind-pay-proxy" || r.method !== "GET" || r.to !== "refunds-api")
        continue;
      const only = { ...r, evidence: r.evidence.filter((e) => e.side !== "caller") };
      expect(parseRecord(only).ok).toBe(true);
      writeFileSync(join(dir, f), serializeRecord(only as CatalogRecord));
      stripped++;
    }
    expect(stripped).toBe(1);
    const up = { out: [] as string[], err: [] as string[] };
    const code = await main(["upgrade", "--yes", "--root", root], {
      out: (l) => up.out.push(l),
      err: (l) => up.err.push(l),
    });
    expect(code, [...up.out, ...up.err].join("\n")).toBe(0);
    expect(await fromProxy(root)).toEqual(GUESSED);

    // The read again with the token's settings, a route's forwarding call said not to be one.
    writeFileSync(
      join(root, "facts", `${PROXY}.corrections.jsonl`),
      `${notACall("call.get.refunds-id", 13, "/refunds/*")}\n`,
    );
    writeFileSync(join(root, "facts", `${PROXY}.jsonl`), rereadWithout("call.post.payments"));
    const said = (await verify(root, PROXY)).split("\n");
    expect(await fromProxy(root)).toEqual(toVendor("call.get.payments-id", "call.post.refunds"));
    // Each arrow said as it leaves, with why, and counted in the write's links.
    expect(
      said.filter((l) =>
        /^A legacy join left catalog\/sources\/legacy\/joins\.json: Interface\/if-[0-9a-f]+\. Its caller is read from facts now, and they don't join it\.$/.test(
          l,
        ),
      ),
    ).toHaveLength(4);
    expect(said.filter((l) => /^ {2}removed Interface\/if-/.test(l))).toHaveLength(4);
    // The two calls left are drawn to the vendor (the review): two arrows in, four out.
    expect(said.some((l) => /Links: .*Interfaces \+2 -4\b/.test(l))).toBe(true);
  }, 240_000);

  it("keeps the adopted arrows while the proxy's read hasn't reached the file their calls are in (the review)", async () => {
    // A beta.26 metarepo with the path-guessed arrows, adopted by the upgrade.
    const root = metarepo(pathGuessed());
    for (const r of Object.keys(COMMIT)) await verify(root, r);
    rmSync(join(root, "catalog", "sources"), { recursive: true, force: true });
    rmSync(join(root, ".atticus"), { recursive: true, force: true });
    const up = { out: [] as string[], err: [] as string[] };
    const code = await main(["upgrade", "--yes", "--root", root], {
      out: (l) => up.out.push(l),
      err: (l) => up.err.push(l),
    });
    expect(code, [...up.out, ...up.err].join("\n")).toBe(0);
    expect(await fromProxy(root)).toEqual(GUESSED);

    // A read in parts: its first part read config.json, not the proxy's flows. Nothing it read
    // says where the routes' calls go, so the arrows adopted from before the upgrade stay
    // (ADR 0195 point 6: never dropped because the build can't derive them yet).
    writeFileSync(
      join(root, "facts", `${PROXY}.jsonl`),
      lines(factsOf(PROXY))
        .filter((l) => l.includes('"kind":"config"'))
        .join("\n") + "\n",
    );
    const said = (await verify(root, PROXY)).split("\n");
    expect(said.filter((l) => /^A legacy join left/.test(l))).toEqual([]);
    expect(await fromProxy(root)).toEqual(GUESSED);

    // The read whole: its calls go to the vendor, so the guessed arrows go.
    writeFileSync(join(root, "facts", `${PROXY}.jsonl`), factsOf(PROXY));
    await verify(root, PROXY);
    expect(await fromProxy(root)).toEqual(ALL_TO_VENDOR);
    expect(await outsideOf(root)).toEqual(TO_VENDOR);
  }, 240_000);
});
