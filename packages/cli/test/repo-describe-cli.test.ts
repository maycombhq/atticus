import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { RepoManifest } from "@maycombhq/core";
import { nextSteps, type NextState } from "../src/next-commands.js";
import { idFromUrl, keepDraftedDescription, repoAdd, repoDescribe } from "../src/repo-commands.js";

/**
 * atticus repo add and atticus repo describe (ADR 0128): one repo into the manifest with what it
 * is in a person's words, and that line written, confirmed or dropped later. The invented Forge
 * estate only (CLAUDE.md rule 3); no network, no model (rules 3 and 5).
 */

const ESTATE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/estate");
const MANIFEST = ["org-pack", "profiles", "forge", "repos.manifest.yaml"];
const NOW = new Date("2026-10-26T09:00:00.000Z");

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
};

async function metarepo() {
  const root = await mkdtemp(join(tmpdir(), "atticus-repo-describe-"));
  await cp(join(ESTATE, "org-pack"), join(root, "org-pack"), { recursive: true });
  return root;
}

const manifestOf = async (root: string) =>
  RepoManifest.parse(parse(await readFile(join(root, ...MANIFEST), "utf8")));
const describedAs = async (root: string, id: string) =>
  (await manifestOf(root)).repos.find((r) => r.id === id)?.description;

