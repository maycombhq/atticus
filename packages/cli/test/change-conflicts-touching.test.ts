import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { changesTouching, tasksNaming } from "@maycombhq/changes";
import { changeConflicts } from "../src/change-commands.js";
import { writeChangeFiles } from "./field-estate.js";

/**
 * `conflicts <id>` while a change is still being written (beta.30's real-model persona check,
 * four times): no open pair overlaps on the id, since the change asking isn't open yet, so the
 * command also lists each open change whose tasks.md or target flows name it, with where. The
 * pairs are as they were.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");

const state = (id: string, s = "plan") =>
  `schemaVersion: 1\nid: ${id}\ntitle: ${id}\ntype: quick\nstate: ${s}\nauthors: {}\ncreatedAt: 2026-11-19T05:00:00Z\ncreatedBy: pat\nhandoffs: []\nhistory:\n  - from: draft\n    to: ${s}\n    at: 2026-11-19T05:00:00Z\n    by: pat\n    reason: Created\nowners: {}\nsystems: []\ntouches:\n  dataStores: []\n  interfaces: []\n  records: []\n  repos: []\n  tables: []\n`;

const SETTLED_TASKS =
  "# Tasks\n\n## forge-audit\n\n- [ ] t1 Handle the refund kind on forge.items.settled\n\n## forge-svc-01\n\n- [ ] t5 Publish each settled refund after its write (after t1)\n";
const MOVE_TASKS =
  "# Tasks\n\n## forge-svc-00\n\n- [ ] t1 Add the Anvil deployment\n\n## forge-deploy\n\n- [ ] t5 Point the names of forge-svc-00 and forge-svc-01 at Anvil (after t1)\n- [ ] t6 Point forge-svc-010 at Anvil\n";

let root: string;
const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-conflicts-touching-"));
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  await writeChangeFiles(root, "publish-settled-refunds", {
    "change.yaml": state("publish-settled-refunds"),
    "tasks.md": SETTLED_TASKS,
  });
  await writeChangeFiles(root, "move-to-anvil", {
    "change.yaml": state("move-to-anvil"),
    "tasks.md": MOVE_TASKS,
    "target-flows/forge-svc-03.get-refund-4.yaml":
      "flow: forge-svc-03.get-refund-4\nchange: modify\nrepo: forge-svc-03\nsteps: []\n",
  });
  await writeChangeFiles(root, "old-one", {
    "change.yaml": state("old-one", "archived"),
    "tasks.md": "# Tasks\n\n## forge-svc-01\n\n- [x] t1 Done long ago\n",
  });
});

describe("tasksNaming", () => {
  it("cites a heading with its tasks, and a task elsewhere that names the id as a word", () => {
    expect(tasksNaming(MOVE_TASKS, "forge-svc-01")).toEqual([
      {
        file: "tasks.md",
        line: 9,
        heading: "forge-deploy",
        task: "t5",
        text: "- [ ] t5 Point the names of forge-svc-00 and forge-svc-01 at Anvil (after t1)",
      },
    ]);
    expect(tasksNaming(SETTLED_TASKS, "forge-svc-01")).toEqual([
      {
        file: "tasks.md",
        line: 7,
        heading: "forge-svc-01",
        tasks: ["t5"],
        text: "## forge-svc-01",
      },
    ]);
    expect(tasksNaming(MOVE_TASKS, "forge-svc-0")).toEqual([]);
  });
});

describe("atticus change conflicts --touching", () => {
  it("lists each open change whose tasks.md or target flows name the id, beside no pair", async () => {
    const touches = await changesTouching(root, "forge-svc-01");
    expect(touches.map((t) => t.change)).toEqual(["move-to-anvil", "publish-settled-refunds"]);
    expect(touches[0]!.where.map((w) => `${w.file}:${w.line}`)).toEqual(["tasks.md:9"]);
    const flows = await changesTouching(root, "forge-svc-03");
    expect(flows.map((t) => [t.change, t.where.map((w) => `${w.file}:${w.line}`)])).toEqual([
      [
        "move-to-anvil",
        [
          "target-flows/forge-svc-03.get-refund-4.yaml:1",
          "target-flows/forge-svc-03.get-refund-4.yaml:3",
        ],
      ],
    ]);

    const c = io();
    expect(await changeConflicts(root, { touching: "forge-svc-01" }, c.io)).toBe(0);
    expect(c.out).toEqual([
      "No open changes both touch forge-svc-01.",
      "Open changes whose tasks or flows name forge-svc-01 (changes, then show <change id>, lists every change's repos):",
      "- move-to-anvil: tasks.md:9 task t5 under ## forge-deploy",
      "- publish-settled-refunds: tasks.md:7 ## forge-svc-01 (t5)",
    ]);

    const j = io();
    expect(await changeConflicts(root, { touching: "forge-audit", json: true }, j.io)).toBe(0);
    expect(JSON.parse(j.out.join("\n"))).toEqual([
      {
        change: "publish-settled-refunds",
        touches: "forge-audit",
        where: [
          {
            file: "tasks.md",
            line: 3,
            heading: "forge-audit",
            tasks: ["t1"],
            text: "## forge-audit",
          },
        ],
      },
    ]);
  });

  it("keeps the pairs first and as they were, and says nothing more without an id", async () => {
    const none = io();
    expect(await changeConflicts(root, { touching: "forge-portal", json: true }, none.io)).toBe(0);
    expect(none.out).toEqual(["[]"]);
    const said = io();
    expect(await changeConflicts(root, { touching: "forge-portal" }, said.io)).toBe(0);
    expect(said.out).toEqual(["No open changes both touch forge-portal."]);

    await writeChangeFiles(root, "audit-retention", {
      "change.yaml": state("audit-retention"),
      "tasks.md": "# Tasks\n\n## forge-audit\n\n- [ ] t1 Keep audit rows for seven years\n",
    });
    const pairLine = "audit-retention and publish-settled-refunds both touch repos forge-audit";
    const all = io();
    expect(await changeConflicts(root, {}, all.io)).toBe(1);
    expect(all.out).toEqual([pairLine]);
    const one = io();
    expect(await changeConflicts(root, { touching: "forge-audit" }, one.io)).toBe(1);
    expect(one.out).toEqual([
      pairLine,
      "Open changes whose tasks or flows name forge-audit (changes, then show <change id>, lists every change's repos):",
      "- audit-retention: tasks.md:3 ## forge-audit (t1)",
      "- publish-settled-refunds: tasks.md:3 ## forge-audit (t1)",
    ]);
    const j = io();
    expect(await changeConflicts(root, { touching: "forge-audit", json: true }, j.io)).toBe(1);
    const got = JSON.parse(j.out.join("\n")) as Record<string, unknown>[];
    expect(got.map((x) => x.changes ?? x.change)).toEqual([
      ["audit-retention", "publish-settled-refunds"],
      "audit-retention",
      "publish-settled-refunds",
    ]);
  });
});
