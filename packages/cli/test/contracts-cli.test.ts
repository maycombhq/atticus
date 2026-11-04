import { cp, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseFacts } from "@maycombhq/core";
import { dirSource, verifyFacts } from "@maycombhq/verify";
import { contractCheckOf, writeRepoSpecs } from "../src/contract-check-files.js";
import { joinContracts } from "../src/contracts-commands.js";

/**
 * The contract check on every link (plan item F7, ADR 0164), on the invented bank-shaped Forge
 * estate of fixtures/link-estate with its contracts overlay (fixtures/link-estate/contracts):
 * the gateway's published spec against the Spring Boot payload behind it (an envelope, an
 * AssignMessage rename, a JavaScript policy nobody traced), a MapStruct mapper, and the topic
 * forge.payments.settled with its .proto, one publisher and two listeners. Files only.
 */

const FIX = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/link-estate");
const OVER = join(FIX, "contracts");

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
};

/** A metarepo with the estate's facts and the overlay's, and each repo's checkout with both. */
async function metarepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-contracts-"));
  await cp(join(FIX, "org-pack"), join(root, "org-pack"), { recursive: true });
  await cp(join(FIX, "facts"), join(root, "facts"), { recursive: true });
  await cp(join(FIX, "repos"), join(root, "checkouts"), { recursive: true });
  await cp(join(OVER, "repos"), join(root, "checkouts"), { recursive: true });
  for (const n of (await readdir(join(OVER, "facts"))).sort()) {
    const base = await readFile(join(root, "facts", n), "utf8");
    await writeFile(
      join(root, "facts", n),
      base + (await readFile(join(OVER, "facts", n), "utf8")),
    );
  }
  for (const n of (await readdir(join(root, "facts"))).filter((x) => x.endsWith(".jsonl"))) {
    const repo = n.replace(/\.jsonl$/, "");
    const dir = join(root, "checkouts", repo);
    if (!existsSync(dir)) continue;
    const p = parseFacts(await readFile(join(root, "facts", n), "utf8"));
    if (!p.ok) throw new Error(JSON.stringify(p.issues));
    await writeRepoSpecs(root, repo, dir, p.facts);
  }
  return root;
}

describe("the contracts overlay's facts", () => {
  it("verify against the overlay's code, beside the estate's", async () => {
    const root = await metarepo();
    for (const n of (await readdir(join(OVER, "facts"))).sort()) {
      const repo = n.replace(/\.jsonl$/, "");
      const p = parseFacts(await readFile(join(root, "facts", n), "utf8"));
      if (!p.ok) throw new Error(JSON.stringify(p.issues));
      const report = await verifyFacts({
        facts: p.facts,
        source: dirSource(join(root, "checkouts", repo)),
        commit: p.facts[0]!.commit,
      });
      expect(report.rejected, `${repo}: ${JSON.stringify(report.rejected)}`).toEqual([]);
    }
  });
});

