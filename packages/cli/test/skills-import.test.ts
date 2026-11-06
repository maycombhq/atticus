import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  claudeBlock,
  factsWithoutSource,
  outputsOf,
  skillsImportCommand,
  skillsListCommand,
  skillsWriteCommand,
  sourcesOf,
  splitFm,
} from "../src/skills-commands.js";

/**
 * G5 (ADR 0177): another team's skills, agents and instructions, taken as a pinned copy into the
 * org pack and written for Claude and Copilot from that one source; a file edited here kept; a
 * skill that carries scripts or states estate facts with no command flagged for the reviewer.
 * On an invented Harbor team's repo; no network.
 */

const temps: string[] = [];
const temp = (n: string) => {
  const d = mkdtempSync(join(tmpdir(), `atticus-skills-${n}-`));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const write = (root: string, path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const read = (root: string, path: string) => readFileSync(join(root, path), "utf8");
const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};

function harborRepo() {
  const dir = temp("harbor");
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "harbor@example.com");
  git("config", "user.name", "Harbor team");
  write(
    dir,
    ".claude/skills/harbor-publish/SKILL.md",
    "---\nname: harbor-publish\ndescription: Publish an event to the Harbor event hub the house way.\n---\n# Harbor publish\n\nUse the HarborPublisher; name the topic as `harbor.<domain>.<event>`.\n",
  );
  write(dir, ".claude/skills/harbor-publish/check.sh", "#!/bin/sh\necho checking\n");
  write(
    dir,
    ".claude/agents/harbor-architect.md",
    "---\nname: harbor-architect\ndescription: Reviews a design against Harbor's patterns.\n---\nYou review designs. Ask atticus guide <system> for the facts.\n",
  );
  write(
    dir,
    ".github/instructions/harbor-java.instructions.md",
    "---\napplyTo: '**/*.java'\n---\nPrefer constructor injection.\n",
  );
  git("add", ".");
  git("commit", "-qm", "skills");
  git("tag", "v2.1");
  // After the tag: not what the tag pins.
  write(
    dir,
    ".claude/agents/harbor-architect.md",
    "---\nname: harbor-architect\ndescription: Changed later.\n---\nLater.\n",
  );
  git("commit", "-qam", "later");
  return dir;
}

function metarepo() {
  const root = temp("meta");
  write(root, "org-pack/pack.yaml", "schemaVersion: 1\nname: forge\n");
  write(root, "CLAUDE.md", "# Forge metarepo\n\nOur own notes.\n");
  return root;
}

describe("one source, two outputs", () => {
  it("writes a skill for Claude and as a Copilot prompt file, an agent for both, instructions for both", () => {
    const skill = outputsOf({
      kind: "skill",
      name: "harbor-publish",
      source: "org-pack/skills/imported/harbor/harbor-publish",
      team: "harbor",
      text: "---\ndescription: Publish an event.\n---\n# Harbor publish\n\nBody.\n",
      files: [{ path: "check.sh", text: "echo\n" }],
    });
    expect(skill.map((x) => x.path)).toEqual([
      ".claude/skills/harbor-publish/SKILL.md",
      ".claude/skills/harbor-publish/check.sh",
      ".github/prompts/harbor-publish.prompt.md",
    ]);
    expect(splitFm(skill[2]!.text).fm).toEqual({
      description: "Publish an event.",
      agent: "agent",
    });
    expect(skill[0]!.text).toContain(
      "<!-- atticus: written from org-pack/skills/imported/harbor/harbor-publish (harbor)",
    );
    const ins = outputsOf({
      kind: "instructions",
      name: "harbor-java",
      source: "s",
      text: "---\napplyTo: '**/*.java'\n---\nX\n",
      files: [],
    });
    expect(splitFm(ins[0]!.text).fm).toMatchObject({ applyTo: "**/*.java" });
    expect(
      claudeBlock([
        {
          kind: "instructions",
          name: "harbor-java",
          source: "org-pack/instructions/imported/harbor/harbor-java.md",
          team: "harbor",
          text: "",
          files: [],
        },
      ]),
    ).toContain("- `org-pack/instructions/imported/harbor/harbor-java.md` (from harbor)");
    expect(
      claudeBlock([
        {
          kind: "instructions",
          name: "ours",
          source: "org-pack/instructions/ours.md",
          text: "",
          files: [],
        },
      ]),
    ).toContain("- @org-pack/instructions/ours.md");
  });

  it("flags a skill that states estate facts with no atticus command to get them", () => {
    expect(factsWithoutSource("Name the topic as harbor.x.y")).toBe(true);
    expect(factsWithoutSource("Ask atticus guide ledger for the topic")).toBe(false);
    expect(factsWithoutSource("Prefer constructor injection.")).toBe(false);
  });
});