describe("atticus repo add", () => {
  it("adds a repo with what it is in a person's words", async () => {
    const root = await metarepo();
    const o = io();
    const code = await repoAdd(
      root,
      "https://git.example.com/forge/forge-ledger.git",
      {
        type: "spring-boot",
        owner: "team-ledger",
        description: "  The ledger: every posting and the balances read from them.  ",
      },
      o.io,
      { now: NOW, by: "pat" },
    );
    expect(code).toBe(0);
    expect(o.err).toEqual([]);
    const d = await describedAs(root, "forge-ledger");
    expect(d).toMatchObject({
      text: "The ledger: every posting and the balances read from them.",
      trust: "verified",
      by: "pat",
      at: "2026-10-26T09:00:00Z",
    });
    // The comments and the repos already listed are kept.
    const text = await readFile(join(root, ...MANIFEST), "utf8");
    expect(text).toContain("# The two invented repos of the estate");
    expect((await manifestOf(root)).repos.map((r) => r.id)).toEqual([
      "forge-web",
      "forge-customers",
      "forge-ledger",
    ]);
  });

  it("asks once when no --description is given, and takes a skip without blocking", async () => {
    const root = await metarepo();
    const asked: string[] = [];
    const o = io();
    await repoAdd(
      root,
      "https://git.example.com/forge/forge-orders.git",
      { type: "spring-boot", owner: "team-orders" },
      o.io,
      {
        now: NOW,
        by: "pat",
        ask: async (prompt) => {
          asked.push(prompt);
          return "Orders: the basket a customer checks out.";
        },
      },
    );
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("forge-orders");
    expect((await describedAs(root, "forge-orders"))?.text).toBe(
      "Orders: the basket a customer checks out.",
    );

    const skip = io();
    await repoAdd(
      root,
      "https://git.example.com/forge/forge-pay.git",
      { type: "spring-boot", owner: "team-pay" },
      skip.io,
      { now: NOW, by: "pat", ask: async () => undefined },
    );
    expect(await describedAs(root, "forge-pay")).toBeUndefined();
    expect(skip.out.join("\n")).toContain("no description yet");
  });

  it("never asks with --no-description or --json, so a bulk add doesn't block", async () => {
    const root = await metarepo();
    let asks = 0;
    const deps = {
      now: NOW,
      by: "pat",
      ask: async () => {
        asks++;
        return "typed";
      },
    };
    await repoAdd(
      root,
      "https://git.example.com/forge/forge-pay.git",
      { type: "spring-boot", owner: "team-pay", noDescription: true },
      io().io,
      deps,
    );
    const j = io();
    await repoAdd(
      root,
      "https://git.example.com/forge/forge-edge.git",
      { type: "gateway", owner: "team-platform", json: true },
      j.io,
      deps,
    );
    expect(asks).toBe(0);
    expect(JSON.parse(j.out.join("\n"))).toMatchObject({ repo: "forge-edge", platform: "forge" });
  });

  it("refuses a repo id another manifest already lists, and a bad id", async () => {
    const root = await metarepo();
    const o = io();
    expect(
      await repoAdd(
        root,
        "https://git.example.com/forge/forge-web.git",
        { noDescription: true },
        o.io,
        { by: "pat" },
      ),
    ).toBe(1);
    expect(o.err.join("\n")).toContain("already lists forge-web");
    const bad = io();
    expect(
      await repoAdd(root, "https://x/y.git", { id: "Forge Web", noDescription: true }, bad.io, {
        by: "pat",
      }),
    ).toBe(2);
    expect(bad.err.join("\n")).toContain("lowercase slugs");
  });

  it("reads the type from a local clone's files, and from the description only where they say nothing", async () => {
    const root = await metarepo();
    // A folder whose files say what it is: the files decide, whatever the description says.
    const built = join(root, "clones", "forge-ledger");
    await mkdir(built, { recursive: true });
    await writeFile(join(built, "go.mod"), "module forge/ledger\n", "utf8");
    const o = io();
    await repoAdd(
      root,
      built,
      { id: "forge-ledger", owner: "team-ledger", description: "An api gateway, honestly." },
      o.io,
      { now: NOW, by: "pat" },
    );
    expect((await manifestOf(root)).repos.find((r) => r.id === "forge-ledger")!.type).toBe("go");
    expect(o.out.join("\n")).toContain("Type: go, from go.mod");

    // A folder whose files say nothing: what the person wrote is better than `unknown`.
    const quiet = join(root, "clones", "forge-edge");
    await mkdir(quiet, { recursive: true });
    await writeFile(join(quiet, "NOTES.txt"), "nothing to build here\n", "utf8");
    const e = io();
    await repoAdd(
      root,
      quiet,
      {
        id: "forge-edge",
        owner: "team-platform",
        description: "The API gateway in front of the Forge APIs.",
      },
      e.io,
      { now: NOW, by: "pat" },
    );
    expect((await manifestOf(root)).repos.find((r) => r.id === "forge-edge")!.type).toBe("gateway");
    expect(e.out.join("\n")).toContain("the repo's description in repos.manifest.yaml");
    expect(e.out.join("\n")).toContain("low confidence");

    // A URL there is no clone of: nothing is read, and the type is a question (`unknown`).
    await repoAdd(
      root,
      "https://git.example.com/forge/forge-pay.git",
      { owner: "team-pay", noDescription: true },
      io().io,
      { now: NOW, by: "pat" },
    );
    expect((await manifestOf(root)).repos.find((r) => r.id === "forge-pay")!.type).toBe("unknown");
  });

  it("given a clone's folder, records its server URL and the branch it is on, not the path", async () => {
    const root = await metarepo();
    const { execFileSync } = await import("node:child_process");
    const git = (cwd: string, ...a: string[]) =>
      execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...a], {
        cwd,
        stdio: "pipe",
      });
    const clone = join(root, "clones", "Forge_Fees_1-0");
    await mkdir(clone, { recursive: true });
    git(clone, "init", "-q", "-b", "develop");
    await writeFile(join(clone, "pom.xml"), "<project/>\n", "utf8");
    git(clone, "add", "-A");
    git(clone, "commit", "-q", "-m", "first");
    git(clone, "remote", "add", "origin", "https://git.example.com/forge/Forge_Fees_1-0.git");
    const o = io();
    expect(
      await repoAdd(root, clone, { owner: "team-fees", noDescription: true }, o.io, {
        now: NOW,
        by: "pat",
      }),
    ).toBe(0);
    const r = (await manifestOf(root)).repos.find((x) => x.id === "forge_fees_1-0")!;
    expect(r.url).toBe("https://git.example.com/forge/Forge_Fees_1-0.git");
    expect(r.defaultBranch).toBe("develop");
    expect(o.out.join("\n")).toContain(
      `Next: atticus workspace sync --from "${join(root, "clones")}" --repos forge_fees_1-0`,
    );
  });

  it("takes the id from the URL", () => {
    expect(idFromUrl("https://git.example.com/forge/forge-ledger.git")).toBe("forge-ledger");
    expect(idFromUrl("git@git.example.com:forge/Forge_Web.git")).toBe("forge_web");
    expect(idFromUrl("/srv/git/forge-pay/")).toBe("forge-pay");
  });
});

