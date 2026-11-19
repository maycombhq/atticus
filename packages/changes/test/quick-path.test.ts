import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assess,
  changeFolder,
  changeStore,
  handoff,
  loadChangeContext,
  newChange,
  unadoptedChanges,
} from "../src/index.js";
import { REPO, approval, forgeMetarepo, host, passedRound } from "./helpers.js";

/** ADR 0201: a quick change is a plain OpenSpec change, made from a requirements file. */

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE_CHANGE = join(
  HERE,
  "../../../fixtures/forge-change/openspec/changes/add-transfer-limit",
);
const REQUIREMENTS = "# Shipped-orders event\r\n\r\nWhat is wanted and why.\r\n";

async function quickChange() {
  const root = await forgeMetarepo();
  const c = await newChange(root, {
    title: "Shipped-orders event",
    type: "quick",
    by: "pat",
    now: "2026-11-18T09:00:00Z",
    noBrief: { reason: "Created from docs/requirements.md" },
    requirements: new TextEncoder().encode(REQUIREMENTS),
  });
  return { root, c, dir: changeFolder(root, c.id) };
}

describe("a change made from a requirements file", () => {
  it("is in plan with the file copied byte for byte, no brief and no template", async () => {
    const { c, dir } = await quickChange();
    expect(c).toMatchObject({ id: "shipped-orders-event", type: "quick", state: "plan" });
    expect(c.template).toBeUndefined();
    expect(c.history[0]!.reason).toBe("Created from docs/requirements.md");
    expect(await readFile(join(dir, "requirements.md"), "utf8")).toBe(REQUIREMENTS);
    expect(existsSync(join(dir, "brief.md"))).toBe(false);
    expect(existsSync(join(dir, ".openspec.yaml"))).toBe(true);
  });

  it("hands off its four files and requirements.md with its plan", async () => {
    const { root, c, dir } = await quickChange();
    // Before the files are written, the plan gate says which are missing; none is the brief.
    const before = await assess(await loadChangeContext(root), c);
    expect(
      before.blockers.filter((b) => b.code === "missing-artifact").map((b) => b.artifact),
    ).toEqual(["proposal", "specs", "design", "tasks"]);
    for (const f of ["proposal.md", "design.md", "tasks.md", "specs"])
      await cp(join(FORGE_CHANGE, f), join(dir, f), { recursive: true });
    await passedRound(root, c.id, "plan");
    const h = await handoff(root, c.id, {
      gitHost: host(),
      repo: REPO,
      by: "pat",
      approval: approval("pat", "2026-11-18T10:00:00Z"),
      now: "2026-11-18T10:00:00Z",
    });
    expect(h.phase).toBe("plan");
    const files = h.artifacts.map((f) => f.path);
    expect(files).toEqual(
      expect.arrayContaining([
        "design.md",
        "proposal.md",
        "requirements.md",
        "specs/transfer-limits/spec.md",
        "tasks.md",
      ]),
    );
    expect(files).not.toContain("brief.md");
  });

  it("leaves requirements.md out of a later phase's hand-off", async () => {
    const root = await forgeMetarepo();
    const c = await newChange(root, {
      title: "Add transfer limit",
      type: "feature",
      by: "pat",
      now: "2026-11-18T09:00:00Z",
    });
    const dir = changeFolder(root, c.id);
    await writeFile(join(dir, "requirements.md"), REQUIREMENTS);
    const { handoffFilesOf } = await import("../src/handoff.js");
    const ctx = await loadChangeContext(root);
    const a = await assess(ctx, c);
    expect((await handoffFilesOf(ctx, a, "design")).files).not.toContain("requirements.md");
    expect((await handoffFilesOf(ctx, a, "define")).files).toContain("requirements.md");
  });
});

describe("a plain OpenSpec change folder", () => {
  it("is listed as not adopted until it has a change.yaml", async () => {
    const { root } = await quickChange();
    const changes = join(root, "openspec/changes");
    await mkdir(join(changes, "new-portal"), { recursive: true });
    await writeFile(join(changes, "new-portal/proposal.md"), "# A new portal\n");
    await mkdir(join(changes, "move-billing"), { recursive: true });
    await writeFile(join(changes, "move-billing/.openspec.yaml"), "schema: spec-driven\n");
    // Not a change: an empty folder, the archive, a name that is no id.
    await mkdir(join(changes, "scratch"), { recursive: true });
    await mkdir(join(changes, "archive/2026-01-01-old"), { recursive: true });
    await writeFile(join(changes, "archive/2026-01-01-old/proposal.md"), "# Old\n");
    await mkdir(join(changes, "Not An Id"), { recursive: true });
    await writeFile(join(changes, "Not An Id/proposal.md"), "# No\n");
    expect(await unadoptedChanges(root)).toEqual(["move-billing", "new-portal"]);
    expect((await changeStore(root).list()).map((c) => c.id)).toEqual(["shipped-orders-event"]);
  });
});
