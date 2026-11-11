import { appendFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { changesDirOf } from "@maycombhq/core";
import type { RunningServer } from "@maycombhq/server";
import type { DoctorCheck } from "../src/doctor.js";
import { startUi } from "../src/ui-commands.js";
import { whyWorkedOut } from "../src/watched-memo.js";
import { HOME_REQUESTS, homeChangeRequests, homeReloads, makeHomeEstate } from "./home-estate.js";

/**
 * beta.23, "Home loads fast". Home at the size the owner runs it: 40 repos, about 2,500 catalog
 * records, 12,000 facts, 200 open questions, 4 changes in flight and 100 answers proposed for
 * review and not merged yet (home-estate.ts). Home sends about twenty requests at once; a browser
 * (and VS Code's and IntelliJ's panels) asks a server six at a time, so they are sent that way
 * here. The machine's checks take 5 s here, as starting Git, the OpenSpec CLI and the Copilot
 * language server does on a Windows laptop: Home never waits for them.
 *
 * The budgets are about twice what this build machine measured alone (2 CPUs, shared: cold 5 to
 * 7 s, warm 0.3 to 0.5 s, after a change 1.0 to 1.5 s; after a change 2.5 s with every package's
 * tests at once), so CI passes; before beta.23 the first load took 25 s here, a load with nothing
 * changed 4 s, and a load after one file changed 3 to 6 s (and with the bundled embedding model
 * 55 s and 27 s).
 */
const COLD_MS = 15_000;
const WARM_MS = 1_000;
const AFTER_CHANGE_MS = 3_000;
const DOCTOR_MS = 5_000;

let dir: string;
let root: string;
let srv: RunningServer;
let doctorDone = false;

const doctor = async (): Promise<DoctorCheck[]> => {
  await new Promise((r) => setTimeout(r, DOCTOR_MS));
  doctorDone = true;
  return [{ id: "node", label: "Node.js", status: "ok", detail: "Node 22" }];
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "atticus-home-speed-"));
  root = await makeHomeEstate(dir);
  // As `atticus ui` starts it: the machine's checks start with the server.
  changes = (await readdir(changesDirOf(root), { withFileTypes: true }))
    .filter((d) => d.isDirectory() && d.name !== "archive")
    .map((d) => d.name)
    .sort();
  srv = await startUi(root, { port: 0, user: "pat", warm: true }, { doctor });
}, 300_000);
afterAll(async () => {
  await srv?.close();
  await rm(dir, { recursive: true, force: true });
});

let changes: string[] = [];
let between: (() => void) | undefined;
const heardSince: string[] = [];

/** Home's requests, six at a time as a browser sends them; each one's time, and the whole. */
const home = async (paths?: string[]) => {
  const t0 = performance.now();
  const todo = [...(paths ?? [...HOME_REQUESTS, ...homeChangeRequests(changes)])];
  const out: { path: string; ms: number; status: number; body: unknown }[] = [];
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (let p = todo.shift(); p; p = todo.shift()) {
        const t = performance.now();
        const r = await fetch(srv.url + p, { headers: { "X-Atticus-Token": srv.token } });
        const body = (await r.json()) as unknown;
        out.push({ path: p, ms: performance.now() - t, status: r.status, body });
      }
    }),
  );
  return { ms: performance.now() - t0, out };
};

const say = (label: string, r: Awaited<ReturnType<typeof home>>) =>
  console.log(
    `home-speed ${label}: ${r.ms.toFixed(0)} ms; slowest ${[...r.out]
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 4)
      .map((x) => `${x.path} ${x.ms.toFixed(0)}`)
      .join(", ")}`,
  );

/** The server heard a change under `path` (its watcher's live event). */
const heard = (path: string) =>
  new Promise<void>((resolve) => {
    const stop = srv.events.listen((e) => {
      if (e.type === "file.changed" && typeof e.path === "string" && e.path.startsWith(path)) {
        stop();
        resolve();
      }
    });
  });

