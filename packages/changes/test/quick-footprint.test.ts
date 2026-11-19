import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  changeFolder,
  changeFootprint,
  changeStore,
  detectConflicts,
  loadChangeContext,
  newChange,
  plannedByOpenChanges,
} from "../src/index.js";
import { forgeMetarepo } from "./helpers.js";

/**
 * The real-model run of the personas (2.0.0-beta.30): two open quick changes both had tasks
 * under a repo the first one plans, and `change conflicts` said "No open changes overlap". A
 * quick change has no target flows, so its footprint is its tasks.md's repos, planned or not,
 * and the ids its requirements cite and plan.
 */

const HEADER =
  "| Question | Evidence | Asked by | Answered by | Answer | State |\n| --- | --- | --- | --- | --- | --- |";

async function quick(root: string, title: string, requirements: string, tasks: string) {
  const c = await newChange(root, {
    title,
    type: "quick",
    by: "pat",
    now: "2026-11-19T09:00:00Z",
    noBrief: { reason: "Created from requirements.md" },
    requirements: { file: "requirements.md", bytes: new TextEncoder().encode(requirements) },
  });
  const dir = changeFolder(root, c.id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "tasks.md"), tasks);
  return c;
}

const PORTAL = [
  "# Approvals portal",
  "",
  "## Planned",
  "",
  "- `forge-approvals-api`: the portal's backend, a new repo",
  "- `forge-approvals-web`: the portal's screens, a new repo",
  "",
  "## QA",
  "",
  HEADER,
  "| Does the ledger change? | `ledger-api` | qa-naysayer | noor | No | answered |",
  "",
].join("\n");
const RATES = [
  "# Rate-updated event",
  "",
  "## Planned",
  "",
  "- `forge.rates.updated`: the new topic",
  "- `forge-approvals-api`: not created here, planned by `approvals-portal`",
  "",
  "## QA",
  "",
  HEADER,
  "| Who calls it today? | `ledger-api` src/main/java/forge/ledger/LedgerEndpoints.java:11; `ledger-api.post-transfer` | qa-naysayer | noor | The portal | answered |",
  "",
].join("\n");

async function twoChanges() {
  const root = await forgeMetarepo();
  const portal = await quick(
    root,
    "Approvals portal",
    PORTAL,
    "# Tasks\n\n## forge-approvals-api\n\n- [ ] t1 Add the service\n\n## forge-approvals-web\n\n- [ ] t2 Add the screens (after t1)\n",
  );
  const rates = await quick(
    root,
    "Rate-updated event",
    RATES,
    "# Tasks\n\nNotes that are no repo.\n\n## overview\n\nWhat the waves are.\n\n## forge-approvals-api\n\n- [ ] t1 Publish the event\n\n## forge-ledger\n\n- [ ] t2 Listen to it (after t1)\n",
  );
  return { root, portal, rates };
}

describe("a quick change's footprint", () => {
  it("counts the repos its tasks.md names, planned or in the manifest, and the ids its requirements plan", async () => {
    const { root, portal, rates } = await twoChanges();
    const ctx = await loadChangeContext(root);
    const a = await changeFootprint(ctx, portal);
    expect(a.repos).toEqual(["forge-approvals-api", "forge-approvals-web"]);
    // A record the requirements only cite as evidence is not one the change touches.
    expect(a.records).toEqual(["forge-approvals-api", "forge-approvals-web"]);
    const b = await changeFootprint(ctx, rates);
    // `## overview` is a heading of notes: no manifest lists it, nothing plans it, no repo id has its shape.
    expect(b.repos).toEqual(["forge-approvals-api", "forge-ledger"]);
    expect(b.records).toEqual(["forge-approvals-api", "forge.rates.updated"]);
    expect(b.from).toEqual(expect.arrayContaining(["requirements.md", "tasks.md"]));
    // The spread it is weighed for cites the file the repos were read from, never nothing.
    for (const s of [...a.signals, ...b.signals]) expect(s.cite, s.detail).not.toBe("");
  });

  it("so two open quick changes under one planned repo overlap", async () => {
    const { root } = await twoChanges();
    expect(await detectConflicts(root)).toEqual([
      {
        changes: ["approvals-portal", "rate-updated-event"],
        overlap: {
          systems: [],
          interfaces: [],
          dataStores: [],
          tables: [],
          records: ["forge-approvals-api"],
          repos: ["forge-approvals-api"],
          flows: [],
        },
      },
    ]);
  });

  it("leaves a staged change's footprint as it was: a heading no manifest lists is no repo", async () => {
    const root = await forgeMetarepo();
    const c = await newChange(root, {
      title: "Add a limit",
      type: "feature",
      by: "pat",
      now: "2026-11-19T09:00:00Z",
    });
    await writeFile(
      join(changeFolder(root, c.id), "tasks.md"),
      "# Tasks\n\n## forge-approvals-api\n\n- [ ] 1.1 Add it\n",
    );
    const f = await changeFootprint(await loadChangeContext(root), c);
    expect(f.repos).toEqual([]);
    expect(f.records).toEqual([]);
  });
});

describe("what the open changes plan", () => {
  it("is each id under a requirements file's Planned that it creates, and each tasks.md repo no manifest lists", async () => {
    const { root, rates } = await twoChanges();
    const planned = await plannedByOpenChanges(root);
    expect(Object.fromEntries(planned)).toEqual({
      "forge-approvals-api": ["approvals-portal"],
      "forge-approvals-web": ["approvals-portal"],
      "forge.rates.updated": ["rate-updated-event"],
    });
    // An archived change plans nothing any more.
    const store = changeStore(root);
    const was = await store.read(rates.id);
    await store.write({
      ...was,
      state: "archived",
      history: [
        ...was.history,
        { from: was.state, to: "archived", at: "2026-11-19T10:00:00Z", by: "pat" },
      ],
    });
    expect([...(await plannedByOpenChanges(root)).keys()]).toEqual([
      "forge-approvals-api",
      "forge-approvals-web",
    ]);
  });
});
