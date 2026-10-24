import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canAdvance, changeStore, newChange } from "../src/index.js";
import { FEATURE_OWNERS, FIXTURES, copyPhase, forgeMetarepo } from "./helpers.js";

/**
 * The platform profile's `gates` are mandatory: before the hand-off that leaves such a gate,
 * the critic must have reviewed it (a round exists) and its newest round must pass.
 */

const ID = "add-transfer-limit";

async function inDesign(): Promise<string> {
  const root = await forgeMetarepo();
  await newChange(root, {
    title: "Add transfer limit",
    type: "feature",
    by: "pat",
    owners: FEATURE_OWNERS,
    systems: ["portal", "ledger"],
    now: "2026-10-19T09:00:00Z",
  });
  await copyPhase(root, ID, `${ID}/define`);
  await copyPhase(root, ID, `${ID}/design`);
  const store = changeStore(root);
  const c = await store.read(ID);
  await store.write({
    ...c,
    state: "design",
    history: [
      ...c.history,
      { from: "define", to: "design", at: "2026-10-19T11:00:00Z", by: "ari" },
    ],
  });
  return root;
}

const missing = (r: { reasons: { code: string; message: string }[] }) =>
  r.reasons.filter((x) => x.code === "critic-round-missing").map((x) => x.message);

describe("mandatory gates", () => {
  it("need a critic round before the hand-off that leaves them, and it must pass", async () => {
    const root = await inDesign();
    // Forge's profile makes design and release mandatory.
    expect(missing(await canAdvance(ID, root))).toEqual([
      "The design gate is mandatory on this platform and the critic hasn't reviewed it yet: run atticus critic add-transfer-limit --gate design.",
    ]);

    const review = join(root, "openspec/changes", ID, "review/design");
    await cp(join(FIXTURES, ID, "review/design/1"), join(review, "1"), { recursive: true });
    const failing = await canAdvance(ID, root);
    expect(missing(failing)).toEqual([]);
    expect(failing.reasons.map((r) => r.code)).toContain("blocking-finding");

    await cp(join(FIXTURES, ID, "review/design/2"), join(review, "2"), { recursive: true });
    const passing = await canAdvance(ID, root);
    expect(passing.reasons.map((r) => r.code)).not.toContain("critic-round-missing");
    expect(passing.reasons.map((r) => r.code)).not.toContain("blocking-finding");
  });

  it("on the stage path, never send a person to the critic while the stage's own draft isn't done (W4)", async () => {
    const root = await inDesign();
    // The architecture stage stopped: its draft failed its own checks.
    await mkdir(join(root, "openspec/changes", ID, "stage"), { recursive: true });
    await writeFile(
      join(root, "openspec/changes", ID, "stage/architecture.yaml"),
      "schemaVersion: 1\nchange: add-transfer-limit\nstage: architecture\niteration: 3\nstate: stopped\nupdatedAt: 2026-10-19T12:00:00Z\n",
    );
    const r = await canAdvance(ID, root);
    expect(missing(r)).toEqual([]);
    expect(r.reasons.map((x) => x.code)).toContain("stage-not-done");
    expect(r.reasons.map((x) => x.message).join("\n")).not.toContain("run atticus critic");
  });

  it("aren't required where the profile names none", async () => {
    const root = await inDesign();
    const profile = join(root, "org-pack/profiles/forge/profile.yaml");
    await writeFile(
      profile,
      (await readFile(profile, "utf8")).replace(/^gates: .*$/m, "gates: []"),
    );
    expect(missing(await canAdvance(ID, root))).toEqual([]);
  });
});
