import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { Api } from "@maycombhq/core";
import { recordAiDraft } from "@maycombhq/planner";
import { startServer, type RunningServer } from "@maycombhq/server";
import { uiRoutes } from "../src/ui-api.js";
import { uiStageRoutes } from "../src/ui-api-stages.js";

/**
 * ADR 0181 (stage drafts, C4 2.79.0): a page's stage drafts with who wrote each last and the
 * items a person can correct (GET /api/changes/{id}/drafts/{page}); a person's corrections,
 * listed, added and taken back (…/corrections); a save of a draft in the app says who saved it.
 * On the Forge metarepo's add-transfer-limit change.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "../../../fixtures");
const CHANGE = "add-transfer-limit";
const REL = `openspec/changes/${CHANGE}`;
const NOW = new Date("2026-11-08T10:00:00Z");
const PERSON = "Priya Nair <priya@forge.example>";
const FLOW = "target-flows/forge-ledger.post-transfer.yaml";

const DELTA = `schemaVersion: 2
flow: forge-ledger.post-transfer
repo: forge-ledger
change: modify
why: A transfer over the customer's daily limit is refused.
steps:
  - op: add
    after: 1
    kind: lookup
    what: The ledger reads the customer's daily limit
    store: { table: transfer_limits, columns: [daily_limit] }
  - op: add
    after: 2
    kind: call-out
    what: Northwind Pay is told of the refusal
    to: { component: northwind-pay, entry: POST /v1/refusals, new: true }
`;

let srv: RunningServer;
let root: string;
let dir: string;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(srv.url + path, {
    method,
    headers: { "X-Atticus-Token": srv.token, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

const loop = (stage: string, written: Record<string, string>) =>
  stringify({
    schemaVersion: 1,
    change: CHANGE,
    stage,
    iteration: 1,
    state: "done",
    updatedAt: NOW.toISOString(),
    written,
  });

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-ui-drafts-"));
  await cp(join(FIXTURES, "forge/metarepo"), root, { recursive: true });
  await cp(join(FIXTURES, "forge-change/openspec"), join(root, "openspec"), { recursive: true });
  dir = join(root, REL);
  await mkdir(join(dir, "target-flows"), { recursive: true });
  await mkdir(join(dir, "stage"), { recursive: true });
  await writeFile(join(dir, FLOW), DELTA);
  const design = await readFile(join(dir, "design.md"), "utf8");
  const story = await readFile(join(dir, "stories/s1-refuse-over-limit.md"), "utf8");
  // The architecture stage ran: its loop file has the hashes of what it wrote (design.md from
  // before drafted.yaml was kept), and drafted.yaml has the target flow with its run.
  await writeFile(
    join(dir, "stage/architecture.yaml"),
    loop("architecture", { "design.md": sha(design), [FLOW]: sha(DELTA) }),
  );
  await recordAiDraft(dir, CHANGE, {
    stage: "architecture",
    run: "run-arch-0001",
    iteration: 1,
    at: "2026-11-08T09:00:00Z",
    files: [FLOW],
  });
  // The stories stage wrote a story that a person has since edited outside the app.
  await writeFile(
    join(dir, "stage/stories.yaml"),
    loop("stories", { "stories/s1-refuse-over-limit.md": sha(story), "tasks.md": "0".repeat(64) }),
  );
  await writeFile(join(dir, "stories/s1-refuse-over-limit.md"), `${story}\nEdited by hand.\n`);
  // The feature stage drafted proposal.md here, but its loop file isn't in this checkout.
  await recordAiDraft(dir, CHANGE, {
    stage: "feature",
    run: "run-feat-0001",
    iteration: 1,
    at: "2026-11-08T08:00:00Z",
    files: ["proposal.md"],
  });
  srv = await startServer({
    root,
    port: 0,
    user: PERSON,
    extend: (r, ctx) =>
      uiStageRoutes(uiRoutes(r, ctx, { now: NOW.toISOString() }), ctx, { now: () => NOW }),
  });
});
afterAll(() => srv?.close());

describe("a page's stage drafts", () => {
  it("lists each draft with who wrote it last and the items a person can correct", async () => {
    const r = await call("GET", `/api/changes/${CHANGE}/drafts/architecture`);
    expect(r.status).toBe(200);
    const v = Api.StageDraftsView.parse(r.body);
    expect(v).toMatchObject({
      change: CHANGE,
      page: "architecture",
      corrections: [],
      next: {
        stage: "architecture",
        command: `atticus change architecture ${CHANGE}`,
        slash: `/atticus-architecture ${CHANGE}`,
      },
      problems: [],
    });
    // data.md is in the change folder, but no stage wrote it: not a draft.
    expect(v.files.map((f) => f.file)).toEqual(["design.md", FLOW]);
    const [design, flow] = v.files;
    expect(design!.drafted).toEqual({ by: "ai", stage: "architecture" });
    expect(design!.items.length).toBeGreaterThan(0);
    expect(flow).toEqual({
      file: FLOW,
      path: `${REL}/${FLOW}`,
      stage: "architecture",
      drafted: {
        by: "ai",
        stage: "architecture",
        run: "run-arch-0001",
        at: "2026-11-08T09:00:00Z",
      },
      items: [
        {
          id: "step-1",
          label: "Step 1 (add lookup): The ledger reads the customer's daily limit",
          like: ["transfer_limits"],
        },
        {
          id: "step-2",
          label: "Step 2 (add call-out): Northwind Pay is told of the refusal",
          like: ["northwind-pay", "POST /v1/refusals"],
        },
      ],
    });
    const stories = Api.StageDraftsView.parse(
      (await call("GET", `/api/changes/${CHANGE}/drafts/stories`)).body,
    );
    expect(stories.files.map((f) => [f.file, f.drafted])).toEqual([
      ["stories/s1-refuse-over-limit.md", { by: "person" }],
    ]);
    // tasks.md is the Tasks page's: written by the stories stage, and since changed.
    const tasks = Api.StageDraftsView.parse(
      (await call("GET", `/api/changes/${CHANGE}/drafts/tasks`)).body,
    );
    expect(tasks.files.map((f) => [f.file, f.stage, f.drafted?.by])).toEqual([
      ["tasks.md", "stories", "person"],
    ]);
    expect(tasks.next.command).toBe(`atticus plan stories ${CHANGE}`);
    expect((await call("GET", `/api/changes/${CHANGE}/drafts/release`)).status).toBe(400);
    expect((await call("GET", `/api/changes/no-such-change/drafts/feature`)).status).toBe(404);
  });

  it("says who saved a draft in the app, once a person saves it", async () => {
    const before = Api.StageDraftsView.parse(
      (await call("GET", `/api/changes/${CHANGE}/drafts/feature`)).body,
    );
    expect(before.files.map((f) => [f.file, f.drafted])).toEqual([
      [
        "proposal.md",
        { by: "ai", stage: "feature", run: "run-feat-0001", at: "2026-11-08T08:00:00Z" },
      ],
    ]);
    const got = await call("GET", `/api/changes/${CHANGE}/artifacts/proposal`);
    const put = await call("PUT", `/api/changes/${CHANGE}/artifacts/proposal`, {
      content: `${String(got.body.content)}\nOne more line.\n`,
      baseSha256: got.body.sha256,
    });
    expect(put.status).toBe(200);
    const after = Api.StageDraftsView.parse(
      (await call("GET", `/api/changes/${CHANGE}/drafts/feature`)).body,
    );
    expect(after.files[0]!.drafted).toEqual({
      by: "person",
      who: PERSON,
      at: NOW.toISOString(),
    });
  });
});

describe("a person's corrections", () => {
  it("adds a correction of an item, for similar items by default, waiting for the stage's next run", async () => {
    const r = await call("POST", `/api/changes/${CHANGE}/corrections`, {
      file: FLOW,
      item: "step-2",
      text: "Northwind Pay isn't told of refusals; the ledger only logs them.",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const res = Api.CorrectionResult.parse(r.body);
    expect(res.correction).toMatchObject({
      stage: "architecture",
      file: FLOW,
      item: "step-2",
      label: "Step 2 (add call-out): Northwind Pay is told of the refusal",
      text: "Northwind Pay isn't told of refusals; the ledger only logs them.",
      scope: "similar",
      // What similar items share: the step's component, unless the person said otherwise.
      like: "northwind-pay",
      by: PERSON,
      at: NOW.toISOString(),
      state: "waiting",
    });
    expect(res.files).toEqual([`${REL}/stage/corrections.yaml`]);
    expect(res.commit).toContain(`git add ${REL}/stage/corrections.yaml`);
    expect(res.next.command).toBe(`atticus change architecture ${CHANGE}`);
    const file = parse(await readFile(join(dir, "stage/corrections.yaml"), "utf8"));
    expect(file.corrections).toHaveLength(1);
    const v = Api.StageDraftsView.parse(
      (await call("GET", `/api/changes/${CHANGE}/drafts/architecture`)).body,
    );
    expect(v.corrections.map((c) => [c.id, c.state])).toEqual([[res.correction.id, "waiting"]]);
    const list = Api.CorrectionList.parse(
      (await call("GET", `/api/changes/${CHANGE}/corrections`)).body,
    );
    expect(list.corrections).toHaveLength(1);
    // One item only, with what it is like said by the person.
    const one = Api.CorrectionResult.parse(
      (
        await call("POST", `/api/changes/${CHANGE}/corrections`, {
          file: "design.md",
          text: "Keep the design to the ledger.",
          similar: false,
        })
      ).body,
    );
    expect(one.correction).toMatchObject({ scope: "one", label: "design.md" });
    expect(one.correction.item).toBeUndefined();
    expect(one.correction.like).toBeUndefined();
  });

  it("refuses an item the draft hasn't got, a file that isn't a draft, an empty text, and a stage that hasn't run", async () => {
    const post = (b: unknown) => call("POST", `/api/changes/${CHANGE}/corrections`, b);
    expect((await post({ file: FLOW, item: "step-9", text: "x" })).status).toBe(404);
    expect((await post({ file: "data.md", text: "x" })).status).toBe(404);
    expect((await post({ file: "../brief.md", text: "x" })).status).toBe(404);
    expect((await post({ file: FLOW, text: "   " })).status).toBe(400);
    const notRun = await post({ file: "proposal.md", text: "Shorter." });
    // proposal.md is now a person's save, read by the feature stage, which hasn't run here.
    expect(notRun.status).toBe(409);
    expect(JSON.stringify(notRun.body)).toContain(`run atticus change feature ${CHANGE} first`);
  });

  it("takes back a correction that waits, and keeps one a run has read", async () => {
    const list = Api.CorrectionList.parse(
      (await call("GET", `/api/changes/${CHANGE}/corrections`)).body,
    );
    const [first, second] = list.corrections;
    const r = await call("POST", `/api/changes/${CHANGE}/corrections/${second!.id}/remove`);
    expect(r.status).toBe(200);
    expect(Api.CorrectionList.parse(r.body).corrections.map((c) => c.id)).toEqual([first!.id]);
    expect(
      (await call("POST", `/api/changes/${CHANGE}/corrections/${second!.id}/remove`)).status,
    ).toBe(404);
    expect((await call("POST", `/api/changes/${CHANGE}/corrections/nope/remove`)).status).toBe(400);
    // A run read the first one.
    const f = join(dir, "stage/corrections.yaml");
    const y = parse(await readFile(f, "utf8"));
    y.corrections[0].state = "applied";
    y.corrections[0].run = "run-arch-0002";
    await writeFile(f, stringify(y));
    const kept = await call("POST", `/api/changes/${CHANGE}/corrections/${first!.id}/remove`);
    expect(kept.status).toBe(409);
    expect(JSON.stringify(kept.body)).toContain("stays on file");
  });
});
