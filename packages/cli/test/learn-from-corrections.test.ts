import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { beforeEach, describe, expect, it } from "vitest";
import { ReadingRulesFile } from "@maycombhq/core";
import { deleteLink } from "../src/catalog-build-commands.js";
import type { AcpStepRunner } from "../src/copilot-acp-steps.js";
import { learnFromCorrections, type LearnDeps } from "../src/learn-corrections.js";
import { effectiveRules } from "../src/reading-rules.js";
import { rulesSetCommand } from "../src/rules-commands.js";
import { verifyCommand } from "../src/verify-commands.js";
import {
  AT,
  callFact,
  CAPTURE,
  correctionsEstate,
  FILE,
  GW,
  LINES,
  pairLine,
} from "./corrections-estate.js";

/**
 * ADR 0208 (WP-03), Learn from my corrections: the person's pairings no proven rule names go to
 * the assistant with their cited lines; it drafts reading rules; each is re-read on every file it
 * names, verified on its lines, and the estate join run with it (without the corrected calls'
 * pairings): a rule the join itself draws the corrections from, moving no arrow a person set or
 * deleted, is written active for the repos it was proven on; any other stays a draft saying why.
 * The assistant is a recorded stand-in (an AcpStepRunner that writes what a session would).
 */

const RULES = "org-pack/reading-rules/types/spring-boot.yaml";
const RULE =
  "A call's path is never the field that holds it: write the path the field's constant holds, as the comment on the line gives it.";
const KEY = "path-from-constant";
const ID = (line: number) => `forge-billing ${FILE}:${line}`;
/** The capture route as the gateway serves it: what the join must draw by itself. */
const ROUTE = "/partners/northwind/charges/{chargeId}/capture";
const SHORTER = "/partners/northwind/charges/{chargeId}";
const IDS: Record<number, string> = {
  31: "call.post.capture-charge",
  33: "call.post.capture-one",
  35: "call.post.capture-two",
  42: "call.post.charges",
};
const FIELD: Record<number, string> = {
  31: "captureChargePath",
  33: "captureOnePath",
  35: "captureTwoPath",
  42: "chargesPath",
};

let root: string;
beforeEach(async () => {
  root = await correctionsEstate("atticus-learn-");
  // The client: each call through a field, the paths its constant may hold said on the line.
  const src = Array.from({ length: 45 }, (_, i) => {
    const n = i + 1;
    if (FIELD[n]) return `    post(${FIELD[n]}, body); // "${ROUTE}" "${SHORTER}"`;
    return n === 1 ? "package forge.billing;" : `    // line ${n}`;
  }).join("\n");
  await writeFile(join(root, "workspace/forge-billing", FILE), src);
  const kept = (await readFile(join(root, "facts/forge-billing.jsonl"), "utf8"))
    .split("\n")
    .filter((l) => l.trim() && !l.includes(FILE));
  const calls = Object.entries(FIELD).map(([n, f]) =>
    JSON.stringify(callFact(IDS[Number(n)]!, f, Number(n))),
  );
  await writeFile(join(root, "facts/forge-billing.jsonl"), [...kept, ...calls].join("\n") + "\n");
});

const capture = (line: number) =>
  pairLine(IDS[line]!, line, FIELD[line]!, { repo: GW, entry: CAPTURE, path: ROUTE });

async function threeCorrections() {
  await writeFile(join(root, LINES), [capture(31), capture(33), capture(35)].join("\n") + "\n");
}

