import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  listUndo,
  parseBuildManifest,
  serializeBuildManifest,
  undoDirOf,
} from "@maycombhq/scanner";
import { startServer, type RunningServer } from "@maycombhq/server";
import type { BuildAndWrite, BuildRefusal } from "@maycombhq/scanner";
import { writeGoingOn, type WentPast } from "../src/map-render-commands.js";
import { refusalEnds, refusalScope, refusedBuild } from "../src/standing.js";
import { applyMapEdits, catalogBuild } from "../src/catalog-build-commands.js";
import { extendUiRoutes } from "../src/ui-commands.js";
import { verifyAllCommand, verifyCommand } from "../src/verify-commands.js";

/**
 * ADR 0210 part 3: a write a person runs as part of the work doesn't block on what it can go
 * past. A second read that leaves a fact out keeps it while its files are unchanged, and a hand
 * edit of the catalog is kept as the person's while the write goes on. On the invented Forge
 * estate of fixtures/gateway-facts/policy-tokens; files only.
 */
const FIX = join(__dirname, "..", "..", "..", "fixtures", "gateway-facts", "policy-tokens");
const COMMIT: Record<string, string> = {
  "northwind_pay_1-0": "7777ccc",
  "forge-payments": "5555ddd",
  "forge-refunds": "6666eee",
  "forge-checkout": "4444fff",
};
const REPO = "forge-payments";
const AT = new Date("2026-11-24T10:00:00.000Z");
const T = 300_000;
const temps: string[] = [];
const servers: RunningServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

function metarepo(): string {
  const root = mkdtempSync(join(tmpdir(), "atticus-goes-on-"));
  temps.push(root);
  cpSync(join(FIX, "org-pack"), join(root, "org-pack"), { recursive: true });
  mkdirSync(join(root, "facts"), { recursive: true });
  for (const r of Object.keys(COMMIT)) {
    cpSync(join(FIX, "repos", r), join(root, "workspace", r), { recursive: true });
    writeFileSync(
      join(root, "facts", `${r}.jsonl`),
      readFileSync(join(FIX, "facts", `${r}.jsonl`), "utf8"),
    );
  }
  return root;
}
const opts = (root: string, repo: string) => ({
  commit: COMMIT[repo]!,
  dir: join(root, "workspace", repo),
  write: true,
  now: () => AT,
});
const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};
async function written(): Promise<string> {
  const root = metarepo();
  for (const r of Object.keys(COMMIT))
    expect(await verifyCommand(root, r, opts(root, r), io().io)).toBe(0);
  return root;
}
const CONTROLLER = "src/main/java/forge/payments/PaymentsController.java";
/** The facts file the read wrote, by id. */
const factIds = (root: string, at = join(root, "facts", `${REPO}.jsonl`)) =>
  readFileSync(at, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => (JSON.parse(l) as { id: string }).id);
/** A second read that leaves entry.post.payments out. */
const leaveOutPost = (root: string) => {
  const facts = readFileSync(join(root, "facts", `${REPO}.jsonl`), "utf8")
    .trim()
    .split("\n");
  writeFileSync(join(root, "facts", `${REPO}.jsonl`), `${facts[0]}\n`);
};
const handEdit = (root: string) => {
  const file = join(root, "catalog", "generated", "component", "payments-api.yaml");
  const text = readFileSync(file, "utf8");
  writeFileSync(
    file,
    /^runtime: /m.test(text)
      ? text.replace(/^runtime: .*$/m, "runtime: openshift")
      : `${text.trimEnd()}\nruntime: openshift\n`,
  );
  return file;
};
const json = (q: { out: string[] }) => JSON.parse(q.out.join("\n")) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- verify's --json, read loosely
const endpoints = (root: string) =>
  readdirSync(join(root, "catalog", "generated", "endpoint")).filter((f) =>
    f.startsWith("payments-api."),
  );

