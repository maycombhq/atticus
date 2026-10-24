import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { probeAnswerCommand, probeCommand, type ProbeDeps } from "../src/probe-commands.js";
import { doctorChecks, type DoctorDeps } from "../src/doctor.js";
import { mapCommand } from "../src/map-commands.js";
import { main } from "../src/main.js";

/**
 * The active capability probe (ADR 0124 §4, addendum A-probe): `atticus probe` writes a file with
 * a code, the assistant answers with `atticus probe answer`, and what it could do is kept per
 * assistant in .atticus/probe/. Fixtures in fixtures/probe/; nothing here calls a network or an
 * assistant: the assistant's part is played by the test writing its answer file.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const CODE = "3f9a1c2e";
const STARTED = new Date("2026-10-24T09:00:00.000Z");
const ANSWERED = new Date("2026-10-24T09:30:00.000Z");

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

const at = (d: Date): ProbeDeps => ({ now: () => d, code: () => CODE });

/** The Forge metarepo: Copilot (the default) and Claude Code allowed, in VS Code and IntelliJ. */
async function metarepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-probe-cli-"));
  await cp(join(FIXTURES, "forge/metarepo"), root, { recursive: true });
  return root;
}

/** The assistant's part: it opened the challenge and wrote the code beside it. */
async function assistantWrites(root: string, text = CODE) {
  const challenge = await readFile(join(root, ".runs/probe/challenge.md"), "utf8");
  expect(challenge).toContain(`Code: ${CODE}`);
  await writeFile(join(root, ".runs/probe/answer.txt"), `${text}\n`);
}

describe("atticus probe: start", () => {
  it("writes the challenge with the code and prints what to do in the assistant, never the code", async () => {
    const root = await metarepo();
    const o = io();
    expect(await probeCommand(root, { assistant: "claude-code" }, o.io, at(STARTED))).toBe(0);
    const want = (await readFile(join(FIXTURES, "probe/expected/start.txt"), "utf8"))
      .replace(/\r\n/g, "\n")
      .trimEnd();
    expect(o.out.join("\n")).toBe(want);
    expect(o.out.join("\n")).not.toContain(CODE);
    expect(await readFile(join(root, ".runs/probe/challenge.md"), "utf8")).toContain(
      `Code: ${CODE}`,
    );
  });

  it("probes runtime.yaml's default assistant unless told another, and only one it allows", async () => {
    const root = await metarepo();
    const o = io();
    expect(await probeCommand(root, {}, o.io, at(STARTED))).toBe(0);
    expect(o.out[0]).toMatch(/^Probing GitHub Copilot/);
    expect(o.out[1]).toMatch(/^In Copilot Chat, run \/atticus-probe/);
    const bad = io();
    expect(await probeCommand(root, { assistant: "cursor" }, bad.io, at(STARTED))).toBe(2);
    expect(bad.err[0]).toBe(
      "runtime.yaml doesn't allow cursor here: it allows copilot, claude-code.",
    );
  });

  it("has no assistant to probe when AI is off", async () => {
    const root = await metarepo();
    await writeFile(
      join(root, "org-pack/runtime.yaml"),
      "schemaVersion: 1\nai: off\nassistants: { allowed: [copilot], default: copilot }\n",
    );
    const o = io();
    expect(await probeCommand(root, {}, o.io, at(STARTED))).toBe(1);
    expect(o.err[0]).toMatch(/^AI is off here \(runtime\.yaml\)/);
  });
});

