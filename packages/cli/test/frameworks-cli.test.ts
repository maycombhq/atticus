import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { FrameworkModel } from "@maycombhq/core";
import { scanEstate } from "@maycombhq/scanner";
import { frameworksLearn } from "../src/framework-commands.js";

const MESSY = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/messy");
const T = 120_000;

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

/** A metarepo with the messy estate's org pack (its hand-written tide-platform model). */
async function metarepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-frameworks-"));
  await cp(join(MESSY, "metarepo"), root, { recursive: true });
  return root;
}

describe("atticus frameworks learn", () => {
  it(
    "learns the starter's model from its source, keeps what a person added, and the scan verifies its endpoints",
    async () => {
      const root = await metarepo();
      const c = capture();
      expect(
        await frameworksLearn(root, "tide-platform", join(MESSY, "repos/tide-platform"), {}, c.io),
      ).toBe(0);
      expect(c.out[0]).toBe(
        "Wrote org-pack/frameworks/tide-platform.yaml from tide-platform: 3 annotations, 2 wrapper methods, 2 constants (all from code); kept 1 service a person added.",
      );
      expect(c.out).toContain(
        "note: Services.AUDIT, Services.PAYMENTS look like service ids: their base URLs aren't in the code; add them under services: (from the registry's config or a person).",
      );
      const model = FrameworkModel.parse(
        parse(await readFile(join(root, "org-pack/frameworks/tide-platform.yaml"), "utf8")),
      );
      // Learned from code, so code is the source now; the person's service URL is kept.
      expect(model.annotations.map((a) => `${a.name} ${a.source.kind}`)).toEqual([
        "InternalApi code",
        "Op code",
        "ReadOp code",
      ]);
      expect(model.services["Services.AUDIT"]!.source.kind).toBe("person");

      // The scan reads the house controller through a model learned from code: verified.
      const scan = await scanEstate({
        root,
        repoDir: (id) => join(MESSY, "repos", id),
        repoState: async () => ({ commit: "d".repeat(40), dirty: false }),
        cache: null,
        scannedAt: "2026-10-19T12:00:00Z",
      });
      const ep = scan.records.find(
        (r) =>
          r.kind === "Endpoint" &&
          (r as unknown as { pathOrTopic: string }).pathOrTopic === "/statements/{id}",
      );
      expect(ep?.confidence).toBe("verified");
    },
    T,
  );

  it("--dry-run writes nothing; an unknown folder is refused", async () => {
    const root = await metarepo();
    const before = await readFile(join(root, "org-pack/frameworks/tide-platform.yaml"), "utf8");
    const c = capture();
    expect(
      await frameworksLearn(
        root,
        "tide-platform",
        join(MESSY, "repos/tide-platform"),
        { dryRun: true },
        c.io,
      ),
    ).toBe(0);
    expect(c.out[0]).toMatch(/^Dry run: would write org-pack\/frameworks\/tide-platform\.yaml/);
    expect(await readFile(join(root, "org-pack/frameworks/tide-platform.yaml"), "utf8")).toBe(
      before,
    );
    const bad = capture();
    expect(await frameworksLearn(root, "x", join(root, "nowhere"), {}, bad.io)).toBe(2);
    expect(bad.err[0]).toMatch(/isn't a folder/);
  });
});
