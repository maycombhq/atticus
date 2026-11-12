import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { denyHash, intakeTraffic } from "../src/link-evidence-files.js";
import { verifyCommand } from "../src/verify-commands.js";

/**
 * ADR 0151 from the command line: `atticus intake traffic` keeps an invented gateway export as
 * aggregates in evidence/traffic/ (no client id, IP, user agent or token in any file it writes),
 * and `atticus verify forge-portal-api --write` reads the portal's Pact files and the OpenAPI spec
 * it keeps, marks the links both bear out, and lists where they and the join disagree.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const GW = join(HERE, "../../../fixtures/gateway-facts");
const LE = join(HERE, "../../../fixtures/link-evidence");
const REPO = "forge-portal-api";

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
};

function metarepo() {
  const root = mkdtempSync(join(tmpdir(), "atticus-link-evidence-"));
  cpSync(join(GW, "org-pack"), join(root, "org-pack"), { recursive: true });
  cpSync(join(GW, "facts"), join(root, "facts"), { recursive: true });
  cpSync(join(GW, "repos", REPO), join(root, "workspace", REPO), { recursive: true });
  cpSync(join(LE, REPO), join(root, "workspace", REPO), { recursive: true });
  return root;
}
const verify = (root: string, c = capture()) =>
  verifyCommand(
    root,
    REPO,
    { commit: "8888bbb", dir: join(root, "workspace", REPO), write: true },
    c.io,
  );

/**
 * ADR 0195 point 2: the build joins every repo's facts slot at once, and only `verify <repo>
 * --write` writes a repo's slot (the snapshot of its facts), so the repos the portal calls
 * through the gateway are verified first, as a team's estate has them: a live facts file alone is
 * no part of the catalog (beta.26's verify joined every live file).
 */
async function verifyOthers(root: string): Promise<void> {
  for (const [repo, commit] of [
    ["forge-accounts", "9999ccc"],
    ["forge-gateway", "7777aaa"],
  ] as const) {
    cpSync(join(GW, "repos", repo), join(root, "workspace", repo), { recursive: true });
    const c = capture();
    const code = await verifyCommand(
      root,
      repo,
      { commit, dir: join(root, "workspace", repo), write: true },
      c.io,
    );
    expect(code, [...c.out, ...c.err].join("\n")).toBe(0);
  }
}

/** Every file under a folder, as text. */
const textUnder = (dir: string): string =>
  readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => readFileSync(join(e.parentPath, e.name), "utf8"))
    .join("\n");

const SECRETS = [
  "fk-client-8f2d7a91c3e4",
  "fk-client-55aa77bb99cc",
  "203.0.113.45",
  "198.51.100.23",
  "ForgePortal/2.4",
  "ForgeMobile/3.1",
  "access_token",
  "eyJhbGciOiJIUzI1NiJ9",
  "fkKey9Qx7Lm2Pz8Rt4Vw6Yb1Nc3Hd5Jf0",
  "ACC-2002",
];

describe("atticus intake traffic", () => {
  it("writes the aggregate to evidence/traffic/ and nothing of the raw rows", async () => {
    const root = metarepo();
    const c = capture();
    const code = await intakeTraffic(
      root,
      join(LE, "traffic", "apigee-analytics.csv"),
      { source: "apigee", from: "2026-09-01", to: "2026-09-30" },
      c.io,
    );
    expect(c.err).toEqual([]);
    expect(code).toBe(0);
    const written = join(root, "evidence", "traffic", "apigee-2026-09-01-2026-09-30.yaml");
    expect(readFileSync(written, "utf8")).toBe(
      readFileSync(join(LE, "expected", "apigee-2026-09-01-2026-09-30.yaml"), "utf8"),
    );
    const said = [...c.out, ...c.err].join("\n");
    for (const s of SECRETS) {
      expect(said).not.toContain(s);
      expect(textUnder(join(root, "evidence"))).not.toContain(s);
    }
    expect(said).toContain("Dropped before anything was written: the columns client_id, client_ip");
  });

  it("refuses an unknown source, a file it can't read, and an aggregate the deny-list names, writing nothing", async () => {
    const root = metarepo();
    const c = capture();
    const csv = join(LE, "traffic", "apigee-analytics.csv");
    expect(await intakeTraffic(root, csv, { source: "ftp-logs" }, c.io)).toBe(2);
    const junk = join(root, "junk.txt");
    writeFileSync(junk, "no columns here\nat all\n");
    expect(await intakeTraffic(root, junk, { source: "apigee" }, c.io)).toBe(1);
    writeFileSync(join(root, ".denylist"), `${denyHash("portal")}\n`);
    expect(
      await intakeTraffic(
        root,
        csv,
        { source: "apigee", from: "2026-09-01", to: "2026-09-30" },
        c.io,
      ),
    ).toBe(1);
    expect(c.err.join("\n")).toContain("deny-list");
    expect(existsSync(join(root, "evidence"))).toBe(false);
  });
});

