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
        const glance = (await get(`/api/changes/${ID}/cockpit`)).nextStep as string;
        const status = await get(`/api/changes/${ID}/status`);
        expect(glance).toMatch(/^Not ready to raise "Plan ready" yet/);
        expect(status.nextStep).toBe(glance);
        expect(status.stepFirst).toBe(true);
      } finally {
        await s.close();
      }
    },
    T,
  );
});