describe("atticus repo describe", () => {
  it("writes, replaces and drops the line, and lists what still needs one", async () => {
    const root = await metarepo();
    const list = io();
    expect(await repoDescribe(root, undefined, { json: true }, list.io)).toBe(0);
    expect(JSON.parse(list.out.join("\n"))).toEqual({
      missing: ["forge-web", "forge-customers"],
      unconfirmed: [],
    });

    const w = io();
    expect(
      await repoDescribe(
        root,
        "forge-web",
        { description: "The Forge web app: the pages a customer sees." },
        w.io,
        { now: NOW, by: "pat" },
      ),
    ).toBe(0);
    expect((await describedAs(root, "forge-web"))?.by).toBe("pat");

    const r = io();
    expect(await repoDescribe(root, "forge-web", { reject: true }, r.io, { by: "pat" })).toBe(0);
    expect(await describedAs(root, "forge-web")).toBeUndefined();
    expect(r.out.join("\n")).toContain("dropped");

    const unknown = io();
    expect(await repoDescribe(root, "forge-nothing", { description: "x" }, unknown.io)).toBe(2);
    expect(unknown.err.join("\n")).toContain("no repo forge-nothing");
  });

  it("confirms the draft the assistant wrote, which then stops being marked unconfirmed", async () => {
    const root = await metarepo();
    const kept = await keepDraftedDescription(
      root,
      "forge-customers",
      {
        text: "Customer records and the API the web app reads them through.",
        cites: [{ file: "README.md", line: 3 }],
      },
      NOW,
    );
    expect(kept.kept).toBe(true);
    const draft = await describedAs(root, "forge-customers");
    expect(draft).toMatchObject({ trust: "suggested", by: "assistant" });
    expect(draft!.cites).toEqual([{ file: "README.md", line: 3 }]);

    const list = io();
    await repoDescribe(root, undefined, {}, list.io);
    expect(list.out.join("\n")).toContain("nobody has confirmed it yet");

    const a = io();
    expect(
      await repoDescribe(root, "forge-customers", { accept: true }, a.io, {
        now: NOW,
        by: "pat",
      }),
    ).toBe(0);
    const said = await describedAs(root, "forge-customers");
    expect(said).toMatchObject({ trust: "verified", by: "pat", text: draft!.text });
    expect(a.out.join("\n")).not.toContain("unconfirmed");
  });

  it("takes a draft an assistant that read the repo itself hands over, with its cites", async () => {
    const root = await metarepo();
    const o = io();
    expect(
      await repoDescribe(
        root,
        "forge-web",
        {
          drafted: "The Forge web app: the pages a customer sees.",
          cites: "README.md:2, src/app/main.ts:1",
        },
        o.io,
        { now: NOW },
      ),
    ).toBe(0);
    const d = await describedAs(root, "forge-web");
    expect(d).toMatchObject({ trust: "suggested", by: "assistant" });
    expect(d!.cites).toEqual([
      { file: "README.md", line: 2 },
      { file: "src/app/main.ts", line: 1 },
    ]);
    expect(o.out.join("\n")).toContain("unconfirmed");

    // Without cites it is refused: a draft always says where it came from.
    const none = io();
    expect(
      await repoDescribe(root, "forge-customers", { drafted: "Customers." }, none.io, { now: NOW }),
    ).toBe(2);
    expect(none.err.join("\n")).toContain("--cites");
    expect(await describedAs(root, "forge-customers")).toBeUndefined();
  });

  it("never lets a draft replace a person's words, nor a draft already on file", async () => {
    const root = await metarepo();
    await repoDescribe(root, "forge-web", { description: "A person's words." }, io().io, {
      now: NOW,
      by: "pat",
    });
    const over = await keepDraftedDescription(root, "forge-web", { text: "The assistant's." }, NOW);
    expect(over.kept).toBe(false);
    expect(over.why).toContain("in a person's words");
    expect((await describedAs(root, "forge-web"))?.text).toBe("A person's words.");

    await keepDraftedDescription(root, "forge-customers", { text: "First draft." }, NOW);
    const again = await keepDraftedDescription(
      root,
      "forge-customers",
      { text: "Second draft." },
      NOW,
    );
    expect(again.kept).toBe(false);
    expect((await describedAs(root, "forge-customers"))?.text).toBe("First draft.");
  });
});

describe("atticus next lists the repos that say nothing (ADR 0128)", () => {
  const state = (described: NextState["repos"][number]["described"]): NextState => ({
    repos: [
      {
        id: "forge-ledger",
        cloned: true,
        settings: true,
        scanned: true,
        verify: "done",
        flows: 3,
        checked: true,
        findings: 0,
        described,
      },
    ],
    catalogRecords: 10,
    openQuestions: [],
    sources: [],
    changes: [],
    problems: [],
  });

  it("asks a person for a line, and to confirm a draft, and asks nothing when one is said", () => {
    const steps = (d: NextState["repos"][number]["described"]) =>
      nextSteps(state(d)).map((s) => s.step);
    expect(steps("none")).toContain("describe");
    expect(steps("draft")).toContain("describe-accept");
    expect(steps("said")).not.toContain("describe");
    expect(steps("said")).not.toContain("describe-accept");
    const one = nextSteps(state("none")).find((s) => s.step === "describe")!;
    expect(one.person).toBe(true);
    expect(one.repo).toBe("forge-ledger");
  });
});
