import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/** The lint script `scripts/check-core-neutral.mjs` (ADR 0035 point 4), tested as a module. */

interface Hit {
  file: string;
  line: number;
  name: string;
  allowed: boolean;
}
interface Lint {
  CORE_PACKAGES: string[];
  ALLOW: { file: string; names: string[]; reason: string }[];
  namesIn(line: string): string[];
  stripComments(text: string): string;
  check(root?: string): Hit[];
  staleAllow(hits: Hit[]): { file: string; name: string }[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "../../../scripts/check-core-neutral.mjs");
const lint = async () => (await import(pathToFileURL(SCRIPT).href)) as Lint;

describe("no ecosystem-specific names in core", () => {
  it("finds names as words, camelCase parts and joined parts, and phrases", async () => {
    const { namesIn } = await lint();
    expect(namesIn('if (platform === "openshift") return isOpenShift(x);')).toEqual(["openshift"]);
    expect(namesIn("new GitHubClient(); serviceNowAdapter()")).toEqual(["github", "servicenow"]);
    expect(namesIn('const wt = "azure-devops";')).toEqual(["azure", "azure devops"]);
    expect(namesIn("const shadow = lockAdorned; // nothing")).toEqual([]);
    expect(namesIn("const UI = /angular|react/")).toEqual(["angular", "react"]);
  });

  it("skips comments but reads strings", async () => {
    const { stripComments, namesIn } = await lint();
    const code = stripComments('/** e.g. kafka */\nconst a = "kafka"; // spring\n');
    expect(code.split("\n").flatMap(namesIn)).toEqual(["kafka"]);
    expect(code.split("\n")).toHaveLength(3);
  });

  it("reads only the src/ folders of core packages", async () => {
    const { check } = await lint();
    const root = await mkdtemp(join(tmpdir(), "neutral-"));
    const put = async (p: string, text: string) => {
      await mkdir(dirname(join(root, p)), { recursive: true });
      await writeFile(join(root, p), text);
    };
    await put(
      "packages/core/src/route.ts",
      'export const isRoute = (p: string) => p === "openshift";\n',
    );
    await put("packages/core/src/doc.ts", "/** Works on openshift too. */\nexport const x = 1;\n");
    await put("packages/core/test/route.test.ts", 'const p = "openshift";\n');
    await put("packages/extractors/src/openshift.ts", 'const p = "openshift";\n');
    expect(check(root).map((h) => [h.file, h.line, h.name, h.allowed])).toEqual([
      ["packages/core/src/route.ts", 1, "openshift", false],
    ]);
  });

  it("passes on the repository, with every allowlist entry reasoned and still needed", async () => {
    const { check, staleAllow, ALLOW, CORE_PACKAGES } = await lint();
    const hits = check();
    expect(hits.filter((h) => !h.allowed)).toEqual([]);
    expect(staleAllow(hits)).toEqual([]);
    expect(ALLOW.every((a) => a.reason.length > 20)).toBe(true);
    expect(CORE_PACKAGES).toEqual(
      expect.arrayContaining([
        "core",
        "changes",
        "naysayer",
        "index",
        "scanner",
        "reconcile",
        "features",
        "knowledge",
        "planner",
        "taskrun",
      ]),
    );
  });
});
