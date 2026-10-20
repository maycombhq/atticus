import { cp, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MockRuntime } from "@maycombhq/ai";
import { scanEstate } from "@maycombhq/scanner";
import { baseClonePath } from "@maycombhq/workspace";
import { loadEvalCases } from "@maycombhq/assistant-kit";
import { onboardAccept, onboardCheck, onboardDraft, onboardEval } from "../src/onboard-commands.js";

const GW = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/gateways");
const NOW = new Date("2026-10-19T12:00:00Z");

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

/** The gateways estate without its Kong dialect, as if Kong were new to Atticus. */
async function estate(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-onboard-"));
  await cp(join(GW, "metarepo"), root, { recursive: true });
  await rm(join(root, "org-pack/dialects/tide-kong.yaml"));
  await cp(join(GW, "repos/gw-kong"), baseClonePath(root, "gw-kong"), { recursive: true });
  return root;
}

const reference = async () =>
  readFile(join(GW, "metarepo/org-pack/dialects/tide-kong.yaml"), "utf8");

const interfaces = async (root: string) =>
  (
    await scanEstate({
      root,
      repoDir: (id) => join(GW, "repos", id),
      repoState: async () => ({ commit: "a".repeat(40), dirty: false }),
      cache: null,
      scannedAt: "2026-10-19T12:00:00Z",
    })
  ).records
    .filter((r) => r.kind === "Interface")
    .map(
      (r) =>
        `${String((r as unknown as { to: string }).to)} ${String((r as unknown as { via: string }).via)}`,
    )
    .sort();

describe("atticus onboard (ADR 0059)", () => {
  it("drafts a dialect for a gateway Atticus can't read, keeps it as a proposal, and once accepted the calls join", async () => {
    const root = await estate();
    expect(await interfaces(root)).not.toContain("ledger-svc gateway");

    const text = await reference();
    const replies = [text.replace("basepath: /orders-v1", "basepath: /orders-v2"), text];
    let n = 0;
    const runtime = new MockRuntime(() => replies[n++]!, { now: () => NOW });
    const c = capture();
    expect(
      await onboardDraft(root, "gw-kong", { name: "tide-kong" }, { runtime, now: NOW }, c.io),
    ).toBe(0);
    expect(c.out).toEqual([
      "Attempt 1: 1 problem, handed back:",
      '  - test "two paths of one route, each a route to the service": kong-orders-public-orders-v1.basepath: expected "/orders-v2", got "/orders-v1"',
      "Drafted proposals/dialects/tide-kong.yaml for gw-kong in 2 attempts: its tests pass, and on gw-kong it gives 3 GatewayRoutes.",
      "  GatewayRoute kong-ledger-public-ledger",
      "  GatewayRoute kong-ledger-public-ledger-v1",
      "  GatewayRoute kong-status-status",
      "It is a proposal: nothing scans with it yet. Review the rules and their tests, then: atticus onboard accept tide-kong",
    ]);
    // A proposal isn't used.
    expect(await interfaces(root)).not.toContain("ledger-svc gateway");

    const check = capture();
    expect(await onboardCheck(root, "tide-kong", "gw-kong", check.io)).toBe(0);

    const ok = capture();
    expect(await onboardAccept(root, "tide-kong", {}, ok.io)).toBe(0);
    expect(ok.out).toEqual([
      "Accepted: org-pack/dialects/tide-kong.yaml. It applies to repos of type gateway. Commit the org pack for review, as with any change to it.",
    ]);
    expect(
      await stat(join(root, "proposals/dialects/tide-kong.yaml")).catch(() => undefined),
    ).toBeUndefined();
    expect(await interfaces(root)).toContain("ledger-svc gateway");
  }, 120_000);

  it("writes nothing when no draft passes, and says what to try", async () => {
    const root = await estate();
    const c = capture();
    expect(
      await onboardDraft(
        root,
        "gw-kong",
        { name: "tide-kong", attempts: 1 },
        { runtime: new MockRuntime(() => "rules: nope", { now: () => NOW }), now: NOW },
        c.io,
      ),
    ).toBe(1);
    expect(c.err[0]).toMatch(/^No draft passed in 1 attempt\. Nothing was written\./);
    expect(await stat(join(root, "proposals")).catch(() => undefined)).toBeUndefined();
  });

  it("refuses an unknown repo, and accepting a proposal that isn't there", async () => {
    const root = await estate();
    const runtime = new MockRuntime(() => "", { now: () => NOW });
    expect(await onboardDraft(root, "nope", {}, { runtime }, capture().io)).toBe(2);
    expect(await onboardAccept(root, "nope", {}, capture().io)).toBe(2);
  });
});

describe("atticus onboard eval (ADR 0059)", () => {
  it("scores each case's draft against its reference, and exits 1 unless every case is exact", async () => {
    const root = await estate();
    const EVAL = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/onboard-eval");
    const refs = new Map((await loadEvalCases(EVAL)).map((c) => [`eval-${c.name}`, c.reference]));
    // A stand-in assistant: each case's reference, named as the task asks; apim spoilt if asked.
    const texts = new Map<string, string>();
    for (const [name, file] of refs)
      texts.set(name, (await readFile(file, "utf8")).replace(/^name: .*$/m, `name: ${name}`));
    const runtime = (spoil: boolean) =>
      new MockRuntime(
        (r) => {
          const name = /Name it `(eval-[a-z0-9-]+)`/.exec(r.pack.prompt)![1]!;
          return spoil && name === "eval-apim" ? "not: a dialect" : texts.get(name)!;
        },
        { now: () => NOW },
      );
    const good = capture();
    expect(await onboardEval(root, EVAL, {}, { runtime: runtime(false), now: NOW }, good.io)).toBe(
      0,
    );
    expect(good.out.at(-1)).toBe("7 of 7 cases read exactly what the reference reads.");
    const bad = capture();
    expect(
      await onboardEval(root, EVAL, { attempts: 1 }, { runtime: runtime(true), now: NOW }, bad.io),
    ).toBe(1);
    expect(bad.out).toContain(
      "apim: failed in 1 attempt, read 0 of 1 expected records (precision 0%, recall 0%)",
    );
  }, 600_000);
});
