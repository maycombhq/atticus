import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { toCanonicalYaml } from "@maycombhq/core";
import { changeFolder, checkFindings } from "../src/index.js";

// Review round 47: the gate reads the newest round; a round the critic didn't finish (a crash
// after writing some findings, or before writing any) must not pass it.
const ID = "add-refunds";
const finding = (round: number, severity: "blocking" | "risk", state = "open") => ({
  schemaVersion: 1,
  id: "pub-auth",
  kind: "issue",
  change: ID,
  gate: "design",
  round,
  rule: "constitution.public-entry-auth",
  layer: "constitution",
  lens: "safe",
  severity,
  artifact: "design.md",
  locator: { line: 3 },
  summary: "Public entry has no auth",
  why: "w",
  fix: { text: "add auth" },
  evidence: [{ source: "artifact", path: "design.md", line: 3 }],
  waivable: false,
  state,
  createdAt: "2026-11-01T00:00:00Z",
});

async function root() {
  const r = await mkdtemp(join(tmpdir(), "atticus-r47-"));
  const dir = join(changeFolder(r, ID), "review/design/1");
  await mkdir(join(dir, "meta"), { recursive: true });
  await writeFile(join(dir, "pub-auth.yaml"), toCanonicalYaml(finding(1, "blocking")));
  await writeFile(
    join(dir, "meta/round.yaml"),
    toCanonicalYaml({ schemaVersion: 1, change: ID, gate: "design", round: 1, findings: [] }),
  );
  return r;
}
const round2 = (r: string) => join(changeFolder(r, ID), "review/design/2");
const codes = async (r: string) =>
  (await checkFindings(r, { id: ID } as never, ["design"])).map((x) => x.code);

describe("an unfinished critic round stops the gate (round 47)", () => {
  it("blocks on round 1's finding", async () => {
    expect(await codes(await root())).toEqual(["blocking-finding"]);
  });

  it("blocks on a newer round folder a crash left empty", async () => {
    const r = await root();
    await mkdir(round2(r), { recursive: true });
    const reasons = await checkFindings(r, { id: ID } as never, ["design"]);
    expect(reasons).toEqual([
      {
        code: "round-unfinished",
        message: `Critic round 2 on the design gate didn't finish: run atticus critic ${ID} --gate design again.`,
      },
    ]);
  });

  it("blocks on a round whose record still says in-progress, whatever findings it wrote", async () => {
    const r = await root();
    await mkdir(join(round2(r), "meta"), { recursive: true });
    await writeFile(
      join(round2(r), "meta/round.yaml"),
      toCanonicalYaml({
        schemaVersion: 1,
        change: ID,
        gate: "design",
        round: 2,
        state: "in-progress",
      }),
    );
    expect(await codes(r)).toEqual(["round-unfinished"]);
    await writeFile(join(round2(r), "pub-auth.yaml"), toCanonicalYaml(finding(2, "risk")));
    expect(await codes(r)).toEqual(["round-unfinished"]);
  });

  it("still judges an older round with finding files and no record by its findings", async () => {
    const r = await root();
    await mkdir(round2(r), { recursive: true });
    await writeFile(join(round2(r), "pub-auth.yaml"), toCanonicalYaml(finding(2, "risk")));
    expect(await codes(r)).toEqual([]);
  });
});
