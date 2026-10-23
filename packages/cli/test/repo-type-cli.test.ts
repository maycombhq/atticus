import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import { RepoType } from "@maycombhq/core";
import { scanSurvey } from "../src/onboard-commands.js";
import { repoTypeDetect, repoTypeNew } from "../src/repo-type-commands.js";

const FX = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const REPOS = join(FX, "forge", "repos");
const NOW = new Date("2026-10-21T12:00:00Z");

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
};

/** A metarepo with the repo-types fixture's org pack. */
async function metarepo() {
  const root = await mkdtemp(join(tmpdir(), "atticus-repo-type-"));
  await cp(join(FX, "repo-types", "metarepo"), root, { recursive: true });
  return root;
}

describe("atticus repo-type (ADR 0077)", () => {
  it("detect prints the verdict and every type's signals with their evidence", async () => {
    const root = await metarepo();
    const t = io();
    expect(await repoTypeDetect(root, join(REPOS, "forge-portal-bff"), {}, t.io)).toBe(0);
    expect(t.out[0]).toBe(
      "forge-portal-bff is a clear match for Forge Spring service (forge-spring-service), 100%. Reuse it: atticus scan survey forge-portal-bff hands its settings and skills to your assistant.",
    );
    expect(t.out[1]).toBe("  forge-spring-service  100% (10 of 10)");
    expect(t.out[2]).toBe(
      "    found    build file pom.xml or build.gradle or build.gradle.kts (2): pom.xml",
    );
    expect(t.out).toContain(
      "  forge-web-ui  0% (0 of 10), ruled out: a required signal is missing",
    );
    expect(t.out).toContain("    missing  build file package.json (2, required)");

    const none = io();
    await repoTypeDetect(root, join(REPOS, "forge-infra"), {}, none.io);
    expect(none.out[0]).toBe(
      "forge-infra matches no known repo type. Draft one: atticus repo-type new <id> --from forge-infra",
    );
    const partial = io();
    await repoTypeDetect(root, join(REPOS, "forge-ledger"), {}, partial.io);
    expect(partial.out[0]).toMatch(/^forge-ledger is a partial match for Forge Spring service/);
  });

  it("detect --json gives the ranked matches", async () => {
    const root = await metarepo();
    const t = io();
    await repoTypeDetect(root, join(REPOS, "forge-portal-ui"), { json: true }, t.io);
    const j = JSON.parse(t.out.join("\n"));
    expect(j).toMatchObject({ repo: "forge-portal-ui", verdict: "clear", best: "forge-web-ui" });
    expect(j.matches.map((m: { type: string }) => m.type)).toEqual([
      "forge-web-ui",
      "forge-spring-service",
    ]);
    expect(j.matches[0].signals[1].evidence).toEqual(["package.json:1"]);
  });

  it("new drafts a type from a repo, which then matches it, and won't overwrite it", async () => {
    const root = await metarepo();
    const t = io();
    expect(
      await repoTypeNew(
        root,
        "forge-bff",
        { from: join(REPOS, "forge-portal-bff"), now: NOW },
        t.io,
      ),
    ).toBe(0);
    expect(t.out[0]).toBe(
      "Wrote org-pack/repo-types/forge-bff/type.yaml from forge-portal-bff: 1 build-file, 1 dependency, 3 marker, 2 layout signals, 1 prefix rule.",
    );
    const text = await readFile(
      join(root, "org-pack", "repo-types", "forge-bff", "type.yaml"),
      "utf8",
    );
    expect(text).toMatch(/^# Drafted from forge-portal-bff by atticus repo-type new on 2026-10-21/);
    expect(RepoType.parse(parse(text)).id).toBe("forge-bff");
    const again = io();
    expect(
      await repoTypeNew(root, "forge-bff", { from: join(REPOS, "forge-portal-bff") }, again.io),
    ).toBe(1);
    expect(again.err[0]).toMatch(/already exists/);
    // Two types now fit the service about as well: a tie, for a person to settle.
    const tie = io();
    await repoTypeDetect(root, join(REPOS, "forge-portal-bff"), {}, tie.io);
    expect(tie.out[0]).toBe(
      "forge-portal-bff matches forge-bff and forge-spring-service about as well. A person decides which it is; then change the types so their fingerprints tell them apart.",
    );
    const bad = io();
    expect(await repoTypeNew(root, "Bad Id", { from: "x" }, bad.io)).toBe(2);
    const nothing = io();
    expect(
      await repoTypeNew(root, "forge-topics", { from: join(REPOS, "forge-events") }, nothing.io),
    ).toBe(1);
  });

  it("scan survey hands the matched type's settings and skills to the assistant", async () => {
    const root = await metarepo();
    const prompts: string[] = [];
    const runtime = new MockRuntime(
      (req: AiRequest) => {
        prompts.push(req.pack.prompt);
        // ADR 0111: an empty answer for a repo with entry points goes back; this one says why.
        return 'schemaVersion: 1\nrepo: forge-notes\nnothing_to_set:\n  why: The type\'s context path is the only prefix and it is already given.\n  checked: ["src/main/resources/application.properties:3"]\n';
      },
      { now: () => NOW },
    );
    const t = io();
    const notes = join(FX, "scan-settings", "repos", "forge-notes");
    expect(await scanSurvey(root, notes, {}, { runtime, now: NOW }, t.io)).toBe(0);
    expect(t.out[0]).toBe(
      "forge-notes is a clear match for the repo type forge-spring-service (100%); its settings and skills go to your assistant.",
    );
    expect(prompts[0]).toContain("Skill for this repo type: Read a Forge Spring service");
    expect(prompts[0]).toContain("at: src/main/resources/application.properties:3");
  });
});
