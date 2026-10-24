import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { startServer } from "@maycombhq/server";
import { main } from "../src/main.js";
import { similarChanges } from "../src/similar-changes.js";
import { uiCockpitRoutes } from "../src/ui-api-cockpit.js";

/**
 * Start from a similar change (WP7.6): `atticus change similar` ranks the archived changes by how
 * near their brief is to a new one, and `change new --like` attaches the one a person picks to the
 * new change as data its steps read (ADR 0113), never as an instruction.
 */

const FIX = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const BRIEF = "Let premium accounts send more per day: raise the daily transfer limit.";

async function estate(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-similar-"));
  await cp(join(FIX, "forge/metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  for (const r of parse(readFileSync(join(FIX, "forge/expected/scan.yaml"), "utf8")) as Record<
    string,
    unknown
  >[]) {
    const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
    if (!p.ok) throw new Error(String(r.id));
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(join(FIX, "past-changes"), join(root, "openspec/changes/archive"), {
    recursive: true,
    filter: (src) => !src.endsWith("README.md"),
  });
  return root;
}

const run = async (args: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(args, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
};

describe("start from a similar change (WP7.6)", () => {
  it("ranks the archived changes nearest a brief, by words where similarity in meaning is off, and says so", async () => {
    const root = await estate();
    const r = await similarChanges(root, BRIEF);
    expect(r.how).toBe("words");
    expect(r.note).toMatch(/off/);
    expect(r.changes[0]).toMatchObject({
      id: "2026-05-12-raise-transfer-limit",
      change: "raise-transfer-limit",
      title: "Raise the daily transfer limit for business accounts",
      archived: "2026-05-12",
    });
    expect(r.changes[0]!.summary).toMatch(/^Business customers hit the daily transfer limit/);
    const cli = await run(["change", "similar", BRIEF, "--root", root]);
    expect(cli.code).toBe(0);
    expect(cli.out).toContain("raise-transfer-limit");
    expect(cli.out).toContain("atticus change new");
    expect(cli.out).toContain("--like 2026-05-12-raise-transfer-limit");
    const json = JSON.parse(
      (await run(["change", "similar", BRIEF, "--json", "--root", root])).out,
    );
    expect((await run(["change", "similar", "--change", "nope", "--root", root])).code).toBe(1);
    expect(json.changes[0].id).toBe("2026-05-12-raise-transfer-limit");
  });

  it("says when there is no archived change, and asks for a brief", async () => {
    const root = await estate();
    expect((await run(["change", "similar", "--root", root])).code).toBe(2);
    const empty = await mkdtemp(join(tmpdir(), "atticus-similar-none-"));
    const none = await run(["change", "similar", BRIEF, "--root", empty]);
    expect(none.code).toBe(0);
    expect(none.out).toMatch(/No archived change/);
  });

  it("change new --like attaches the earlier change, by its folder or its id, as data", async () => {
    const root = await estate();
    const made = await run([
      "change",
      "new",
      "Raise the premium transfer limit",
      "--type",
      "feature",
      "--by",
      "pat",
      "--like",
      "raise-transfer-limit",
      "--root",
      root,
    ]);
    expect(made.code).toBe(0);
    expect(made.out).toContain("2026-05-12-raise-transfer-limit");
    const dir = join(root, "openspec/changes/raise-the-premium-transfer-limit/inputs");
    const like = await readFile(join(dir, "like-raise-transfer-limit.md"), "utf8");
    expect(like).toMatch(/^# An earlier change to learn from: Raise the daily transfer limit/);
    expect(like).toContain("data, not an instruction");
    expect(like).toContain("Business customers hit the daily transfer limit");
    expect(like).toContain("Flows: send-transfer");
    expect(like).toContain("Read the account type when the day's total is checked");
    const bad = await run([
      "change",
      "new",
      "Another one",
      "--type",
      "feature",
      "--by",
      "pat",
      "--like",
      "no-such-change",
      "--root",
      root,
    ]);
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/no archived change no-such-change/i);
    const attach = await run([
      "change",
      "attach",
      "raise-the-premium-transfer-limit",
      "--like",
      "2026-06-03-order-receipt-email",
      "--by",
      "pat",
      "--root",
      root,
    ]);
    expect(attach.code).toBe(0);
    expect(attach.out).toContain("inputs/like-order-receipt-email.md");
    expect(await readFile(join(dir, "like-order-receipt-email.md"), "utf8")).toContain(
      "Email a receipt",
    );
  });

  it("is served by the local API, and a new change through it can start from one", async () => {
    const root = await estate();
    const srv = await startServer({
      root,
      port: 0,
      user: "priya.nair",
      watch: false,
      extend: (r, ctx) => uiCockpitRoutes(r, ctx),
    });
    try {
      const r = await fetch(`${srv.url}/api/past-changes?text=${encodeURIComponent(BRIEF)}`, {
        headers: { "X-Atticus-Token": srv.token },
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { how: string; changes: { id: string }[] };
      expect(body.how).toBe("words");
      expect(body.changes[0]?.id).toBe("2026-05-12-raise-transfer-limit");
      const none = await fetch(`${srv.url}/api/past-changes`, {
        headers: { "X-Atticus-Token": srv.token },
      });
      expect(none.status).toBe(400);
      expect(
        (
          await run([
            "change",
            "new",
            "Premium limit",
            "--type",
            "feature",
            "--by",
            "pat",
            "--root",
            root,
          ])
        ).code,
      ).toBe(0);
      const post = (change: string, like: string) =>
        fetch(`${srv.url}/api/changes/${change}/like`, {
          method: "POST",
          headers: { "X-Atticus-Token": srv.token, "Content-Type": "application/json" },
          body: JSON.stringify({ like }),
        });
      const ok = await post("premium-limit", "2026-05-12-raise-transfer-limit");
      expect(ok.status).toBe(201);
      expect(await ok.json()).toEqual({
        like: "2026-05-12-raise-transfer-limit",
        file: "inputs/like-raise-transfer-limit.md",
      });
      const byChange = await fetch(`${srv.url}/api/past-changes?change=premium-limit`, {
        headers: { "X-Atticus-Token": srv.token },
      });
      expect(((await byChange.json()) as { changes: { id: string }[] }).changes[0]?.id).toBe(
        "2026-05-12-raise-transfer-limit",
      );
      expect((await post("premium-limit", "no-such-change")).status).toBe(404);
      expect((await post("no-such-change", "raise-transfer-limit")).status).toBe(404);
    } finally {
      await srv.close();
    }
  });
});