/** The stand-in assistant: drafts the rule, then re-reads each line with the path `paths` gives. */
function assistant(
  paths: Record<number, string>,
  o: { files?: string[]; key?: string; fail?: boolean; extra?: object[] } = {},
) {
  const steps: { change: string; line: string; writeRoots: string[] }[] = [];
  const key = o.key ?? KEY;
  const runner: AcpStepRunner = async (s) => {
    steps.push({ change: s.change, line: s.line, writeRoots: s.writeRoots ?? [] });
    if (s.change === "rules-draft") {
      await mkdir(join(root, "org-pack/reading-rules/types"), { recursive: true });
      const had = await readFile(join(root, RULES), "utf8").catch(
        () => "schemaVersion: 1\nrules:\n",
      );
      const rule = [
        `  - key: ${key}`,
        "    status: draft",
        `    rule: ${JSON.stringify(RULE)}`,
        `    files: ${JSON.stringify(o.files ?? ["src/main/java/**/*Client.java"])}`,
        "",
      ];
      await writeFile(
        join(root, RULES),
        had.replace(/rules: \[\]\n?/, "rules:\n") + rule.join("\n"),
      );
    } else {
      await mkdir(join(root, "facts/.try"), { recursive: true });
      const facts = Object.entries(paths).map(([n, path]) => {
        const f = callFact(IDS[Number(n)]!, path, Number(n));
        return JSON.stringify({ ...f, verified: "none", cite: { ...f.cite, value: path } });
      });
      facts.push(...(o.extra ?? []).map((x) => JSON.stringify(x)));
      await writeFile(join(root, `facts/.try/forge-billing.${key}.jsonl`), facts.join("\n") + "\n");
      if (o.fail) throw new Error("the session stopped");
    }
    return { stopReason: "end_turn", runId: `run-${steps.length}` } as never;
  };
  return { runner, steps };
}

const deps = (runner: AcpStepRunner): LearnDeps => ({ runner, by: "pat", now: AT });
const rulesFile = async () =>
  ReadingRulesFile.parse(parse(await readFile(join(root, RULES), "utf8")));
const ALL = { 31: ROUTE, 33: ROUTE, 35: ROUTE };
const quiet = { out: () => undefined, err: () => undefined };

