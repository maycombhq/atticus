import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { FrameworkModel } from "@maycombhq/core";
import { scanEstate } from "@maycombhq/scanner";
import { frameworksCheck, frameworksDiscover, frameworksLearn } from "../src/framework-commands.js";

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

  it("learns the same model from the starter's JAR, from bytecode", async () => {
    const root = await metarepo();
    const c = capture();
    expect(
      await frameworksLearn(
        root,
        "tide-platform",
        join(MESSY, "jars/tide-web-starter-3.2.0.jar"),
        {},
        c.io,
      ),
    ).toBe(0);
    expect(c.out[0]).toBe(
      "Wrote org-pack/frameworks/tide-platform.yaml from tide-web-starter-3.2.0.jar: 3 annotations, 2 wrapper methods, 2 constants (all from bytecode); kept 1 service a person added.",
    );
    const model = FrameworkModel.parse(
      parse(await readFile(join(root, "org-pack/frameworks/tide-platform.yaml"), "utf8")),
    );
    expect(model.annotations.every((a) => a.source.kind === "bytecode")).toBe(true);
  });

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
    expect(bad.err[0]).toMatch(/isn't a folder or a \.jar/);
  });
});

describe("atticus frameworks discover", () => {
  /** The messy metarepo with tide-cards cloned, and a home whose Maven cache may hold the starter. */
  async function estate(withJar: boolean) {
    const root = await metarepo();
    await cp(join(MESSY, "repos/tide-cards"), join(root, "workspace/tide-cards"), {
      recursive: true,
    });
    const home = await mkdtemp(join(tmpdir(), "atticus-home-"));
    if (withJar) {
      const dir = join(home, ".m2/repository/tide/platform/tide-web-starter/3.2.0");
      await mkdir(dir, { recursive: true });
      await cp(
        join(MESSY, "jars/tide-web-starter-3.2.0.jar"),
        join(dir, "tide-web-starter-3.2.0.jar"),
      );
    }
    return { root, home };
  }

  it("finds the house starter a repo builds on, its JAR in the Maven cache, and learns it", async () => {
    const { root, home } = await estate(true);
    const c = capture();
    expect(
      await frameworksDiscover(root, { groups: ["tide.platform"], learn: true, home }, c.io),
    ).toBe(0);
    expect(c.out[0]).toBe("tide.platform:tide-web-starter: 3.2.0 in tide-cards");
    expect(c.out[1]).toMatch(/^ {2}JAR: .*tide-web-starter-3\.2\.0\.jar$/);
    expect(c.out).toContain(
      "Not cloned here, so not read: tide-payments, tide-gateway, tide-web, tide-bff (atticus workspace sync).",
    );
    expect(c.out).toContainEqual(
      expect.stringMatching(
        /^Wrote org-pack\/frameworks\/tide-web-starter\.yaml from tide-web-starter-3\.2\.0\.jar: 3 annotations, 2 wrapper methods, 2 constants \(all from bytecode\)\.$/,
      ),
    );
    const model = FrameworkModel.parse(
      parse(await readFile(join(root, "org-pack/frameworks/tide-web-starter.yaml"), "utf8")),
    );
    expect(model.artifacts).toEqual(["tide.platform:tide-web-starter"]);
  });

  it("names a JAR that isn't on this machine instead of downloading it", async () => {
    const { root, home } = await estate(false);
    const c = capture();
    expect(await frameworksDiscover(root, { groups: ["tide.platform"], home }, c.io)).toBe(0);
    expect(c.out[1]).toBe(
      "  JAR: not on this machine. Put tide-web-starter-3.2.0.jar (from your artifact repository) in a folder and pass --jars <folder>; tide.platform:tide-web-starter isn't downloaded.",
    );
    const none = capture();
    expect(await frameworksDiscover(root, { groups: [] }, none.io)).toBe(2);
  });
});

describe("atticus frameworks check", () => {
  it(
    "runs each model's own tests, and says which model scans won't use and why",
    async () => {
      const root = await metarepo();
      const ok = capture();
      expect(await frameworksCheck(root, undefined, ok.io)).toBe(0);
      expect(ok.out).toEqual([
        "tide-lantern: 2 tests pass; every drafted entry is exercised.",
        "tide-platform: 1 test passes; every drafted entry is exercised.",
      ]);

      const file = join(root, "org-pack/frameworks/tide-lantern.yaml");
      const yaml = await readFile(file, "utf8");
      await writeFile(file, yaml.replace(/tests:[\s\S]*/, "tests: []\n"));
      const none = capture();
      expect(await frameworksCheck(root, "tide-lantern", none.io)).toBe(0);
      expect(none.out).toEqual([
        "tide-lantern: no tests. Scans use it as written; add tests so a wrong entry can't go unnoticed.",
      ]);

      await writeFile(
        file,
        yaml.replace('"endpoint POST /limits inferred"', '"endpoint PUT /limits"'),
      );
      const bad = capture();
      expect(await frameworksCheck(root, "tide-lantern", bad.io)).toBe(1);
      expect(bad.err).toEqual([
        `tide-lantern: test "the BFF's routes": expected "endpoint PUT /limits"; got: endpoint GET /statements/{id} inferred, endpoint POST /limits inferred`,
        "tide-lantern isn't used by scans until its tests pass.",
      ]);

      const missing = capture();
      expect(await frameworksCheck(root, "nope", missing.io)).toBe(2);
    },
    T,
  );
});