describe("atticus verify --write with contract files and traffic", () => {
  it("keeps the portal's contract files beside its facts, marks the links and lists the findings", async () => {
    const root = metarepo();
    await intakeTraffic(
      root,
      join(LE, "traffic", "apigee-analytics.json"),
      { source: "apigee", from: "2026-09-01", to: "2026-09-30" },
      capture().io,
    );
    await verifyOthers(root);
    const c = capture();
    expect(await verify(root, c)).toBe(0);
    expect(parse(readFileSync(join(root, "facts", `${REPO}.contracts.yaml`), "utf8"))).toEqual(
      parse(readFileSync(join(LE, "expected", `${REPO}.contracts.yaml`), "utf8")),
    );
    const out = c.out.join("\n");
    expect(out).toContain(
      "  Contracts: 1 link confirmed by a consumer's contract file, 3 requests the join doesn't bear out",
    );
    expect(out).toContain("no-link: the Pact interaction DELETE /forge/v1/accounts/{id}");
    expect(out).toContain("  Traffic: 1 link seen in imported traffic, 2 findings; 1 app");
    expect(out).toContain(
      "missed-link: portal-api (forge-portal-api) called GET /forge/v1/accounts/{id}/** 7 times",
    );
    expect(out).toContain("unseen-link: portal-api → accounts-api POST /transfers");

    const ifaces = join(root, "catalog", "generated", "interface");
    const marked = readdirSync(ifaces)
      .map(
        (n) =>
          parse(readFileSync(join(ifaces, n), "utf8")) as { flags?: string[]; confidence: string },
      )
      .filter((r) => r.flags?.includes("seen-in-traffic"));
    expect(marked).toHaveLength(1);
    expect(marked[0]!.flags).toEqual(expect.arrayContaining(["confirmed-by-contract"]));

    const report = parse(readFileSync(join(root, "facts", `${REPO}.verify.yaml`), "utf8")) as {
      contracts: { findings: { reason: string }[] };
      traffic: { seen: { count: number }[]; findings: { reason: string }[] };
    };
    expect(report.contracts.findings.map((f) => f.reason)).toEqual([
      "no-link",
      "unknown-provider",
      "unknown-provider",
    ]);
    expect(report.traffic.seen.map((s) => s.count)).toEqual([200]);
    expect(report.traffic.findings.map((f) => f.reason)).toEqual(["missed-link", "unseen-link"]);
    // What Atticus wrote (not the checkout, whose Pact bodies are the consumer's own).
    const wrote = ["facts", "catalog", "evidence"].map((d) => textUnder(join(root, d))).join("\n");
    for (const s of SECRETS) expect(wrote).not.toContain(s);
  });

  it("leaves out a contract file the deny-list names a word of, and says which", async () => {
    const root = metarepo();
    writeFileSync(join(root, ".denylist"), `${denyHash("billing")}\n`);
    const c = capture();
    expect(await verify(root, c)).toBe(0);
    expect(c.err.join("\n")).toContain(
      "pacts/forge-portal-api-forge-billing.json: the deny-list names a word in it, so its requests are left out.",
    );
    expect(readFileSync(join(root, "facts", `${REPO}.contracts.yaml`), "utf8")).not.toMatch(
      /billing/,
    );
  });
});
