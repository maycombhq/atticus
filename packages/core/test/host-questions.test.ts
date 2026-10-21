import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  addManifestHost,
  answerQuestion,
  HOSTS_STEP,
  hostOfQuestion,
  hostQuestionText,
  raiseQuestions,
  readQuestion,
  RepoManifest,
} from "../src/index.js";

const ESTATE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/estate");
const AT = "2026-10-21T12:00:00.000Z";
const MANIFEST = ["org-pack", "profiles", "forge", "repos.manifest.yaml"];

async function metarepo() {
  const root = await mkdtemp(join(tmpdir(), "atticus-hosts-"));
  await cp(join(ESTATE, "org-pack"), join(root, "org-pack"), { recursive: true });
  return root;
}

const hostDraft = {
  question: hostQuestionText("localhost:9966"),
  options: [
    {
      label: "forge-customers",
      means: "forge-customers serves HTTP",
      changes: "localhost:9966 goes under hosts for forge-customers",
    },
    { label: "None of these", means: "An outside system", changes: "Nothing is added" },
  ],
  evidence: ["src/app/owners/owner.service.ts:10"],
  scope: "repo" as const,
};
const by = {
  step: HOSTS_STEP,
  repo: "forge-web",
  command: "atticus scan",
  rerun: "atticus scan",
  at: AT,
};

describe("which repo answers on a host (ADR 0088)", () => {
  it("reads the host back from the question", () => {
    expect(hostQuestionText("localhost:9966")).toBe("Which repo answers on localhost:9966?");
    expect(hostOfQuestion({ question: "Which repo answers on localhost:9966?" })).toBe(
      "localhost:9966",
    );
    expect(hostOfQuestion({ question: "Is docs/ generated?" })).toBeUndefined();
  });

  it("writes the host into the repo's hosts in the manifest, keeping its comments", async () => {
    const root = await metarepo();
    expect(await addManifestHost(root, "forge-customers", "localhost:9966")).toEqual({
      manifest: "org-pack/profiles/forge/repos.manifest.yaml",
      added: true,
    });
    const text = await readFile(join(root, ...MANIFEST), "utf8");
    expect(text).toContain("# The two invented repos of the estate pass tests");
    const m = RepoManifest.parse(parse(text));
    expect(m.repos.find((r) => r.id === "forge-customers")!.hosts).toEqual(["localhost:9966"]);
    // Twice is once.
    expect((await addManifestHost(root, "forge-customers", "localhost:9966")).added).toBe(false);
    await expect(addManifestHost(root, "forge-nothing", "localhost:9966")).rejects.toThrow(
      "forge-nothing isn't in any repos.manifest.yaml",
    );
  });

  it("answering with a repo writes the host; answering none of these writes nothing", async () => {
    const root = await metarepo();
    const { raised } = await raiseQuestions(root, [hostDraft], by);
    const r = await answerQuestion(root, raised[0]!.id, { option: 1, by: "priya.nair", at: AT });
    expect(r.hosts).toEqual({
      repo: "forge-customers",
      host: "localhost:9966",
      manifest: "org-pack/profiles/forge/repos.manifest.yaml",
      added: true,
    });
    expect((await readQuestion(root, raised[0]!.id))!.state).toBe("answered");
    const m = RepoManifest.parse(parse(await readFile(join(root, ...MANIFEST), "utf8")));
    expect(m.repos.find((x) => x.id === "forge-customers")!.hosts).toEqual(["localhost:9966"]);

    const other = await metarepo();
    const q = (await raiseQuestions(other, [hostDraft], by)).raised[0]!;
    const none = await answerQuestion(other, q.id, { option: 2, by: "priya.nair", at: AT });
    expect(none.hosts).toBeUndefined();
    const m2 = RepoManifest.parse(parse(await readFile(join(other, ...MANIFEST), "utf8")));
    expect(m2.repos.every((x) => x.hosts.length === 0)).toBe(true);
  });
});