describe("atticus join contracts", () => {
  it("reads each repo's specs from its checkout into <repo>.specs.yaml", async () => {
    const root = await metarepo();
    const names = (await readdir(join(root, "facts"))).filter((n) => n.endsWith(".specs.yaml"));
    expect(names.sort()).toEqual([
      "forge-notifications.specs.yaml",
      "forge-payments.specs.yaml",
      "forge-proxy-accounts-v1.specs.yaml",
      "forge-proxy-payments-v1.specs.yaml",
    ]);
    const proxy = await readFile(join(root, "facts", "forge-proxy-accounts-v1.specs.yaml"), "utf8");
    // The gateway's published spec is its own: tied to the route it describes.
    expect(proxy).toContain("role: own");
    expect(proxy).toContain("entry: entry.get.forge-accounts-v1-accounts-id");
  });

  it("compares the gateway's published spec with the Spring Boot payload behind it", async () => {
    const root = await metarepo();
    const { result } = await contractCheckOf(root);
    const of = (path: string) =>
      result.findings
        .filter(
          (f) =>
            f.call.repo === "forge-portal-bff" &&
            result.links.find((l) => l.path === path && f.id.startsWith(`${l.key}#`)),
        )
        .map((f) => [f.status, f.kind, f.field ?? f.error]);
    expect(of("/accounts/{id}")).toEqual([
      // The portal reads a field the published spec never returns.
      ["mismatch", "field-missing", "data.nickname"],
      // Behind the gateway: the service answers 423, which the spec doesn't list (401 is the gateway's own).
      ["mismatch", "error-unlisted", "423"],
      ["mismatch", "field-missing", "data.currency"],
      // The JavaScript policy that adds it isn't traced: unconfirmed, never a mismatch.
      ["unconfirmed", "field-missing", "data.overdraftLimit"],
      ["mismatch", "field-type", "data.id"],
    ]);
    // The AssignMessage rename (balance → availableBalance) and the envelope are traced: no finding.
    expect(result.findings.some((f) => /availableBalance|data\.balance/.test(f.field ?? ""))).toBe(
      false,
    );
    const type = result.findings.find((f) => f.kind === "field-type")!;
    expect(type.via).toEqual(["forge-accounts src/main/java/forge/accounts/api/Response.java:5"]);
    expect(type.interfaces).toHaveLength(2);
    // The payments route: AssignMessage forwards accountId as debtorAccount; the service also
    // requires channel, which nothing sends; the MapStruct mapper turns id into paymentId.
    expect(of("/payments")).toEqual([
      ["mismatch", "field-extra", "memo"],
      ["mismatch", "field-not-sent", "channel"],
    ]);
  });

  it("compares a topic's publisher, its listeners and the .proto copies they read by", async () => {
    const root = await metarepo();
    const { result } = await contractCheckOf(root);
    const topic = result.findings
      .filter((f) => f.call.fact === "call.publish.forge-payments-settled")
      .map((f) => [f.entry?.repo, f.kind, f.field]);
    expect(topic).toEqual([
      ["forge-accounts", "field-missing", "feeMinor"],
      ["forge-notifications", "field-extra", "settled_at"],
      ["forge-notifications", "field-number", "3"],
      ["forge-notifications", "field-number", "4"],
    ]);
    expect(result.counts).toEqual({
      links: 11,
      compared: 4,
      mismatches: 10,
      unconfirmed: 1,
      unlinked: 2,
    });
  });

  it("prints each link's mismatches, then the unconfirmed, and writes nothing", async () => {
    const root = await metarepo();
    const c = capture();
    expect(await joinContracts(root, {}, c.io)).toBe(0);
    expect(c.out.slice(0, 3)).toEqual([
      "11 links checked; 4 had a payload on both sides to compare.",
      "10 mismatches, 1 unconfirmed (a mapping on the way isn't traced).",
      "Mismatches:",
    ]);
    expect(c.out).toContain(
      "    field-not-sent: forge-payments's entry requires the request field channel (src/main/java/forge/payments/api/PaymentRequest.java:10), which forge-proxy-payments-v1's spec forge-payments-v1.yaml doesn't send",
    );
    expect(c.out).toContain("Unconfirmed:");
    expect(c.out.at(-1)).toBe("Nothing was written.");
    const j = capture();
    expect(await joinContracts(root, { json: true }, j.io)).toBe(0);
    expect(JSON.parse(j.out.join("\n")).counts.mismatches).toBe(10);
  });

  it("says how to get a payload on file when no link has one", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-contracts-"));
    await cp(join(FIX, "org-pack"), join(root, "org-pack"), { recursive: true });
    await cp(join(FIX, "facts"), join(root, "facts"), { recursive: true });
    const c = capture();
    expect(await joinContracts(root, {}, c.io)).toBe(0);
    expect(c.out[0]).toMatch(/^No link has a payload on both sides yet/);
  });
});