describe("atticus probe answer: the measurement", () => {
  it("an assistant that opened the file, wrote one and ran the command is agentic (tier 1)", async () => {
    const root = await metarepo();
    await probeCommand(root, { assistant: "claude-code" }, io().io, at(STARTED));
    await assistantWrites(root);
    const o = io();
    expect(await probeAnswerCommand(root, CODE, {}, o.io, at(ANSWERED))).toBe(0);
    expect(o.err).toEqual([]);
    expect(await readFile(join(root, ".atticus/probe/claude-code.yaml"), "utf8")).toBe(
      (await readFile(join(FIXTURES, "probe/expected/claude-code.yaml"), "utf8")).replace(
        /\r\n/g,
        "\n",
      ),
    );
    const text = o.out.join("\n");
    expect(text).toContain(
      "Measured Claude Code: opened the file Atticus wrote: yes; wrote a file: yes; ran a command itself: yes. That is agentic (tier 1).",
    );
    expect(text).toContain("/atticus-map <repo> reads a repo in one session");
    expect(text).toContain("No model limit was stated");
    expect(text).toContain(".atticus/probe/claude-code.yaml");
    // The challenge is used up: answering again finds no probe.
    expect(existsSync(join(root, ".runs/probe"))).toBe(false);
    const again = io();
    expect(await probeAnswerCommand(root, CODE, {}, again.io, at(ANSWERED))).toBe(1);
    expect(again.err[0]).toBe("No probe is under way here: start one with atticus probe.");
  });

  it("a pasted answer from an assistant that wrote the file is the batched hand-off (tier 2), with the stated limit", async () => {
    const root = await metarepo();
    await probeCommand(root, {}, io().io, at(STARTED));
    await assistantWrites(root);
    const o = io();
    expect(
      await probeAnswerCommand(root, CODE, { pasted: true, maxTokens: 12078 }, o.io, at(ANSWERED)),
    ).toBe(0);
    const kept = await readFile(join(root, ".atticus/probe/copilot.yaml"), "utf8");
    expect(kept).toContain("tier: 2");
    expect(kept).toContain("answered: pasted");
    expect(kept).toContain("maxTokens: 12078");
    expect(o.out.join("\n")).toContain("ran a command itself: no (the line was pasted)");
    expect(o.out.join("\n")).toContain("Model limit: 12078 tokens, as stated.");
  });

  it("an answer of none, pasted, is copy-paste (tier 3); a limit given at the start is kept", async () => {
    const root = await metarepo();
    await probeCommand(root, { maxTokens: 8000 }, io().io, at(STARTED));
    const o = io();
    expect(await probeAnswerCommand(root, "none", { pasted: true }, o.io, at(ANSWERED))).toBe(0);
    const kept = await readFile(join(root, ".atticus/probe/copilot.yaml"), "utf8");
    expect(kept).toContain("tier: 3");
    expect(kept).toContain("read: false");
    expect(kept).toContain("maxTokens: 8000");
    expect(o.out.join("\n")).toContain("atticus map <repo> --copy --max-tokens 8000");
  });

  it("an answer file without the code doesn't count as a write", async () => {
    const root = await metarepo();
    await probeCommand(root, { assistant: "claude-code" }, io().io, at(STARTED));
    await assistantWrites(root, "something else");
    const o = io();
    expect(await probeAnswerCommand(root, CODE, {}, o.io, at(ANSWERED))).toBe(0);
    expect(await readFile(join(root, ".atticus/probe/claude-code.yaml"), "utf8")).toContain(
      "tier: 3",
    );
    expect(o.out.join("\n")).toContain(
      "wrote a file: no (.runs/probe/answer.txt doesn't hold the code)",
    );
  });

  it("refuses a wrong code and records nothing: the assistant didn't read the file", async () => {
    const root = await metarepo();
    await probeCommand(root, { assistant: "claude-code" }, io().io, at(STARTED));
    const o = io();
    expect(await probeAnswerCommand(root, "deadbeef", {}, o.io, at(ANSWERED))).toBe(1);
    expect(o.err[0]).toBe(
      "deadbeef isn't the code in .runs/probe/challenge.md: the assistant didn't read that file. Nothing was recorded. Run /atticus-probe again, or answer none if the assistant can't open files.",
    );
    expect(existsSync(join(root, ".atticus/probe/claude-code.yaml"))).toBe(false);
    // The probe stays open for a right answer.
    expect(await probeAnswerCommand(root, CODE, {}, io().io, at(ANSWERED))).toBe(0);
  });

  it("refuses a probe more than a day old", async () => {
    const root = await metarepo();
    await probeCommand(root, { assistant: "claude-code" }, io().io, at(STARTED));
    const o = io();
    expect(
      await probeAnswerCommand(root, CODE, {}, o.io, at(new Date("2026-10-25T09:00:01.000Z"))),
    ).toBe(1);
    expect(o.err[0]).toBe(
      "The probe started at 2026-10-24T09:00:00.000Z is more than 24 hours old: start a new one with atticus probe.",
    );
    expect(existsSync(join(root, ".atticus/probe"))).toBe(false);
  });

  it("refuses an answer when no probe was started", async () => {
    const root = await metarepo();
    const o = io();
    expect(await probeAnswerCommand(root, CODE, {}, o.io, at(ANSWERED))).toBe(1);
    expect(o.err[0]).toBe("No probe is under way here: start one with atticus probe.");
  });

  it("keeps the result in .atticus/ of a repo adopted in place, out of Git", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-probe-adopted-"));
    await cp(join(FIXTURES, "forge/metarepo/org-pack"), join(root, ".atticus/org-pack"), {
      recursive: true,
    });
    const s = io();
    await probeCommand(root, { assistant: "claude-code" }, s.io, at(STARTED));
    expect(s.out.join("\n")).toContain("open .atticus/.runs/probe/challenge.md");
    await writeFile(join(root, ".atticus/.runs/probe/answer.txt"), CODE);
    expect(await probeAnswerCommand(root, CODE, {}, io().io, at(ANSWERED))).toBe(0);
    expect(existsSync(join(root, ".atticus/probe/claude-code.yaml"))).toBe(true);
    expect(await readFile(join(root, ".atticus/.gitignore"), "utf8")).toMatch(/^probe\/$/m);
  });
});

