import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TRAFFIC_SOURCES } from "@maycombhq/ingestors";
import { aggregateTraffic } from "../src/index.js";

/**
 * J4 (ADR 0151): a gateway traffic export, given as a file, kept only as aggregate counts per
 * caller app, method, path template, proxy and base path over a date range. The export's client
 * ids, IPs, user agents, query strings and tokens are invented, and must appear in no output.
 */

const FX = join(__dirname, "..", "..", "..", "fixtures", "link-evidence");
const csv = readFileSync(join(FX, "traffic", "apigee-analytics.csv"));
const json = readFileSync(join(FX, "traffic", "apigee-analytics.json"));
const golden = readFileSync(join(FX, "expected", "apigee-2026-09-01-2026-09-30.yaml"), "utf8");
/** The estate's route templates (the gateway estate's entry and call paths). */
const templates = [
  "/forge/v1/accounts/{id}",
  "/forge/v1/accounts/{id}/transfers",
  "/accounts/{id}",
  "/transfers",
];
/** Every value of the export that must never be written. */
const SECRETS = [
  "fk-client-8f2d7a91c3e4",
  "fk-client-55aa77bb99cc",
  "203.0.113.45",
  "203.0.113.46",
  "198.51.100.23",
  "ForgePortal/2.4",
  "ForgeMobile/3.1",
  "Android",
  "access_token",
  "eyJhbGciOiJIUzI1NiJ9",
  "apikey",
  "fkKey9Qx7Lm2Pz8Rt4Vw6Yb1Nc3Hd5Jf0",
  "ACC-1001",
  "ACC-2002",
  "ACC-3003",
  "2026-08",
  "2026-09-03T10:15:00Z",
];
const run = (
  bytes: Buffer,
  o: { from?: string; to?: string } = { from: "2026-09-01", to: "2026-09-30" },
) =>
  aggregateTraffic({
    bytes,
    source: "apigee",
    columns: TRAFFIC_SOURCES.apigee!,
    templates,
    ...o,
  });

describe("aggregateTraffic", () => {
  it("keeps only the aggregates: the golden file, from the CSV and from the JSON alike", () => {
    const r = run(csv);
    if (!r.ok) throw new Error(r.message);
    expect(r.text).toBe(golden);
    expect(r.read).toBe(5);
    expect(r.outOfRange).toBe(1);
    const j = run(json);
    if (!j.ok) throw new Error(j.message);
    expect(j.text).toBe(
      golden.replace(
        createHash("sha256").update(csv).digest("hex"),
        createHash("sha256").update(json).digest("hex"),
      ),
    );
  });

  it("writes no client id, IP, user agent, query string, token or raw path anywhere", () => {
    for (const bytes of [csv, json]) {
      const r = run(bytes);
      if (!r.ok) throw new Error(r.message);
      const all = JSON.stringify(r) + r.text;
      for (const s of SECRETS) expect(all).not.toContain(s);
      expect(r.dropped).toEqual(
        expect.arrayContaining(["client_id", "client_ip", "useragent", "request_uri"]),
      );
    }
  });

  it("takes the range from the rows when none is given", () => {
    const r = run(csv, {});
    if (!r.ok) throw new Error(r.message);
    expect([r.file.from, r.file.to]).toEqual(["2026-09-03", "2026-10-02"]);
    expect(
      r.file.rows.find((x) => x.app === "forge-portal-api" && x.path === "/forge/v1/accounts/{id}")!
        .count,
    ).toBe(1199);
  });

  it("refuses a file it can't read into that shape, rather than storing it", () => {
    const bad = [
      Buffer.from("just some words\nno columns here\n"),
      Buffer.from("developer_app,client_ip\nforge-web,203.0.113.9\n"),
      Buffer.from(`{"rows": "not a list"}`),
      Buffer.from(""),
    ];
    for (const b of bad) {
      const r = run(b);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).not.toContain("203.0.113.9");
    }
  });

  it("refuses an export with no dates when no range is given", () => {
    const r = run(
      Buffer.from("developer_app,request_verb,request_uri\nforge-web,GET,/transfers\n"),
      {},
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/--from and --to/);
  });

  it("never keeps an app name, proxy or path segment that looks like a token, an IP or an email", () => {
    const r = run(
      Buffer.from(
        "developer_app,apiproxy,request_verb,request_uri,message_count\n" +
          "203.0.113.77,forge-accounts-v1,GET,/people/someone@forge.example/cards,3\n" +
          "forge-web,fkProxy9Qx7Lm2Pz8Rt4Vw6Yb1Nc3Hd5Jf,GET,/transfers?session=abc123,2\n",
      ),
    );
    if (!r.ok) throw new Error(r.message);
    expect(r.text).not.toMatch(/203\.0\.113\.77|someone@forge|fkProxy|abc123|session/);
    expect(r.file.rows.map((x) => [x.app, x.path, x.proxy])).toEqual([
      ["(redacted)", "/people/{id}/cards", "forge-accounts-v1"],
      ["forge-web", "/transfers", undefined],
    ]);
  });

  it("refuses the aggregate when the deny-list names a word in it", () => {
    const deny = new Set([
      createHash("sha256").update("forge-mobile".split("-")[1]!).digest("hex"),
    ]);
    const r = aggregateTraffic({
      bytes: csv,
      source: "apigee",
      columns: TRAFFIC_SOURCES.apigee!,
      templates,
      from: "2026-09-01",
      to: "2026-09-30",
      denyHashes: deny,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/deny-list/);
  });

  it("reads an API catalogue export's columns too", () => {
    const r = aggregateTraffic({
      bytes: Buffer.from(
        JSON.stringify({
          items: [
            {
              consumer: "forge-portal-api",
              method: "get",
              path: "/forge/v1/accounts/ACC-9",
              calls: 4,
              date: "2026-09-02",
            },
          ],
        }),
      ),
      source: "catalog",
      columns: TRAFFIC_SOURCES.catalog!,
      templates,
    });
    if (!r.ok) throw new Error(r.message);
    expect(r.file.rows).toEqual([
      { app: "forge-portal-api", method: "GET", path: "/forge/v1/accounts/{id}", count: 4 },
    ]);
    expect([r.file.from, r.file.to]).toEqual(["2026-09-02", "2026-09-02"]);
  });
});
