import { cp, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api, parseAuditFile } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { auditCommand } from "../src/audit-commands.js";
import { uiAuditRoutes } from "../src/ui-api-audit.js";

/**
 * A sample audit answered in the app (P3's follow-up, ADR 0149): GET /api/facts/{repo}/audit
 * draws the sample `atticus verify audit` draws (the same seed, the same items), each with its
 * cited lines, writing nothing; POST writes the answers to `facts/<repo>.audit.yaml` by the
 * CLI's own functions, which its --report then reads. On the invented estate of
 * fixtures/link-estate; no git runs and nothing reaches the network.
 */

const FIX = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/link-estate");
const NOW = new Date("2026-11-01T10:00:00.000Z");
const PERSON = "Priya Nair <priya@forge.example>";

let srv: RunningServer;
let root: string;

const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(srv.url + path, {
    method,
    headers: { "X-Atticus-Token": srv.token, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};
const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-ui-audit-"));
  await cp(join(FIX, "org-pack"), join(root, "org-pack"), { recursive: true });
  await cp(join(FIX, "facts"), join(root, "facts"), { recursive: true });
  for (const r of await readdir(join(FIX, "repos")))
    await cp(join(FIX, "repos", r), join(root, "workspace", r), { recursive: true });
  srv = await startServer({
    root,
    port: 0,
    user: PERSON,
    extend: (r, ctx) => uiAuditRoutes(r, ctx, { now: () => NOW }),
  });
});
afterAll(() => srv?.close());

describe("a sample audit in the app", { timeout: 60_000 }, () => {
  it("draws what the CLI draws, with each item's cited lines, and writes nothing", async () => {
    const r = await call("GET", "/api/facts/forge-payments/audit?seed=s1&size=3");
    expect(r.status).toBe(200);
    const v = Api.AuditSampleView.parse(r.body);
    expect(v).toMatchObject({
      repo: "forge-payments",
      file: "facts/forge-payments.audit.yaml",
      seed: "s1",
      size: 3,
      defaultSeed: "forge-payments@c3c0006",
      command: "atticus verify audit forge-payments --seed s1 --size 3",
    });
    expect(v.items).toHaveLength(6);
    expect(v.items.every((i) => i.lines.length === i.cites.length)).toBe(true);
    // A fact's cited line, as the checkout has it.
    expect(v.items.find((i) => i.kind === "fact")!.lines[0]!.text).toBeTruthy();
    expect(existsSync(join(root, "facts/forge-payments.audit.yaml"))).toBe(false);

    // The CLI with the same seed and size draws the same items.
    const c = capture();
    await auditCommand(
      root,
      "forge-payments",
      { size: 3, seed: "s1", by: "tom", json: true, now: () => NOW },
      c.io,
    );
    const cli = JSON.parse(c.out.join("\n")).drawn as { id: string }[];
    expect(cli.map((d) => d.id)).toEqual(v.items.map((i) => i.id));
  });

  it("writes the answers by the CLI's functions, as the signed-in person, and the report reads them", async () => {
    const v = Api.AuditSampleView.parse(
      (await call("GET", "/api/facts/forge-payments/audit?seed=s1&size=3")).body,
    );
    const fact = v.items.find((i) => i.kind === "fact")!;
    const link = v.items.find((i) => i.kind === "link")!;
    const r = await call("POST", "/api/facts/forge-payments/audit", {
      seed: "s1",
      size: 3,
      answers: [
        { id: fact.id, answer: "wrong", note: "It is a PUT" },
        { id: link.id, answer: "right" },
      ],
    });
    expect(r.status).toBe(200);
    const res = Api.AuditAnswerResult.parse(r.body);
    expect(res).toMatchObject({
      file: "facts/forge-payments.audit.yaml",
      answered: 2,
      open: 4,
      commit:
        'git add facts/forge-payments.audit.yaml && git commit -m "forge-payments: a person\'s sample audit answers"',
    });
    expect(res.precision.facts).toMatchObject({ right: 0, wrong: 1 });
    expect(res.precision.links).toMatchObject({ right: 1, wrong: 0 });
    const file = parseAuditFile(
      await readFile(join(root, "facts/forge-payments.audit.yaml"), "utf8"),
    );
    if (!file.ok) throw new Error(file.issues.join("; "));
    expect(file.file.items.find((i) => i.id === fact.id)).toMatchObject({
      answer: "wrong",
      note: "It is a PUT",
      by: PERSON,
      at: NOW.toISOString(),
    });
    expect(file.file.draws).toEqual([
      { seed: "s1", size: 3, commit: "c3c0006", at: NOW.toISOString() },
    ]);
    // The answers on file come back with the next draw.
    const again = Api.AuditSampleView.parse(
      (await call("GET", "/api/facts/forge-payments/audit?seed=s1&size=3")).body,
    );
    expect(again.items.find((i) => i.id === fact.id)?.answer).toBe("wrong");
    // And the CLI's report counts them.
    const c = capture();
    expect(await auditCommand(root, "forge-payments", { report: true, by: "tom" }, c.io)).toBe(0);
    expect(c.out.join("\n")).toContain("0 of 1 right");
  });

  it("refuses an id not in the draw, a bad body and a bad size, and says why a repo can't be audited", async () => {
    const bad = await call("POST", "/api/facts/forge-payments/audit", {
      seed: "s1",
      size: 3,
      answers: [{ id: "fact:nope", answer: "right" }],
    });
    expect(bad.status).toBe(422);
    expect(JSON.stringify(bad.body)).toContain("fact:nope");
    expect(
      (await call("POST", "/api/facts/forge-payments/audit", { seed: "s1", size: 3, answers: [] }))
        .status,
    ).toBe(400);
    expect((await call("GET", "/api/facts/forge-payments/audit?size=0")).status).toBe(400);
    expect((await call("GET", "/api/facts/..%2Fx/audit")).status).toBe(400);
    const none = Api.AuditSampleView.parse(
      (await call("GET", "/api/facts/forge-nothing/audit")).body,
    );
    expect(none).toMatchObject({ refused: "no-facts", items: [] });
    expect(
      (
        await call("POST", "/api/facts/forge-nothing/audit", {
          seed: "s",
          size: 1,
          answers: [{ id: "x", answer: "right" }],
        })
      ).status,
    ).toBe(404);
    // A repo with a fact not yet verified is refused, as the CLI refuses it.
    const text = await readFile(join(root, "facts/forge-cards.jsonl"), "utf8");
    await writeFile(
      join(root, "facts/forge-cards.jsonl"),
      text.replace(/"verified":"line"/, '"verified":"none"'),
    );
    const un = Api.AuditSampleView.parse((await call("GET", "/api/facts/forge-cards/audit")).body);
    expect(un).toMatchObject({ refused: "unverified", unverified: 1 });
  });
});