describe("doctor, init, adopt and map --estimate prefer the measured tier", () => {
  const healthy = (): DoctorDeps => ({
    env: { PATH: "" },
    platform: "linux",
    nodeVersion: "22.13.1",
    git: async (args) => {
      if (args[0] === "--version") return { stdout: "git version 2.45.1", stderr: "" };
      throw new Error("exit 1");
    },
    openspecVersion: async () => "1.14.0",
    portFree: async () => true,
    freeBytes: async () => 50 * 1024 ** 3,
    onPath: (p) => p === "code",
    assistantFiles: async () => ({ missing: [], stale: [], edited: [] }),
  });

  async function withResult(fixture: string, as: string): Promise<string> {
    const root = await metarepo();
    await mkdir(join(root, ".atticus/probe"), { recursive: true });
    await copyFile(
      join(FIXTURES, "probe/results", fixture),
      join(root, `.atticus/probe/${as}.yaml`),
    );
    return root;
  }

  it("doctor says from runtime.yaml with no probe, and measured on its day with one", async () => {
    const none = (await doctorChecks(await metarepo(), healthy())).find((c) => c.id === "tier")!;
    expect(none.status).toBe("ok");
    expect(none.detail).toMatch(/^agentic \(tier 1\), from runtime\.yaml: /);
    expect(none.detail).toContain("atticus probe measures it with your assistant.");
    const root = await withResult("claude-code.yaml", "claude-code");
    const tier = (await doctorChecks(root, healthy())).find((c) => c.id === "tier")!;
    expect(tier.status).toBe("ok");
    expect(tier.detail).toMatch(
      /^agentic \(tier 1\), measured on 2026-10-24: Claude Code opened a file, wrote one and ran a command itself/,
    );
  });

  it("doctor warns about a stale measurement or a file that isn't one, and says to probe again", async () => {
    const root = await withResult("copilot-stale.yaml", "copilot");
    await writeFile(
      join(root, "org-pack/runtime.yaml"),
      "schemaVersion: 1\nassistants: { allowed: [copilot], default: copilot }\n",
    );
    const tier = (await doctorChecks(root, { ...healthy() })).find((c) => c.id === "tier")!;
    expect(tier.detail).toMatch(/^copy-paste \(tier 3\), measured on 2026-01-10: /);
    expect(tier.detail).toMatch(/days ago: atticus probe measures it again\./);
    expect(tier.status).toBe("warn");
    expect(tier.fix).toMatch(/atticus probe/);
    const broken = await withResult("broken.yaml", "claude-code");
    const b = (await doctorChecks(broken, healthy())).find((c) => c.id === "tier")!;
    expect(b.status).toBe("warn");
    expect(b.detail).toContain(".atticus/probe/claude-code.yaml isn't a probe result");
  });

  it("map --estimate says the measured tier and uses the limit stated when it was measured", async () => {
    const root = await withResult("copilot.yaml", "copilot");
    await writeFile(
      join(root, "org-pack/runtime.yaml"),
      "schemaVersion: 1\nassistants: { allowed: [copilot], default: copilot }\n",
    );
    const repo = join(root, "forge-ledger");
    await mkdir(join(repo, "src"), { recursive: true });
    await writeFile(join(repo, "src/app.ts"), "export const port = 8080;\n");
    const o = io();
    expect(
      await mapCommand(
        root,
        "forge-ledger",
        { estimate: true, dir: repo, commit: "0123abc" },
        o.io,
      ),
    ).toBe(0);
    const text = o.out.join("\n");
    expect(text).toMatch(
      /^Your assistant: batched hand-off \(tier 2\), measured on 2026-10-20\. GitHub Copilot opened and wrote a file/m,
    );
    expect(text).toContain(
      "In batches at 12078 tokens a prompt (the limit stated when your assistant was measured on 2026-10-20)",
    );
    const j = io();
    await mapCommand(
      root,
      "forge-ledger",
      { estimate: true, dir: repo, commit: "0123abc", json: true },
      j.io,
    );
    const r = JSON.parse(j.out.join("\n"));
    expect(r.tier).toMatchObject({ tier: 2, source: "probe" });
    expect(r.maxTokensFrom).toBe("probe");
  });

  it("is a command of the command line, with its options in the help", async () => {
    const root = await metarepo();
    const out: string[] = [];
    const err: string[] = [];
    const run = (argv: string[]) =>
      main([...argv, "--root", root], { out: (l) => out.push(l), err: (l) => err.push(l) });
    expect(await run(["probe", "--assistant", "claude-code"])).toBe(0);
    expect(out[0]).toMatch(/^Probing Claude Code/);
    const code = (await readFile(join(root, ".runs/probe/challenge.md"), "utf8")).match(
      /Code: ([0-9a-f]{8})/,
    )![1]!;
    await writeFile(join(root, ".runs/probe/answer.txt"), code);
    out.length = 0;
    expect(
      await run(["probe", "answer", code, "--pasted", "--max-tokens", "12078", "--json"]),
    ).toBe(0);
    expect(JSON.parse(out.join("\n"))).toMatchObject({
      assistant: "claude-code",
      tier: 2,
      read: true,
      write: true,
      run: false,
      answered: "pasted",
      maxTokens: 12078,
      file: ".atticus/probe/claude-code.yaml",
    });
    expect(await run(["probe", "answer"])).toBe(2);
    expect(err.at(-1)).toMatch(/^Usage: atticus probe answer <code\|none>/);
  });
});