describe("a write that goes on (ADR 0210 part 3)", () => {
  it(
    "keeps a fact a second read left out while its files are unchanged, and says so",
    async () => {
      const root = await written();
      const before = endpoints(root);
      expect(before.length).toBe(2);
      const facts = readFileSync(join(root, "facts", `${REPO}.jsonl`), "utf8")
        .trim()
        .split("\n");
      writeFileSync(join(root, "facts", `${REPO}.jsonl`), `${facts[0]}\n`);
      const q = io();
      expect(await verifyCommand(root, REPO, opts(root, REPO), q.io)).toBe(0);
      expect(q.err.join("\n")).toMatch(
        /^Kept 1 fact of the last read that this read left out, every file it cites unchanged: entry\.post/m,
      );
      expect(endpoints(root)).toEqual(before);
      // The kept fact is the catalog's slot's, not the read's: the facts file the read wrote
      // holds the read's own fact alone, so a later change to the kept fact's file is no
      // rejection of a read.
      expect(factIds(root)).toEqual(["entry.get.payments-id"]);
      expect(factIds(root, join(root, "catalog", "sources", "facts", `${REPO}.jsonl`))).toEqual(
        expect.arrayContaining(["entry.get.payments-id", "entry.post.payments"]),
      );
      // Kept again by the next write while its file is unchanged, and said in --json.
      const j = io();
      expect(await verifyCommand(root, REPO, { ...opts(root, REPO), json: true }, j.io)).toBe(0);
      expect(json(j).kept).toEqual({ facts: ["entry.post.payments"], edits: 0 });
      expect(json(j).accepted).toBe(1);
      expect(endpoints(root)).toEqual(before);
    },
    T,
  );

  it(
    "keeps a hand edit of the catalog as the person's and writes, where it used to refuse",
    async () => {
      const root = await written();
      const file = join(root, "catalog", "generated", "component", "payments-api.yaml");
      const text = readFileSync(file, "utf8");
      writeFileSync(
        file,
        /^runtime: /m.test(text)
          ? text.replace(/^runtime: .*$/m, "runtime: openshift")
          : `${text.trimEnd()}\nruntime: openshift\n`,
      );
      const q = io();
      const code = await verifyCommand(root, REPO, opts(root, REPO), q.io);
      const said = [...q.out, ...q.err].join("\n");
      expect(code, said).toBe(0);
      expect(said).toMatch(
        /Kept 1 hand edit of the catalog as yours \(curated, as atticus catalog edits --curate does\)/,
      );
      expect(said).not.toMatch(/nothing is overwritten/);
      expect(readFileSync(file, "utf8")).toMatch(/^runtime: openshift$/m);
      expect(existsSync(join(root, "catalog", "curated"))).toBe(true);
    },
    T,
  );

  it(
    "drops a kept fact whose file changed (no rejection), and writes the removal with its reason",
    async () => {
      const root = await written();
      leaveOutPost(root);
      const file = join(root, "workspace", REPO, ...CONTROLLER.split("/"));
      writeFileSync(file, readFileSync(file, "utf8").replace("@PostMapping", "@PutMapping"));
      const q = io();
      const code = await verifyCommand(root, REPO, { ...opts(root, REPO), json: true }, q.io);
      const said = [...q.out, ...q.err].join("\n");
      expect(code, said).toBe(0);
      const r = json(q);
      expect(r.rejected).toBe(0);
      expect(r.kept).toBeUndefined();
      expect(existsSync(join(root, "facts", `${REPO}.rejected.jsonl`))).toBe(false);
      expect(endpoints(root).length).toBe(1);
      // The removals are written and listed, each with what explains it.
      expect(r.removed?.length ?? 0).toBeGreaterThan(0);
      for (const x of r.removed as { explainedBy: string[] }[])
        expect(x.explainedBy.length).toBeGreaterThan(0);
      // Said in words too, once, without --json.
      const again = await written();
      leaveOutPost(again);
      const f2 = join(again, "workspace", REPO, ...CONTROLLER.split("/"));
      writeFileSync(f2, readFileSync(f2, "utf8").replace("@PostMapping", "@PutMapping"));
      const w = io();
      expect(await verifyCommand(again, REPO, opts(again, REPO), w.io)).toBe(0);
      const words = [...w.out, ...w.err].join("\n");
      expect(words.match(/^Removed \d+ records? the new read no longer has/gm)?.length).toBe(1);
      expect(words).toMatch(/^ {2}\S+\/\S+: .+$/m);
    },
    T,
  );

  it(
    "says the hand edits kept in --json, and exits 0",
    async () => {
      const root = await written();
      handEdit(root);
      const q = io();
      const code = await verifyCommand(root, REPO, { ...opts(root, REPO), json: true }, q.io);
      expect(code, q.err.join("\n")).toBe(0);
      expect(json(q).kept).toEqual({ facts: [], edits: 1 });
      expect(json(q).refused).toBeUndefined();
    },
    T,
  );

  it(
    "still refuses a removal nothing explains, and a build.json that doesn't read (exit 1)",
    async () => {
      const root = await written();
      // A record the last build wrote whose sources are unchanged: nothing explains its going.
      const gen = join(root, "catalog", "generated");
      const mPath = join(root, "catalog", "sources", "build.json");
      const m = parseBuildManifest(readFileSync(mPath, "utf8"));
      if (!m.ok) throw new Error("build.json doesn't read");
      const like = m.slot.files.find((f) => f.path.endsWith("component/payments-api.yaml"))!;
      const text = readFileSync(join(gen, "component", "payments-api.yaml"), "utf8").replaceAll(
        "payments-api",
        "payments-ghost",
      );
      writeFileSync(join(gen, "component", "payments-ghost.yaml"), text);
      writeFileSync(
        mPath,
        serializeBuildManifest({
          ...m.slot,
          files: [
            ...m.slot.files,
            {
              ...like,
              path: like.path.replace("payments-api.yaml", "payments-ghost.yaml"),
              sha256: createHash("sha256").update(text).digest("hex"),
            },
          ].sort((a, b) => (a.path < b.path ? -1 : 1)),
        }),
      );
      const q = io();
      expect(await verifyCommand(root, REPO, { ...opts(root, REPO), json: true }, q.io)).toBe(1);
      expect(json(q).refused?.reasons).toContain("unexplained-removals");
      expect(existsSync(join(gen, "component", "payments-ghost.yaml"))).toBe(true);

      const bad = await written();
      writeFileSync(join(bad, "catalog", "sources", "build.json"), "{ not json");
      // In another clone (undo copies aren't committed), so no copy catches the build up.
      rmSync(await undoDirOf(bad), { recursive: true, force: true });
      const b = io();
      expect(await verifyCommand(bad, REPO, { ...opts(bad, REPO), json: true }, b.io)).toBe(1);
      expect(json(b).refused?.reasons).toContain("hand-edits");
      expect(json(b).refused?.unreadableManifest).toBe(true);
      expect(existsSync(join(bad, "catalog", "curated"))).toBe(false);
    },
    T,
  );

  it(
    "the app's Apply goes past a hand edit too (POST /api/facts/<repo>/apply)",
    async () => {
      const root = await written();
      const file = handEdit(root);
      const s = await startServer({
        root,
        port: 0,
        user: "pat",
        version: "1.0.0",
        extend: (r, ctx) => extendUiRoutes(r, ctx),
      });
      servers.push(s);
      const call = async (path: string, method = "GET", body?: unknown) => {
        const r = await fetch(s.url + path, {
          method,
          headers: {
            "X-Atticus-Token": s.token,
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        const t = await r.text();
        return { status: r.status, body: (t ? JSON.parse(t) : {}) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any -- a route's JSON, read loosely
      };
      const started = await call(`/api/facts/${REPO}/apply`, "POST", {});
      expect(started.status, JSON.stringify(started.body)).toBe(202);
      let ended: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any -- a job, read loosely
      for (let n = 0; n < 1200; n++) {
        ended = (await call(`/api/jobs/${String(started.body.jobId)}`)).body;
        if (ended.state !== "running" && ended.state !== "queued") break;
        await new Promise((r) => setTimeout(r, 50));
      }
      const lines = (ended.result?.lines ?? []).join("\n");
      expect(ended.result?.code, lines).toBe(0);
      expect(ended.result?.refused).toBeUndefined();
      expect(lines).toMatch(/Kept 1 hand edit of the catalog as yours/);
      expect(readFileSync(file, "utf8")).toMatch(/^runtime: openshift$/m);
    },
    T,
  );
});

describe("the map's Apply goes past as verify --write does (ADR 0210 part 3)", () => {
  it(
    "builds over a hand edit, keeping it as the person's; catalog build itself still refuses",
    async () => {
      const root = await written();
      const file = handEdit(root);
      const c = io();
      expect(await catalogBuild(root, {}, c.io)).toBe(1);
      const q = io();
      const r = await applyMapEdits(root, { edits: [], by: "pat", now: AT }, q.io);
      const said = [...q.out, ...q.err].join("\n");
      expect(r.code, said).toBe(0);
      expect(r.built).toBe(true);
      expect(said).toMatch(/^Kept 1 hand edit of the catalog as yours/m);
      expect(readFileSync(file, "utf8")).toMatch(/^runtime: openshift$/m);
      expect(await catalogBuild(root, {}, io().io)).toBe(0);
    },
    T,
  );
});

describe("verify --all --write goes past as one build (ADR 0210 part 3)", () => {
  it(
    "a hand edit keeps it one build and one undo step",
    async () => {
      const root = await written();
      const file = handEdit(root);
      const copies = (await listUndo(await undoDirOf(root))).length;
      const q = io();
      const code = await verifyAllCommand(root, { write: true, now: () => AT }, q.io);
      const said = [...q.out, ...q.err].join("\n");
      expect(code, said).toBe(0);
      expect(said).toMatch(/Writing the catalog once for 4 repos/);
      expect(said.match(/^Kept 1 hand edit of the catalog as yours/gm)?.length).toBe(1);
      expect((await listUndo(await undoDirOf(root))).length).toBe(copies + 1);
      expect(readFileSync(file, "utf8")).toMatch(/^runtime: openshift$/m);
    },
    T,
  );
});

describe("writeGoingOn's rounds (ADR 0210 part 3)", () => {
  const refusal = (r: Partial<BuildRefusal>) =>
    ({ guard: { refused: { reasons: [], message: "refused", ...r } } }) as unknown as BuildAndWrite;
  const removals = refusal({
    reasons: ["large-removals"],
    allowRemovals: 2,
    removals: [
      {
        kind: "Endpoint",
        id: "payments-api.post",
        explainedBy: ["no fact of forge-payments's read makes it"],
        reasons: ["slot"],
      },
      {
        kind: "Endpoint",
        id: "payments-api.put",
        explainedBy: ["no fact of forge-payments's read makes it"],
        reasons: ["slot"],
      },
    ] as BuildRefusal["removals"],
  });

  it("stops when a round refuses the same as the last, and says no removal it didn't write", async () => {
    const root = metarepo();
    let rounds = 0;
    const q = io();
    const r = await writeGoingOn<string>(
      root,
      async (o) => {
        rounds++;
        o.onRefused(removals);
        return undefined;
      },
      undefined,
      q.io,
    );
    expect(r).toBeUndefined();
    expect(rounds).toBe(2);
    expect([...q.out, ...q.err].join("\n")).not.toMatch(/Removed/);
  });

  it("says the latest round's removals once, when that round wrote", async () => {
    const root = metarepo();
    let rounds = 0;
    const q = io();
    const told: WentPast[] = [];
    const r = await writeGoingOn<string>(
      root,
      async (o) => {
        rounds++;
        if (o.allowRemovals === undefined) {
          o.onRefused(
            refusal({
              ...removals.guard.refused!,
              allowRemovals: 1,
              removals: removals.guard.refused!.removals!.slice(0, 1),
            }),
          );
          return undefined;
        }
        if (o.allowRemovals === 1) {
          o.onRefused(removals);
          return undefined;
        }
        return "wrote";
      },
      undefined,
      q.io,
      { onWentPast: (w) => told.push(w) },
    );
    expect(r).toBe("wrote");
    expect(rounds).toBe(3);
    const said = q.out.join("\n");
    expect(said.match(/^Removed/gm)).toEqual(["Removed"]);
    expect(said).toMatch(/^Removed 2 records/m);
    expect(told).toEqual([{ removed: removals.guard.refused!.removals }]);
  });

  it("keeps a refusal said before the write in the command's scope, and forgets the one it went past", async () => {
    const root = metarepo();
    const earlier = { reasons: ["unexplained-removals"], message: "repo A refused" };
    const q = io();
    const seen = await refusalScope(q.io, async () => {
      await refusalEnds(root, earlier);
      let n = 0;
      await writeGoingOn(
        root,
        async (o) => {
          if (n++ === 0) {
            await refusalEnds(root, removals.guard.refused);
            o.onRefused(removals);
            return undefined;
          }
          return true;
        },
        undefined,
        q.io,
      );
      return refusedBuild();
    });
    expect(seen).toBe(earlier);
  });
});
