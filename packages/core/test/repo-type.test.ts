import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { loadOrgPack, orgPackJsonSchemas, RepoType } from "../src/index.js";

const PACK = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/repo-types/metarepo/org-pack",
);
const SPRING = join(PACK, "repo-types", "forge-spring-service", "type.yaml");

describe("repo types (ADR 0077)", () => {
  it("parses the fixture's types, with defaults for what isn't given", async () => {
    const t = RepoType.parse(parse(await readFile(SPRING, "utf8")));
    expect(t.id).toBe("forge-spring-service");
    expect(t.fingerprint.map((s) => s.kind)).toEqual([
      "build-file",
      "dependency",
      "marker",
      "layout",
      "layout",
    ]);
    const dep = t.fingerprint[1]!;
    expect(dep.kind === "dependency" && dep.in).toContain("**/pom.xml");
    expect(t.fingerprint[0]!.required).toBe(false);
    expect(t.settings.prefixes[0]!.key).toBe("server.servlet.context-path");
    const min = RepoType.parse({
      schemaVersion: 1,
      id: "x",
      name: "X",
      description: "d",
      fingerprint: [{ kind: "layout", globs: ["src/**"], weight: 1 }],
    });
    expect(min.settings).toEqual({ exclude: [], prefixes: [] });
    expect(min.skills).toEqual([]);
  });

  it("refuses a pattern that doesn't compile, a rule with both key and pattern, a bad skill path or weight", () => {
    const base = {
      schemaVersion: 1,
      id: "x",
      name: "X",
      description: "d",
      fingerprint: [{ kind: "layout", globs: ["src/**"], weight: 1 }],
    };
    const ok = (patch: object) => RepoType.safeParse({ ...base, ...patch }).success;
    expect(ok({})).toBe(true);
    expect(ok({ fingerprint: [{ kind: "marker", pattern: "(", in: ["**/*"], weight: 1 }] })).toBe(
      false,
    );
    expect(ok({ fingerprint: [{ kind: "layout", globs: ["src/**"], weight: 0 }] })).toBe(false);
    expect(ok({ fingerprint: [{ kind: "layout", globs: ["../x/**"], weight: 1 }] })).toBe(false);
    expect(ok({ fingerprint: [] })).toBe(false);
    const rule = { files: ["a.properties"], paths: ["src/**"], why: "w" };
    expect(ok({ settings: { prefixes: [{ ...rule, key: "k" }] } })).toBe(true);
    expect(ok({ settings: { prefixes: [{ ...rule, key: "k", pattern: "(x)" }] } })).toBe(false);
    expect(ok({ settings: { prefixes: [rule] } })).toBe(false);
    expect(ok({ skills: ["skills/a.md"] })).toBe(false);
  });

  it("loads repo-types/<id>/type.yaml and its skills, and reports a wrong folder or a missing skill", async () => {
    const op = await loadOrgPack(PACK);
    expect(op.problems).toEqual([]);
    expect(op.repoTypes.map((t) => t.id)).toEqual(["forge-spring-service", "forge-web-ui"]);
    expect(Object.keys(orgPackJsonSchemas())).toContain("RepoType");

    const dir = await mkdtemp(join(tmpdir(), "atticus-repo-types-"));
    await cp(PACK, dir, { recursive: true });
    const web = join(dir, "repo-types", "forge-web-ui", "type.yaml");
    const text = await readFile(web, "utf8");
    await writeFile(
      web,
      text
        .replace("id: forge-web-ui", "id: forge-browser-app")
        .replace("read-forge-web-ui/SKILL.md", "read-forge-browser/SKILL.md"),
    );
    const bad = await loadOrgPack(dir);
    expect(bad.repoTypes.map((t) => t.id)).toEqual(["forge-spring-service"]);
    expect(bad.problems).toContainEqual({
      file: "repo-types/forge-web-ui/type.yaml",
      path: "id",
      message: "is forge-browser-app; put it in repo-types/forge-browser-app/type.yaml",
    });
    await writeFile(web, text.replace("read-forge-web-ui/SKILL.md", "read-forge-browser/SKILL.md"));
    expect((await loadOrgPack(dir)).problems).toContainEqual({
      file: "repo-types/forge-web-ui/type.yaml",
      path: "skills.0",
      message: "no skill at process/skills/read-forge-browser/SKILL.md",
    });
  });
});