describe("Learn from my corrections (ADR 0208)", () => {
  it("three corrections the join draws by itself from the re-read: one rule, active for the repo it was proven on", async () => {
    await threeCorrections();
    const a = assistant(ALL);
    const r = await learnFromCorrections(root, deps(a.runner));
    expect(r.draft, JSON.stringify(r.draft)).toEqual([]);
    expect(r.corrections).toBe(3);
    expect(a.steps[0]!.change).toBe("rules-draft");
    expect(a.steps[0]!.line).toContain(ID(31));
    expect(a.steps[0]!.line).toContain("post(captureChargePath, body);");
    expect(a.steps[1]!.line).toContain(`- \`${FILE}\``);
    expect(a.steps[1]!.writeRoots).toEqual([join(root, "facts/.try")]);
    expect(r.active).toEqual([{ key: KEY, file: RULES, reproduced: [ID(31), ID(33), ID(35)] }]);
    const f = await rulesFile();
    expect(f.schemaVersion).toBe(2);
    expect(f.rules[0]).toMatchObject({
      key: KEY,
      status: "active",
      learned: {
        corrections: [ID(31), ID(33), ID(35)],
        by: "pat",
        run: "run-1",
        proof: {
          repos: ["forge-billing"],
          reread: [`forge-billing ${FILE}`],
          reproduced: [ID(31), ID(33), ID(35)],
        },
      },
    });
    expect((await effectiveRules(root, "forge-billing")).rules.map((x) => x.key)).toContain(KEY);
    // The re-read is a test: the facts on file are as they were, and no .try file is left.
    expect(await readFile(join(root, "facts/forge-billing.jsonl"), "utf8")).toContain(
      '"path":"captureOnePath"',
    );
    expect(existsSync(join(root, `facts/.try/forge-billing.${KEY}.jsonl`))).toBe(false);
  });

  it("another repo of the type, with a call a person declined, isn't given the rule until it is proven there", async () => {
    await appendFile(
      join(root, "facts/forge-shop-bff.corrections.jsonl"),
      JSON.stringify({
        schemaVersion: 2,
        fact: "call.post.invoices-id-pay",
        target: { kind: "call", file: "src/Pay.java", line: 3, value: "/invoices/{id}/pay" },
        action: "unlink",
        by: "dee",
        at: "2026-11-08T09:30:00.000Z",
      }) + "\n",
    );
    await threeCorrections();
    await learnFromCorrections(root, deps(assistant(ALL).runner));
    const bff = await effectiveRules(root, "forge-shop-bff");
    expect(bff.rules.map((x) => x.key)).not.toContain(KEY);
    expect(bff.drafts.map((x) => x.key)).toContain(KEY);
  });

  it("stays a draft when the join wouldn't draw the correction itself: a shorter path", async () => {
    await threeCorrections();
    const r = await learnFromCorrections(root, deps(assistant({ ...ALL, 35: SHORTER }).runner));
    expect(r.active).toEqual([]);
    expect(r.draft[0]!.reasons).toEqual([{ kind: "not-reproduced", about: ID(35) }]);
    const f = await rulesFile();
    expect(f.rules[0]).toMatchObject({
      status: "draft",
      learned: { corrections: [ID(31), ID(33), ID(35)] },
    });
    expect(f.rules[0]!.learned!.why).toContain(ID(35));
  });

  it("stays a draft when two repos serve the path (the join asks, it draws nothing)", async () => {
    await appendFile(
      join(root, "facts/forge-shop-bff.jsonl"),
      JSON.stringify({
        kind: "entry",
        id: "entry.post.capture-too",
        repo: "forge-shop-bff",
        commit: "aaa1111",
        entryType: "rest",
        method: "POST",
        path: ROUTE,
        handler: "CaptureToo",
        cite: { file: "src/main/java/forge/shop/Capture.java", line: 4, value: ROUTE },
        verified: "line",
        by: "assistant",
        conf: "declared",
      }) + "\n",
    );
    await threeCorrections();
    const r = await learnFromCorrections(root, deps(assistant(ALL).runner));
    expect(r.active).toEqual([]);
    expect(r.draft[0]!.reasons.map((x) => x.kind)).toContain("not-reproduced");
  });

  it("stays a draft when it would change a call a person declined", async () => {
    await threeCorrections();
    await appendFile(
      join(root, LINES),
      JSON.stringify({
        schemaVersion: 2,
        fact: IDS[42],
        target: { kind: "call", file: FILE, line: 42, value: FIELD[42] },
        action: "unlink",
        by: "dee",
        at: "2026-11-08T09:30:00.000Z",
      }) + "\n",
    );
    const r = await learnFromCorrections(root, deps(assistant({ ...ALL, 42: ROUTE }).runner));
    expect(r.draft[0]!.reasons).toContainEqual({
      kind: "touched",
      about: `forge-billing ${FILE}:42`,
    });
  });

  it("stays a draft when it would draw again an arrow deleted on the canvas, and fails closed on an end it can't tie to a repo", async () => {
    await threeCorrections();
    const del = (from: string, to: string, n: number) =>
      deleteLink(
        root,
        // Each its own second: a delete's group is named by its time (Deleted links).
        {
          interfaces: [`if-000000000000000${n}`],
          from,
          to,
          by: "dee",
          now: new Date(AT.getTime() + n * 1000),
        },
        quiet,
      );
    await del("billing-api", "partner-gateway", 1);
    const r = await learnFromCorrections(root, deps(assistant({ ...ALL, 42: ROUTE }).runner));
    expect(r.draft[0]!.reasons).toContainEqual({
      kind: "deleted",
      about: "billing-api → partner-gateway",
    });
    // A delete whose end is a system, not a repo's component: no rule is proven while it stands.
    await del("billing", "platform", 2);
    const again = await learnFromCorrections(
      root,
      deps(assistant(ALL, { key: "path-from-constant-two" }).runner),
    );
    expect(again.active).toEqual([]);
    expect(again.draft[0]!.reasons).toEqual([
      { kind: "unresolved-delete", about: "billing → platform" },
    ]);
  });

  it("a failed draft uses no correction up: the next run asks again; a person can still activate it", async () => {
    await threeCorrections();
    await learnFromCorrections(root, deps(assistant({ ...ALL, 35: SHORTER }).runner));
    const b = assistant(ALL, { key: "path-from-constant-two" });
    const r = await learnFromCorrections(root, deps(b.runner));
    expect(b.steps.length).toBeGreaterThan(0);
    expect(r.active.map((x) => x.key)).toEqual(["path-from-constant-two"]);
    // ADR 0176's way: a person sets the learned draft active; their word replaces `learned`.
    const said: string[] = [];
    const io = { out: (l: string) => said.push(l), err: (l: string) => said.push(l) };
    const code = await rulesSetCommand(
      root,
      "activate",
      KEY,
      { type: "spring-boot" },
      { by: "dee" },
      io,
    );
    expect(code, said.join("\n")).toBe(0);
    const k = (await rulesFile()).rules.find((x) => x.key === KEY)!;
    expect(k.status).toBe("active");
    expect(k.learned).toBeUndefined();
    expect(k.by).toContain("set active by dee");
    expect((await effectiveRules(root, "forge-shop-bff")).rules.map((x) => x.key)).toContain(KEY);
  });

  it("run again after a proof with nothing new: nothing is asked and nothing written", async () => {
    await threeCorrections();
    await learnFromCorrections(root, deps(assistant(ALL).runner));
    const before = await readFile(join(root, RULES), "utf8");
    const b = assistant({});
    const r = await learnFromCorrections(root, deps(b.runner));
    expect(r).toMatchObject({ corrections: 0, active: [], draft: [] });
    expect(b.steps).toEqual([]);
    expect(await readFile(join(root, RULES), "utf8")).toBe(before);
  });

  it("a session that stops in the re-read leaves no .try file and takes its drafts back", async () => {
    await threeCorrections();
    await expect(
      learnFromCorrections(root, deps(assistant(ALL, { fail: true }).runner)),
    ).rejects.toThrow(/stopped/);
    expect(existsSync(join(root, `facts/.try/forge-billing.${KEY}.jsonl`))).toBe(false);
    expect(existsSync(join(root, RULES))).toBe(false);
  });

  it("a rule naming none of the corrected files stays a draft and isn't re-read", async () => {
    await threeCorrections();
    const a = assistant(ALL, { files: ["src/main/resources/**/*.yml"] });
    const r = await learnFromCorrections(root, deps(a.runner));
    expect(r.draft[0]!.reasons).toEqual([{ kind: "no-files" }]);
    expect((await rulesFile()).rules[0]!.learned!.corrections).toEqual([]);
    expect(a.steps.map((s) => s.change)).toEqual(["rules-draft"]);
  });

  it("learns nothing from the AI's pairings or a spread's lines, and refuses with AI off", async () => {
    await writeFile(
      join(root, LINES),
      [
        pairLine(
          IDS[31]!,
          31,
          FIELD[31]!,
          { repo: GW, entry: CAPTURE, path: ROUTE },
          { run: "r0" },
        ),
        JSON.stringify({
          ...JSON.parse(capture(42)),
          rule: { from: `link:forge-billing:${IDS[31]}`, match: "/charges/**" },
        }),
      ].join("\n") + "\n",
    );
    const a = assistant({});
    expect((await learnFromCorrections(root, deps(a.runner))).corrections).toBe(0);
    expect(a.steps).toEqual([]);
    await appendFile(join(root, "org-pack/runtime.yaml"), "ai: off\n");
    await expect(learnFromCorrections(root, deps(a.runner))).rejects.toThrow(/AI on/);
  });

  describe("the callee side: a re-read moves an entry other repos' calls meet", () => {
    const CONTROLLER = "src/main/java/forge/billing/InvoicesController.java";
    const V2 = "/v2/invoices/{id}/pay";
    /** The re-read's copy of the invoices entry, moved to /v2 as the controller's line says. */
    const moved = {
      kind: "entry",
      id: "entry.post.v2-invoices-id-pay",
      repo: "forge-billing",
      commit: "aaa1111",
      entryType: "rest",
      method: "POST",
      path: V2,
      handler: "InvoicesController.pay",
      cite: { file: CONTROLLER, line: 13, value: V2 },
      verified: "none",
      by: "assistant",
      conf: "declared",
    };
    beforeEach(async () => {
      const lines = Array.from({ length: 20 }, (_, i) =>
        i === 12 ? `    @PostMapping("${V2}") // was "/invoices/{id}/pay"` : `    // line ${i + 1}`,
      );
      await writeFile(join(root, "workspace/forge-billing", CONTROLLER), lines.join("\n"));
    });
    const wide = (extra: object[]) =>
      assistant(ALL, { files: ["src/main/java/**/*.java"], extra }).runner;

    it("stays a draft when another repo's loose call would newly join it and a person deleted that arrow", async () => {
      // The shop calls /v2 already: loose until the entry moves there.
      await appendFile(
        join(root, "facts/forge-shop-bff.jsonl"),
        JSON.stringify({
          ...callFact("call.post.v2-invoices-id-pay", V2, 30),
          repo: "forge-shop-bff",
          base: "forge.billing.base-url",
          cite: { file: "src/main/java/forge/shop/CheckoutController.java", line: 30, value: V2 },
        }) + "\n",
      );
      await deleteLink(
        root,
        {
          interfaces: ["if-0000000000000009"],
          from: "shop-bff",
          to: "billing-api",
          by: "dee",
          now: AT,
        },
        quiet,
      );
      await threeCorrections();
      const r = await learnFromCorrections(root, deps(wide([moved])));
      expect(r.active).toEqual([]);
      expect(r.draft[0]!.reasons).toContainEqual({
        kind: "deleted",
        about: "shop-bff → billing-api",
      });
    });

    it("stays a draft when a person's pairing from another repo onto the entry would no longer join", async () => {
      const CALLER = "src/main/java/forge/shop/CheckoutController.java";
      await appendFile(
        join(root, "facts/forge-shop-bff.corrections.jsonl"),
        JSON.stringify({
          schemaVersion: 2,
          fact: "call.post.invoices-id-pay",
          target: { kind: "call", file: CALLER, line: 18, value: "/invoices/{id}/pay" },
          action: "link",
          link: {
            repo: "forge-billing",
            entry: "entry.post.invoices-id-pay",
            method: "POST",
            path: "/invoices/{id}/pay",
          },
          by: "dee",
          at: "2026-11-08T09:30:00.000Z",
        }) + "\n",
      );
      // That pairing was learned from before (a rule proven on the shop): not asked about again.
      await mkdir(join(root, "org-pack/reading-rules/types"), { recursive: true });
      const shop = `forge-shop-bff ${CALLER}:18`;
      await writeFile(
        join(root, RULES),
        [
          "schemaVersion: 2",
          "rules:",
          "  - key: shop-billing-base",
          "    status: active",
          '    rule: "The shop calls the billing repo through its billing.base-url setting."',
          '    files: ["src/main/java/forge/shop/**"]',
          "    learned:",
          `      corrections: ["${shop}"]`,
          "      by: dee",
          "      at: 2026-11-08T09:40:00.000Z",
          "      proof:",
          "        repos: [forge-shop-bff]",
          `        reread: ["forge-shop-bff ${CALLER}"]`,
          `        reproduced: ["${shop}"]`,
          "",
        ].join("\n"),
      );
      await threeCorrections();
      const r = await learnFromCorrections(root, deps(wide([moved])));
      expect(r.active).toEqual([]);
      expect(r.draft[0]!.reasons).toContainEqual({ kind: "touched", about: shop });
    });
  });

  describe("a person's correction going stale under a learned rule fails closed (ADR 0208)", () => {
    const REFUND = 44;
    beforeEach(async () => {
      // The client has a refund call at line 44 too, read now under a new id and name.
      const file = join(root, "workspace/forge-billing", FILE);
      const src = (await readFile(file, "utf8")).split("\n");
      src[REFUND - 1] = `    post(refundPath, body); // "${ROUTE}"`;
      await writeFile(file, src.join("\n"));
      await appendFile(
        join(root, "facts/forge-billing.jsonl"),
        JSON.stringify(callFact("call.post.refund-new", "refundPath", REFUND)) + "\n",
      );
      // The person's "none" of the call as it was read before.
      await appendFile(
        join(root, LINES),
        JSON.stringify({
          schemaVersion: 2,
          fact: "call.post.refund-old",
          target: { kind: "call", file: FILE, line: REFUND, value: "oldRefundPath" },
          action: "unlink",
          by: "dee",
          at: "2026-11-08T09:30:00.000Z",
        }) + "\n",
      );
    });
    const verify = async () => {
      const said: string[] = [];
      const code = await verifyCommand(
        root,
        "forge-billing",
        { write: true },
        { out: (l) => said.push(l), err: (l) => said.push(l) },
      );
      return { code, said: said.join("\n") };
    };

    it("refuses the repo's write, naming the correction and both next steps, where a learned rule names its file", async () => {
      await mkdir(join(root, "org-pack/reading-rules/types"), { recursive: true });
      await writeFile(
        join(root, RULES),
        [
          "schemaVersion: 2",
          "rules:",
          `  - key: ${KEY}`,
          "    status: active",
          `    rule: ${JSON.stringify(RULE)}`,
          '    files: ["src/main/java/**/*Client.java"]',
          "    learned:",
          `      corrections: ["${ID(31)}"]`,
          "      by: pat",
          "      at: 2026-11-08T10:15:00.000Z",
          "      proof:",
          "        repos: [forge-billing]",
          `        reread: ["forge-billing ${FILE}"]`,
          `        reproduced: ["${ID(31)}"]`,
          "",
        ].join("\n"),
      );
      const facts = await readFile(join(root, "facts/forge-billing.jsonl"), "utf8");
      const v = await verify();
      expect(v.code).not.toBe(0);
      expect(v.said).toContain(`${FILE}:${REFUND}`);
      expect(v.said).toContain(`atticus rules off ${KEY} --repo forge-billing`);
      expect(v.said).toMatch(/answer the call again/);
      expect(await readFile(join(root, "facts/forge-billing.jsonl"), "utf8")).toBe(facts);
      expect(existsSync(join(root, "catalog/sources/forge-billing"))).toBe(false);
    });

    it("behaves as before where no learned rule names the file", async () => {
      const v = await verify();
      expect(v.said).not.toContain("atticus rules off");
    });
  });

  describe("a deleted arrow drawn again by a learned rule's next read fails closed (ADR 0208)", () => {
    const CONTROLLER = "src/main/java/forge/billing/InvoicesController.java";
    const V2 = "/v2/invoices/{id}/pay";
    /** An active learned rule for forge-billing, naming every Java file. */
    beforeEach(async () => {
      await mkdir(join(root, "org-pack/reading-rules/types"), { recursive: true });
      await writeFile(
        join(root, RULES),
        [
          "schemaVersion: 2",
          "rules:",
          `  - key: ${KEY}`,
          "    status: active",
          `    rule: ${JSON.stringify(RULE)}`,
          '    files: ["src/main/java/**/*.java"]',
          "    learned:",
          `      corrections: ["${ID(31)}"]`,
          "      by: pat",
          "      at: 2026-11-08T10:15:00.000Z",
          "      proof:",
          "        repos: [forge-billing]",
          `        reread: ["forge-billing ${FILE}"]`,
          `        reproduced: ["${ID(31)}"]`,
          "",
        ].join("\n"),
      );
    });
    const del = (from: string, to: string) =>
      deleteLink(
        root,
        { interfaces: ["if-00000000000000aa"], from, to, by: "dee", now: AT },
        quiet,
      );
    const verify = async () => {
      const said: string[] = [];
      const code = await verifyCommand(
        root,
        "forge-billing",
        { write: true },
        { out: (l) => said.push(l), err: (l) => said.push(l) },
      );
      return { code, said: said.join("\n") };
    };

    it("as the caller: a call the rule now reads to a new path joins the deleted pair, so the write is refused", async () => {
      // The next read: line 44 now reads as the capture route, which the gateway serves.
      const file = join(root, "workspace/forge-billing", FILE);
      const src = (await readFile(file, "utf8")).split("\n");
      src[43] = `    post(refundPath, body); // "${ROUTE}"`;
      await writeFile(file, src.join("\n"));
      await appendFile(
        join(root, "facts/forge-billing.jsonl"),
        JSON.stringify(callFact("call.post.refund", ROUTE, 44)) + "\n",
      );
      await del("billing-api", "partner-gateway");
      const facts = await readFile(join(root, "facts/forge-billing.jsonl"), "utf8");
      const v = await verify();
      expect(v.code).not.toBe(0);
      expect(v.said).toContain(`${FILE}:44`);
      expect(v.said).toContain("billing-api → partner-gateway");
      expect(v.said).toContain(`atticus rules off ${KEY} --repo forge-billing`);
      expect(v.said).toMatch(/delete the arrow again/);
      expect(await readFile(join(root, "facts/forge-billing.jsonl"), "utf8")).toBe(facts);
    });

    it("as the callee: an entry the rule now reads at a new path draws a deleted caller's arrow, so the write is refused", async () => {
      const lines = Array.from({ length: 20 }, (_, i) =>
        i === 12 ? `    @PostMapping("${V2}")` : `    // line ${i + 1}`,
      );
      await writeFile(join(root, "workspace/forge-billing", CONTROLLER), lines.join("\n"));
      await writeFile(
        join(root, "facts/forge-billing.jsonl"),
        (await readFile(join(root, "facts/forge-billing.jsonl"), "utf8"))
          .split("\n")
          .filter((l) => l.trim() && !l.includes(CONTROLLER))
          .join("\n") +
          "\n" +
          JSON.stringify({
            kind: "entry",
            id: "entry.post.v2-invoices-id-pay",
            repo: "forge-billing",
            commit: "aaa1111",
            entryType: "rest",
            method: "POST",
            path: V2,
            handler: "InvoicesController.pay",
            cite: { file: CONTROLLER, line: 13, value: V2 },
            verified: "line",
            by: "assistant",
            conf: "declared",
          }) +
          "\n",
      );
      await appendFile(
        join(root, "facts/forge-shop-bff.jsonl"),
        JSON.stringify({
          ...callFact("call.post.v2-invoices-id-pay", V2, 30),
          repo: "forge-shop-bff",
          base: "forge.billing.base-url",
          cite: { file: "src/main/java/forge/shop/CheckoutController.java", line: 30, value: V2 },
        }) + "\n",
      );
      await del("shop-bff", "billing-api");
      const v = await verify();
      expect(v.code).not.toBe(0);
      expect(v.said).toContain(`${CONTROLLER}:13`);
      expect(v.said).toContain("shop-bff → billing-api");
    });

    it("lets the write through where no learned rule names the file", async () => {
      await writeFile(join(root, RULES), "schemaVersion: 1\nrules: []\n");
      await del("billing-api", "partner-gateway");
      expect((await verify()).said).not.toContain("delete the arrow again");
    });
  });
});