describe("Home on a 40-repo estate (beta.23)", () => {
  it("loads first, cold, inside the budget, and never waits for the machine's checks", async () => {
    const first = await home();
    say("cold", first);
    // Everything heard from here until the warm load (a change heard then also throws away the
    // answers kept), said by the warm load.
    between = srv.events.listen((e) =>
      heardSince.push(e.type === "file.changed" ? `file.changed ${String(e.path)}` : e.type),
    );
    for (const x of first.out) expect(x.status, `${x.path}: ${JSON.stringify(x.body)}`).toBe(200);
    expect(first.ms).toBeLessThan(COLD_MS);
    const setup = first.out.find((x) => x.path === "/api/setup")!;
    expect(setup.ms).toBeLessThan(DOCTOR_MS);
    const machine = (setup.body as { steps: { id: string; checking?: boolean }[] }).steps[0]!;
    expect(machine.id).toBe("machine");
    if (!doctorDone) expect(machine.checking).toBe(true);
  }, 120_000);

  it("loads again, with nothing changed, inside a second", async () => {
    // Nothing changes here, so the server hears no file change; one it hears (a file only read,
    // on Windows) would throw away every answer kept. Said, so a slow run says why.
    const changes: string[] = [];
    const stop = srv.events.listen((e) => {
      if (e.type === "file.changed") changes.push(String(e.path));
      else console.log(`home-speed warm: heard ${e.type}`);
    });
    between?.();
    console.log(
      `home-speed between cold and warm: heard ${heardSince.length}: ${heardSince.slice(0, 8).join(", ")}`,
    );
    // beta.24, Windows CI: the first load can finish before the watcher follows the metarepo
    // (its first walk of thousands of files takes longer there), and nothing is kept while no
    // watcher follows. The load after it does is the one kept, so it is the one measured against.
    const cold = whyWorkedOut();
    if (cold.some((w) => w.endsWith("the server follows no folder"))) {
      const t = Date.now();
      while (srv.following.length === 0 && Date.now() - t < 30_000)
        await new Promise((r) => setTimeout(r, 100));
      console.log(`home-speed warm: the watcher followed after ${Date.now() - t} ms more`);
      await home();
      whyWorkedOut();
    }
    const again = await home();
    stop();
    say("warm", again);
    console.log(`home-speed warm: worked out again: ${whyWorkedOut().join("; ") || "none"}`);
    console.log(
      `home-speed warm: ${changes.length} file changes heard ${changes.slice(0, 5).join(", ")}`,
    );
    expect(changes, "a file only read was heard as changed").toEqual([]);
    for (const x of again.out) expect(x.status).toBe(200);
    expect(again.ms).toBeLessThan(WARM_MS);
  }, 60_000);

  it("loads inside the budget after a question file changed", async () => {
    const q = (await readdir(join(root, "questions"))).filter((n) => n.endsWith(".yaml"))[7]!;
    const told = heard("questions");
    await appendFile(join(root, "questions", q), "# read again\n");
    await told;
    const after = await home(homeReloads(changes, false));
    say("after a question changed", after);
    for (const x of after.out) expect(x.status).toBe(200);
    expect(after.ms).toBeLessThan(AFTER_CHANGE_MS);
  }, 60_000);

  it("loads inside the budget after a catalog record changed", async () => {
    const kind = join(root, "catalog/generated/endpoint");
    const f = (await readdir(kind)).sort()[3]!;
    const told = heard("catalog");

    await appendFile(join(kind, f), "# checked by hand\n");
    await told;
    const after = await home(homeReloads(changes, true));
    say("after a record changed", after);
    for (const x of after.out) expect(x.status).toBe(200);
    expect(after.ms).toBeLessThan(AFTER_CHANGE_MS);
  }, 60_000);

  it("gives the machine's step once its checks finish", async () => {
    await new Promise((r) => setTimeout(r, Math.max(0, DOCTOR_MS + 200)));
    const r = await fetch(srv.url + "/api/setup", { headers: { "X-Atticus-Token": srv.token } });
    const s = (await r.json()) as { steps: { id: string; done: boolean; checking?: boolean }[] };
    expect(s.steps[0]).toMatchObject({ id: "machine", done: true });
    expect(s.steps[0]!.checking).toBeUndefined();
  }, 30_000);
});