describe("atticus skills import, write and list", () => {
  it("imports a team's files at a tag with their provenance, writes them for both assistants, and notes what to review", async () => {
    const root = metarepo();
    const theirs = harborRepo();
    const a = io();
    const code = await skillsImportCommand(root, theirs, { team: "harbor", at: "v2.1" }, a.io);
    expect(code, a.err.join("\n")).toBe(0);
    const said = a.out.join("\n");
    expect(said).toContain("Imported 3 from harbor at v2.1");
    expect(said).toContain("harbor-publish carries files that may run (check.sh)");
    expect(said).toContain("harbor-publish states things about the estate");
    // The pinned copy, as the tag had it.
    expect(read(root, "org-pack/agents/imported/harbor/harbor-architect.md")).toContain(
      "Reviews a design",
    );
    const prov = parse(read(root, "org-pack/imported/harbor.yaml")) as {
      at: string;
      items: { name: string }[];
    };
    expect(prov.at).toBe("v2.1");
    expect(prov.items.map((i) => i.name).sort()).toEqual([
      "harbor-architect",
      "harbor-java",
      "harbor-publish",
    ]);
    // Nothing is written for the assistants until a person runs write, after review.
    expect(existsSync(join(root, ".claude/skills/harbor-publish/SKILL.md"))).toBe(false);
    expect(said).toContain("then atticus skills write puts it where Claude and Copilot read it");
    expect(await skillsWriteCommand(root, {}, io().io)).toBe(0);
    // Written for Claude and Copilot.
    for (const p of [
      ".claude/skills/harbor-publish/SKILL.md",
      ".claude/skills/harbor-publish/check.sh",
      ".github/prompts/harbor-publish.prompt.md",
      ".claude/agents/harbor-architect.md",
      ".github/agents/harbor-architect.agent.md",
      ".github/instructions/harbor-java.instructions.md",
    ])
      expect(existsSync(join(root, p)), p).toBe(true);
    const claude = read(root, "CLAUDE.md");
    expect(claude).toContain("Our own notes.");
    // Another team's instructions are listed, not loaded into every session.
    expect(claude).toContain(
      "`org-pack/instructions/imported/harbor/harbor-java.md` (from harbor)",
    );
    expect(claude).not.toContain("@org-pack/instructions/imported");
    // Nothing behind now; the worktree used for the tag is gone.
    expect(await skillsWriteCommand(root, { check: true }, io().io)).toBe(0);
    expect(existsSync(join(root, ".atticus-tmp"))).toBe(false);
    const l = io();
    expect(await skillsListCommand(root, {}, l.io)).toBe(0);
    expect(l.out.join("\n")).toContain("agent harbor-architect (from harbor)");
    expect((await sourcesOf(root)).length).toBe(3);
  });

  it("keeps a file edited here, on write and on the next import", async () => {
    const root = metarepo();
    const theirs = harborRepo();
    await skillsImportCommand(root, theirs, { team: "harbor", at: "v2.1" }, io().io);
    await skillsWriteCommand(root, {}, io().io);
    write(root, ".github/agents/harbor-architect.agent.md", "My own version.\n");
    write(
      root,
      "org-pack/agents/imported/harbor/harbor-architect.md",
      "---\nname: harbor-architect\ndescription: Ours now.\n---\nOurs.\n",
    );
    const again = io();
    expect(await skillsImportCommand(root, theirs, { team: "harbor", at: "v2.1" }, again.io)).toBe(
      0,
    );
    expect(again.out.join("\n")).toContain(
      "kept org-pack/agents/imported/harbor/harbor-architect.md: edited here since the last import",
    );
    expect(read(root, "org-pack/agents/imported/harbor/harbor-architect.md")).toContain(
      "Ours now.",
    );
    const w = io();
    expect(await skillsWriteCommand(root, {}, w.io)).toBe(0);
    expect(w.out.join("\n")).toContain("kept .github/agents/harbor-architect.agent.md");
    expect(read(root, ".github/agents/harbor-architect.agent.md")).toBe("My own version.\n");
    // A source changed here makes the written files behind.
    write(
      root,
      "org-pack/instructions/imported/harbor/harbor-java.md",
      "---\napplyTo: '**/*.java'\n---\nPrefer records.\n",
    );
    const c = io();
    expect(await skillsWriteCommand(root, { check: true }, c.io)).toBe(1);
    expect(c.out).toContain("behind: .github/instructions/harbor-java.instructions.md");
  });

  it("refuses a tag their repo doesn't have, and a repo with nothing to import", async () => {
    const root = metarepo();
    const theirs = harborRepo();
    expect(await skillsImportCommand(root, theirs, { team: "harbor", at: "v9" }, io().io)).toBe(2);
    expect(await skillsImportCommand(root, temp("empty"), { team: "harbor" }, io().io)).toBe(2);
    expect(await skillsImportCommand(root, theirs, { team: "Harbor Team" }, io().io)).toBe(2);
    // A ref that would be read as an option is refused before git sees it.
    expect(
      await skillsImportCommand(root, theirs, { team: "harbor", at: "--output=/tmp/x" }, io().io),
    ).toBe(2);
  });

  it("never follows a link out of their repo", async () => {
    const root = metarepo();
    const theirs = harborRepo();
    const secret = join(temp("secret"), "secret.txt");
    writeFileSync(secret, "SECRET\n");
    symlinkSync(secret, join(theirs, ".claude/skills/harbor-publish/notes.md"));
    symlinkSync(secret, join(theirs, ".claude/agents/linked.md"));
    const a = io();
    expect(await skillsImportCommand(root, theirs, { team: "harbor" }, a.io)).toBe(0);
    expect(a.out.join("\n")).toContain(
      "left out notes.md: a link to a file elsewhere is never copied",
    );
    expect(existsSync(join(root, "org-pack/skills/imported/harbor/harbor-publish/notes.md"))).toBe(
      false,
    );
    expect(existsSync(join(root, "org-pack/agents/imported/harbor/linked.md"))).toBe(false);
  });
});
