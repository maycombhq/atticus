import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { loadLessons } from "@maycombhq/learn";
import { startServer } from "@maycombhq/server";
import { sandboxCreate } from "../src/learn-commands.js";
import { main } from "../src/main.js";
import { extendUiRoutes } from "../src/ui-commands.js";

/**
 * UX review: initiatives start, are planned and have their commitments recorded in the app, the
 * same functions `atticus initiative new|plan|commit` call, with the server's user as `by`.
 */
const T = 180_000;
const NOW = new Date("2026-12-14T09:00:00Z");

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

/** A scanned practice sandbox with the team-lead lesson's parties written in. */
async function scannedRoot(): Promise<string> {
  const c = capture();
  const dir = join(await mkdtemp(join(tmpdir(), "atticus-ui-initiatives-")), "sandbox");
  expect(await sandboxCreate(dir, { json: true }, c.io, { now: NOW })).toBe(0);
  const root = (JSON.parse(c.out.join("\n")) as { root: string }).root;
  expect(await main(["scan", "--root", root], capture().io)).toBe(0);
  const team = (await loadLessons()).lessons.find((l) => l.id === "team-lead-initiative")!;
  for (const f of team.steps[0]!.solution!.files) {
    const p = join(root, ...f.path.split("/"));
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, f.content, "utf8");
  }
  return root;
}

it(
  "starts, plans and records an initiative as the server's user, then lists it to propose",
  async () => {
    const root = await scannedRoot();
    // The practice metarepo isn't a Git repository; a real one is, and Propose lists from Git.
    execFileSync("git", ["init", "-q"], { cwd: root });
    const s = await startServer({
      root,
      port: 0,
      user: "tia",
      extend: (r, ctx) => extendUiRoutes(r, ctx),
    });
    const call = (method: string, path: string, body?: unknown) =>
      fetch(`${s.url}${path}`, {
        method,
        headers: { "X-Atticus-Token": s.token, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    try {
      let res = await call("POST", "/api/initiatives", {
        title: "Northwind Pay v3 migration",
        journey: "vendor-api-change",
        release: "2027-03-01",
      });
      expect(res.status).toBe(201);
      const made = (await res.json()) as { initiative: string; lines: string[] };
      expect(made.initiative).toBe("northwind-pay-v3-migration");
      expect(made.lines[0]).toBe(
        "Started northwind-pay-v3-migration (vendor-api-change). Wrote catalog/curated/initiative/northwind-pay-v3-migration.yaml.",
      );
      const rec = parse(
        await readFile(
          join(root, "catalog/curated/initiative/northwind-pay-v3-migration.yaml"),
          "utf8",
        ),
      ) as { evidence: { by?: string }[]; targetRelease: string };
      expect(rec.evidence).toEqual([{ source: "manual", by: "tia" }]);
      expect(rec.targetRelease).toBe("2027-03-01");

      // the same id again is a conflict; a journey that isn't one is the form's mistake
      res = await call("POST", "/api/initiatives", {
        title: "Northwind Pay v3 migration",
        journey: "vendor-api-change",
      });
      expect(res.status).toBe(409);
      res = await call("POST", "/api/initiatives", { title: "x", journey: "voyage" });
      expect(res.status).toBe(400);

      res = await call("POST", "/api/initiatives/northwind-pay-v3-migration/plan", {
        target: "northwind-pay",
      });
      expect(res.status).toBe(200);
      const planned = (await res.json()) as { lines: string[] };
      expect(planned.lines[0]).toMatch(/^Northwind Pay v3 migration: \d+ items from northwind-pay/);
      res = await call("POST", "/api/initiatives/nothing-here/plan", { target: "northwind-pay" });
      expect(res.status).toBe(404);

      res = await call("POST", "/api/commitments/northwind-pay-v3-migration.vendor-spec/status", {
        status: "at-risk",
        note: "The vendor moved the spec to Friday.",
      });
      expect(res.status).toBe(200);
      const said = (await res.json()) as { lines: string[] };
      expect(said.lines[0]).toMatch(/^northwind-pay-v3-migration\.vendor-spec is at-risk\. Wrote /);
      const notes = parse(
        await readFile(join(root, "initiatives/northwind-pay-v3-migration/notes.yaml"), "utf8"),
      ) as { notes: { by: string; note: string; status: string }[] };
      expect(notes.notes.map((n) => [n.by, n.status, n.note])).toEqual([
        ["tia", "at-risk", "The vendor moved the spec to Friday."],
      ]);
      res = await call("POST", "/api/commitments/nobody.nothing/status", { status: "done" });
      expect(res.status).toBe(404);
      res = await call("POST", "/api/commitments/northwind-pay-v3-migration.vendor-spec/status", {
        status: "finished",
      });
      expect(res.status).toBe(400);

      res = await call("GET", "/api/initiatives");
      const list = (await res.json()) as {
        initiative: string;
        commitments: { id: string; recorded: string; note?: { note: string } }[];
      }[];
      const spec = list[0]!.commitments.find(
        (c) => c.id === "northwind-pay-v3-migration.vendor-spec",
      )!;
      expect(spec.recorded).toBe("at-risk");
      expect(spec.note?.note).toBe("The vendor moved the spec to Friday.");

      res = await call("GET", "/api/propose?scope=initiatives");
      expect(res.status).toBe(200);
      const plan = (await res.json()) as { files: { path: string }[]; branch: string };
      const paths = plan.files.map((f) => f.path);
      expect(paths).toContain("catalog/curated/initiative/northwind-pay-v3-migration.yaml");
      expect(paths).toContain("initiatives/northwind-pay-v3-migration/notes.yaml");
      expect(plan.branch).toMatch(/^propose\/initiatives\//);
    } finally {
      await s.close();
    }
  },
  T,
);
