import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  addManifestHost,
  addOutsideSystem,
  answerQuestion,
  HOSTS_OUTSIDE_INTERNAL,
  HOSTS_OUTSIDE_VENDOR,
  outsideSystemOf,
  Profile,
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

/**
 * O1: a host no repo of the estate answers on can be answered "an outside system (new)": the
 * answer writes a system into the profile of the repo that asked, with the host as an alias,
 * another team's (internal) or a vendor's, as a file change a person reviews.
 */
describe("an outside system from a host question (O1)", () => {
  const PROFILE = ["org-pack", "profiles", "forge", "profile.yaml"];
  const outsideDraft = {
    ...hostDraft,
    question: hostQuestionText("ledger.tidewater.example"),
    options: [
      hostDraft.options[0]!,
      {
        label: HOSTS_OUTSIDE_INTERNAL,
        means: "Another team's system",
        changes: "A system is added",
      },
      { label: HOSTS_OUTSIDE_VENDOR, means: "A vendor's system", changes: "A system is added" },
      hostDraft.options[1]!,
    ],
  };

  it("names the system after its host", () => {
    expect(outsideSystemOf("ledger.tidewater.example")).toEqual({
      id: "ledger-tidewater-example",
      name: "ledger.tidewater.example",
    });
    expect(outsideSystemOf("localhost:9966").id).toBe("localhost-9966");
  });

  it("writes the system, with the host as its alias, into the profile (made when there is none)", async () => {
    const root = await metarepo();
    expect(
      await addOutsideSystem(root, "forge-web", "ledger.tidewater.example", "internal"),
    ).toEqual({
      id: "ledger-tidewater-example",
      profile: "org-pack/profiles/forge/profile.yaml",
      added: true,
    });
    const p = Profile.parse(parse(await readFile(join(root, ...PROFILE), "utf8")));
    expect(p.platform).toBe("forge");
    expect(p.systems).toEqual([
      expect.objectContaining({
        id: "ledger-tidewater-example",
        name: "ledger.tidewater.example",
        boundary: "internal",
        aliases: ["ledger.tidewater.example"],
      }),
    ]);
    // Twice is once; and a host another system already names isn't added again.
    expect(
      (await addOutsideSystem(root, "forge-web", "ledger.tidewater.example", "vendor")).added,
    ).toBe(false);
    await expect(addOutsideSystem(root, "forge-nothing", "x.example", "vendor")).rejects.toThrow(
      "forge-nothing isn't in any repos.manifest.yaml",
    );
  });

  it("keeps the profile's comments and its other systems", async () => {
    const root = await metarepo();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(root, ...PROFILE),
      "# The Forge profile (invented).\nschemaVersion: 1\nplatform: forge\nname: Forge\nsystems:\n  - { id: forge, name: Forge, boundary: product }\n",
    );
    await addOutsideSystem(root, "forge-web", "api.lanternmail.example", "vendor");
    const text = await readFile(join(root, ...PROFILE), "utf8");
    expect(text).toContain("# The Forge profile (invented).");
    expect(Profile.parse(parse(text)).systems.map((s) => [s.id, s.boundary])).toEqual([
      ["forge", "product"],
      ["api-lanternmail-example", "vendor"],
    ]);
  });

  it("answering an outside system writes it; the question is answered with it", async () => {
    const root = await metarepo();
    const q = (await raiseQuestions(root, [outsideDraft], by)).raised[0]!;
    const r = await answerQuestion(root, q.id, { option: 3, by: "priya.nair", at: AT });
    expect(r.hosts).toBeUndefined();
    expect(r.system).toEqual({
      id: "ledger-tidewater-example",
      host: "ledger.tidewater.example",
      boundary: "vendor",
      profile: "org-pack/profiles/forge/profile.yaml",
      added: true,
    });
    expect((await readQuestion(root, q.id))!.state).toBe("answered");
    const internal = await metarepo();
    const q2 = (await raiseQuestions(internal, [outsideDraft], by)).raised[0]!;
    expect(
      (await answerQuestion(internal, q2.id, { option: 2, by: "priya.nair", at: AT })).system
        ?.boundary,
    ).toBe("internal");
  });
});
