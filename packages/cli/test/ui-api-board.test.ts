import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { uiRoutes } from "../src/ui-api.js";
import { CHANGE, speckitRoot } from "./run-helpers.js";

/**
 * ADR 0202 point 6: the Task board's card says why a task isn't ready, whatever holds it, in the
 * ready plan's own sentence (`why`), and the plan's note about the task (`note`). Before, the
 * board copied only what a task waits for, so a task held by an id tasks.md doesn't have, by
 * itself or by a ring showed as waiting for nothing.
 */
let srv: RunningServer;
let root: string;
const tasksMd = (lines: string[]) =>
  writeFile(
    join(root, "openspec/changes", CHANGE, "tasks.md"),
    ["# Tasks", "", "## forge-ledger", "", ...lines, ""].join("\n"),
  );
const board = async () => {
  const r = await fetch(`${srv.url}/api/changes/${CHANGE}/tasks`, {
    headers: { "X-Atticus-Token": srv.token },
  });
  expect(r.status).toBe(200);
  const list = Api.Task.array().parse(await r.json());
  return new Map(list.map((t) => [t.id, t]));
};

beforeAll(async () => {
  ({ root } = await speckitRoot({ repos: ["forge-ledger", "forge-portal-bff"], open: false }));
  srv = await startServer({
    root,
    port: 0,
    user: "pat",
    watch: false,
    extend: (r, ctx) => uiRoutes(r, ctx, { autoDone: { off: true } }),
  });
}, 120_000);
afterAll(async () => {
  await srv.close();
});

describe("GET /api/changes/{id}/tasks: why a task isn't ready (ADR 0202 point 6)", () => {
  it("an id tasks.md doesn't have, a task that names itself, a ring and an id used twice", async () => {
    await writeFile(
      join(root, "openspec/changes", CHANGE, "tasks.md"),
      [
        "# Tasks",
        "",
        "## forge-ledger",
        "",
        "- [ ] 1.1 Add the daily limit column (after 9.9)",
        "- [ ] 1.2 Check the limit (after 1.2)",
        "- [x] 1.3 Done already (after 9.9)",
        "- [ ] 1.4 The first of two with one id",
        "- [ ] 1.4 The second of two with one id",
        "",
        "## forge-portal-bff",
        "",
        "- [ ] 2.1 Expose the remaining limit (after 2.2)",
        "- [ ] 2.2 Send limit-refused events (after 2.1)",
        "",
      ].join("\n"),
    );
    const t = await board();
    expect(t.get("1.1")!.why).toBe("it names task 9.9 in (after …), which tasks.md doesn't have");
    expect(t.get("1.1")!.waits).toBeUndefined();
    expect(t.get("1.2")!.why).toBe("it names itself in (after …)");
    // Done: nothing holds it.
    expect(t.get("1.3")!.why).toBeUndefined();
    expect(t.get("1.4")!.why).toBe(
      "its id 1.4 is used twice in tasks.md: give each task its own id",
    );
    expect(t.get("2.1")!.why).toBe("it and task 2.2 each wait for the other in (after …)");
    expect(t.get("2.2")!.why).toBe("it and task 2.1 each wait for the other in (after …)");
  });

  it("a task that waits says so in `why` beside `waits`; a ready one has neither", async () => {
    await tasksMd(["- [ ] 1.1 Add the daily limit column", "- [ ] 1.2 Check the limit"]);
    const t = await board();
    expect(t.get("1.1")!.why).toBeUndefined();
    expect(t.get("1.1")!.waits).toBeUndefined();
    expect(t.get("1.2")!.waits).toEqual({ tasks: ["1.1"], sameRepo: ["1.1"] });
    expect(t.get("1.2")!.why).toBe("it waits for task 1.1 (same repo) to be done first");
  });

  it("a title that ends in (after …) words no task has: the plan's note, on its task only", async () => {
    await tasksMd([
      "- [ ] 1.1 Add the daily limit column (after the migration window)",
      "- [ ] 1.2 Check the limit",
    ]);
    const t = await board();
    expect(t.get("1.1")!.note).toBe(
      `Task 1.1's title ends "(after the migration window)": no task has that id, so it is read as part of the title`,
    );
    expect(t.get("1.1")!.why).toBeUndefined();
    expect(t.get("1.2")!.note).toBeUndefined();
  });
});

describe("a task whose run is past ready (ADR 0202 point 6)", () => {
  it("says where its run stands as why it isn't ready", async () => {
    const { readFile } = await import("node:fs/promises");
    const { MockRuntime } = await import("@maycombhq/ai");
    const { runTask } = await import("@maycombhq/taskrun");
    const { git } = await import("./run-helpers.js");
    const made = await speckitRoot({ repos: ["forge-ledger"] });
    const manifest = join(made.root, "org-pack/profiles/forge/repos.manifest.yaml");
    await writeFile(
      manifest,
      (await readFile(manifest, "utf8")).replace("    build: forge build && forge test\n", ""),
    );
    const now = () => new Date("2026-11-09T09:00:00Z");
    const file = "src/main/java/forge/ledger/TransferLimits.java";
    const ran = await runTask(made.root, CHANGE, "1.1", {
      level: "draft",
      by: "dev",
      runtime: new MockRuntime(
        () =>
          `Done.\n\n=== file: ${file}\npackage forge.ledger;\n\nclass TransferLimits { boolean ok; }\n=== end file\n`,
        { now },
      ),
      git,
      now,
      commands: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
    });
    expect(ran.state).toBe("unverified");
    const s = await startServer({
      root: made.root,
      port: 0,
      user: "pat",
      watch: false,
      extend: (r, ctx) => uiRoutes(r, ctx, { autoDone: { off: true } }),
    });
    try {
      const r = await fetch(`${s.url}/api/changes/${CHANGE}/tasks`, {
        headers: { "X-Atticus-Token": s.token },
      });
      const t = Api.Task.array()
        .parse(await r.json())
        .find((x) => x.id === "1.1")!;
      expect(t.waits).toBeUndefined();
      expect(t.why).toMatch(/^it is drafted but not built yet: Build and raise PR on its card/);
    } finally {
      await s.close();
    }
  }, 180_000);
});
