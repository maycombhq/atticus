import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { GENERATED_MARK } from "@maycombhq/changes";
import { startServer, type RunningServer } from "@maycombhq/server";
import { cockpit } from "../src/cockpit.js";
import { acrossRows } from "../src/ui-api-across.js";
import { stageThreadView } from "../src/ui-api-thread.js";
import { uiRoutes } from "../src/ui-api.js";
import { uiRunRoutes } from "../src/ui-api-run.js";
import { uiCockpitRoutes } from "../src/ui-api-cockpit.js";
import { scopeDirs } from "../src/propose.js";

/**
 * Beta.27 review. (1, blocker) Forge's add-transfer-limit is in plan, off the stage path, with
 * stories.md and tasks.md a person wrote: At a glance offered the stories stage, which refused
 * them (422), while "Where it is" said "Stories: to come" and the Stories page "hasn't started".
 * (4) All changes, the brief's Gate, Across and Release printed change status's sentence while
 * At a glance said its own. One change, every page.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const CHANGE = join(HERE, "../../../fixtures/forge-change/openspec/changes/add-transfer-limit");
const ID = "add-transfer-limit";
const T = 120_000;

async function forgeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-b27-person-"));
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  for (const r of parse(readFileSync(join(FORGE, "expected/scan.yaml"), "utf8")) as Record<
    string,
    unknown
  >[]) {
    const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
    if (!p.ok) throw new Error(String(r.id));
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(CHANGE, join(root, "openspec/changes", ID), { recursive: true });
  return root;
}

let root: string;
let srv: RunningServer;

async function call(path: string) {
  const r = await fetch(srv.url + path, { headers: { "X-Atticus-Token": srv.token } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: r.status, body: (await r.json()) as any };
}

beforeAll(async () => {
  root = await forgeRoot();
  srv = await startServer({
    root,
    port: 0,
    user: "bao",
    watch: false,
    extend: (r, ctx) => uiCockpitRoutes(uiRunRoutes(uiRoutes(r, ctx), ctx), ctx),
  });
}, T);
afterAll(() => srv?.close());

describe("stories a person wrote (beta.27 review, blocker)", () => {
  it(
    "At a glance goes on from them: Plan ready next, never the stage that refuses them",
    async () => {
      const c = await cockpit(root, ID);
      expect(c.stages.map((s) => [s.stage, s.state])).toEqual([
        ["feature", "skipped"],
        ["architecture", "skipped"],
        ["stories", "person"],
      ]);
      expect(c.stages[2]!.files).toEqual(["stories.md", "tasks.md"]);
      expect(c.next?.step).not.toBe("stories");
      expect(c.next?.step).toBe("handoff");
      expect(c.next?.why).toMatch(
        /^add-transfer-limit's stories\.md and tasks\.md are written by a person \(the stories stage never ran\)/,
      );
      expect(c.nextStep).not.toMatch(/^Not ready/);
      // The plan's own role takes over once the stories are written.
      expect(c.waitsOn?.role).toBe("team-lead");
    },
    T,
  );

  it(
    "the Stories page says a person wrote them, with drafting again as the way to replace them",
    async () => {
      const v = await stageThreadView(root, ID, "stories");
      expect(v.state).toBe("done");
      expect(v.byPerson).toEqual(["stories.md", "tasks.md"]);
      expect(v.headline).toMatch(/^A person wrote stories\.md and tasks\.md outside the app/);
      expect(v.step).toEqual(["plan", "stories", ID]);
      expect(v.reply.why).toMatch(/no assistant waits for a reply/);
    },
    T,
  );

  it(
    "planning files Atticus wrote are the stage's: the stage is next, and its page says it hasn't started",
    async () => {
      const other = await forgeRoot();
      const dir = join(other, "openspec/changes", ID);
      for (const f of ["stories.md", "tasks.md"])
        await writeFile(
          join(dir, f),
          `${GENERATED_MARK} stories. -->\n${await readFile(join(dir, f), "utf8")}`,
        );
      const c = await cockpit(other, ID);
      expect(c.stages[2]!.state).toBe("not-started");
      expect(c.next?.step).toBe("stories");
      const v = await stageThreadView(other, ID, "stories");
      expect(v.state).toBe("not-started");
      expect(v.byPerson).toBeUndefined();
    },
    T,
  );
});

describe("one next step on every page (beta.27 review)", () => {
  it(
    "All changes, the brief's Gate, Across and Release say At a glance's sentence",
    async () => {
      const glance = (await call(`/api/changes/${ID}/cockpit`)).body.nextStep as string;
      expect(glance).toBeTruthy();
      const status = await call(`/api/changes/${ID}/status`);
      expect(status.status).toBe(200);
      expect(status.body.nextStep).toBe(glance);
      const release = await call(`/api/release/${ID}`);
      expect(release.body.status.nextStep).toBe(glance);
      const rows = await acrossRows(root, "releases");
      expect(rows.find((r) => r.change === ID)?.nextStep).toBe(glance);
    },
    T,
  );

  it(
    "while another step comes first, every page says so and the hand-off is held",
    async () => {
      const other = await forgeRoot();
      const dir = join(other, "openspec/changes", ID);
      for (const f of ["stories.md", "tasks.md"])
        await writeFile(
          join(dir, f),
          `${GENERATED_MARK} stories. -->\n${await readFile(join(dir, f), "utf8")}`,
        );
      const s = await startServer({
        root: other,
        port: 0,
        user: "bao",
        watch: false,
        extend: (r, ctx) => uiCockpitRoutes(uiRoutes(r, ctx), ctx),
      });
      try {
        const get = async (p: string) =>
          (await (await fetch(s.url + p, { headers: { "X-Atticus-Token": s.token } })).json()) as {
            nextStep: string;
            stepFirst?: boolean;
          };
        const cockpit = (await get(`/api/changes/${ID}/cockpit`)) as unknown as {
          nextStep: string;
          next?: { why: string };
        };
        const glance = cockpit.nextStep;
        const status = await get(`/api/changes/${ID}/status`);
        // At a glance shows the step under its sentence; every other page says the step itself.
        expect(glance).toBe('Not ready to raise "Plan ready" yet: the step below comes first.');
        const why = cockpit.next!.why;
        const first = `Not ready to raise "Plan ready" yet: first, ${why[0]!.toLowerCase()}${why.slice(1)}`;
        expect(status.nextStep).toBe(first);
        expect(status.stepFirst).toBe(true);
        // Review of the fix: change status says the same, and its --json says stepFirst.
        const { changeStatus } = await import("../src/change-commands.js");
        const out: string[] = [];
        const say = { out: (l: string) => out.push(l), err: () => undefined };
        expect(await changeStatus(other, ID, {}, say)).toBe(0);
        expect(out).toContain(`Next: ${first}`);
        out.length = 0;
        expect(await changeStatus(other, ID, { json: true }, say)).toBe(0);
        expect(JSON.parse(out.join("\n"))).toMatchObject({ nextStep: first, stepFirst: true });
      } finally {
        await s.close();
      }
    },
    T,
  );
});

describe("a change whose change.yaml doesn't read (beta.27 review)", () => {
  it(
    "is listed with its file, line and why, and its pages and a near id say so",
    async () => {
      const other = await forgeRoot();
      const file = join(other, "openspec/changes", ID, "change.yaml");
      const text = await readFile(file, "utf8");
      await writeFile(file, text.replace("title:", "<<<<<<< HEAD\ntitle:"));
      const { changeProblems, missingChangeWords, nearIds } =
        await import("../src/change-problems.js");
      const problems = await changeProblems(other);
      expect(problems).toEqual([
        {
          id: ID,
          file: `openspec/changes/${ID}/change.yaml`,
          line: 3,
          message: expect.stringMatching(/^invalid YAML: .* at line 3, column 1$/),
        },
      ]);
      expect(await missingChangeWords(other, ID)).toMatch(
        new RegExp(
          `^${ID}'s change\\.yaml doesn't read \\(openspec/changes/${ID}/change\\.yaml, line 3\\): invalid YAML: .*\\. Fix the file and the change comes back\\.$`,
        ),
      );
      expect(await missingChangeWords(root, "add-transfer-limt")).toBe(
        `There is no change add-transfer-limt. Did you mean ${ID}?`,
      );
      expect(await missingChangeWords(root, "nothing-like-it")).toBe(
        "There is no change nothing-like-it.",
      );
      expect(nearIds("ledger", ["ledger-v2", "portal"])).toEqual(["ledger-v2"]);
      const s = await startServer({
        root: other,
        port: 0,
        user: "bao",
        watch: false,
        extend: (r, ctx) => uiCockpitRoutes(uiRoutes(r, ctx), ctx),
      });
      try {
        const get = async (p: string) =>
          fetch(s.url + p, { headers: { "X-Atticus-Token": s.token } });
        expect(await (await get("/api/change-problems")).json()).toEqual(problems);
        const glance = await get(`/api/changes/${ID}/cockpit`);
        expect(glance.status).toBe(404);
        expect(((await glance.json()) as { detail: string }).detail).toMatch(/doesn't read/);
      } finally {
        await s.close();
      }
    },
    T,
  );
});

describe("the upgrade panel's Propose (beta.27 review)", () => {
  // Review of the fix: the paths the upgrade run changed and its stamp, never the app's other
  // work (upgrade.test.ts runs one and compares with Git).
  it("proposes what an upgrade changed and its stamp, not the app's other work", () => {
    const dirs = scopeDirs(root, "upgrade");
    expect(dirs).toContain(":(literal).atticus/metarepo.yaml");
    expect(dirs).not.toContain("org-pack");
    expect(dirs.some((d) => scopeDirs(root, "work").includes(d))).toBe(false);
  });
});
