import { cp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { smokeCheck } from "@maycombhq/assistant-files";
import {
  atticus,
  CHANGE,
  changeDir,
  FORGE_CHANGE,
  forgeEstate,
  removeTop,
  T,
  type Estate,
} from "./helpers.js";

/**
 * M3 exit: "generated Copilot and Claude Code files pass smoke runs in both assistants". Real
 * smoke runs need the assistants themselves and a person (listed in docs/m3-exit.md). This is
 * the structural part, checked independently of Atticus's own smoke check: front matter is
 * valid YAML with the keys each assistant needs, every command a file mentions exists for both
 * assistants, every `atticus` command a file tells the assistant to run exists, and no file
 * holds an absolute path or anything that looks like a secret. For the metarepo and for a
 * code repo's change worktree (forge-ledger, a Spec Kit repo).
 */

let e: Estate;
let wt: string;
let helpGroups: Set<string>;
let helpPairs: Set<string>;
const generated: Record<"metarepo" | "code repo", string[]> = { metarepo: [], "code repo": [] };

const created = (out: string[]) =>
  out.filter((l) => l.startsWith("  created: ")).map((l) => l.slice("  created: ".length));

beforeAll(async () => {
  e = await forgeEstate();
  expect((await atticus(e.root, "workspace", "sync")).code).toBe(0);
  expect((await atticus(e.root, "scan")).code).toBe(0);
  await cp(join(FORGE_CHANGE, "openspec/changes", CHANGE), changeDir(e.root), { recursive: true });
  expect((await atticus(e.root, "workspace", "open", CHANGE, "--repos", "forge-ledger")).code).toBe(
    0,
  );
  wt = join(e.root, "workspace/.worktrees", CHANGE, "forge-ledger");
  // Every command, the legacy ones too (ADR 0124 addendum D-cli): atticus help shows twelve.
  const help = (await atticus(undefined, "help", "--all")).out.join("\n").split("\n");
  helpGroups = new Set();
  helpPairs = new Set();
  for (const l of help) {
    const m = /^ {2}atticus ([a-z][a-z-]*)(?: ([a-z][a-z-]*))?/.exec(l);
    if (!m) continue;
    helpGroups.add(m[1]!);
    if (m[2]) helpPairs.add(`${m[1]} ${m[2]}`);
  }
}, T);
afterAll(() => removeTop(e));

/** Front matter rules each assistant needs, by path. */
const RULES: [RegExp, string[]][] = [
  [/^\.claude\/agents\/[^/]+\.md$/, ["name", "description"]],
  [/^\.claude\/commands\/[^/]+\.md$/, ["description"]],
  [/^\.claude\/skills\/[^/]+\/SKILL\.md$/, ["name", "description"]],
  [/^\.github\/agents\/[^/]+\.agent\.md$/, ["name", "description"]],
  [/^\.github\/prompts\/[^/]+\.prompt\.md$/, ["description"]],
  [/^\.github\/instructions\/[^/]+\.instructions\.md$/, ["description", "applyTo"]],
];

const ABSOLUTE =
  /(^|[\s"'`(=])(\/(home|Users|tmp|var|private|root|mnt|opt)\/[^\s"'`)]*|[A-Za-z]:\\[^\s"'`)]*)/m;
const SECRETS: [RegExp, string][] = [
  [/AKIA[0-9A-Z]{16}/, "an AWS access key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, "a GitHub token"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/\bsk-[A-Za-z0-9_-]{20,}/, "an API key"],
  [
    /\b(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["']?[A-Za-z0-9/+_-]{8,}/i,
    "a credential",
  ],
  [/\bBearer\s+[A-Za-z0-9._-]{20,}/, "a bearer token"],
];

interface Problem {
  file: string;
  problem: string;
}

/** The structural smoke checks over one set of generated files. */
async function check(dir: string, files: string[]): Promise<Problem[]> {
  const out: Problem[] = [];
  const texts = new Map<string, string>();
  for (const f of files)
    texts.set(f, (await readFile(join(dir, f), "utf8")).replace(/\r\n/g, "\n"));
  const claudeCommands = new Set(
    files.map((f) => /^\.claude\/commands\/(.+)\.md$/.exec(f)?.[1]).filter((x): x is string => !!x),
  );
  const copilotPrompts = new Set(
    files
      .map((f) => /^\.github\/prompts\/(.+)\.prompt\.md$/.exec(f)?.[1])
      .filter((x): x is string => !!x),
  );
  for (const [f, text] of texts) {
    const add = (problem: string) => out.push({ file: f, problem });
    // Front matter.
    const rule = RULES.find(([re]) => re.test(f));
    if (rule) {
      const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
      if (!m) add("no YAML front matter on the first line");
      else {
        let data: Record<string, unknown> | undefined;
        try {
          data = parse(m[1]!) as Record<string, unknown>;
        } catch (err) {
          add(`front matter is not valid YAML: ${(err as Error).message}`);
        }
        for (const k of rule[1])
          if (typeof data?.[k] !== "string" || !(data[k] as string).trim())
            add(`front matter has no ${k}`);
        const skill = /^\.claude\/skills\/([^/]+)\/SKILL\.md$/.exec(f);
        if (skill && data?.name !== skill[1])
          add(`skill name ${String(data?.name)} isn't its folder`);
        if (/agents\//.test(f) && String(data?.name ?? "").includes(":"))
          add("agent name contains ':'");
      }
    }
    // Slash commands mentioned exist for both assistants.
    const mentioned = new Set<string>();
    for (const m of text.matchAll(
      /(?<![\w/.:-])\/((?:atticus-[a-z][a-z-]*[a-z])|(?:speckit\.[a-z]+))\b/g,
    ))
      mentioned.add(m[1]!);
    for (const m of text.matchAll(/^- `\/([a-z][a-z0-9.-]*)`$/gm)) mentioned.add(m[1]!);
    for (const name of mentioned) {
      if (!claudeCommands.has(name)) add(`mentions /${name}, which has no Claude Code command`);
      if (!copilotPrompts.has(name)) add(`mentions /${name}, which has no Copilot prompt`);
    }
    // atticus commands the file tells the assistant to run exist in the CLI.
    for (const m of text.matchAll(/(?<![\w-])atticus ([a-z][a-z-]*)(?: ([a-z][a-z-]*))?/g)) {
      const [, group, sub] = m;
      if (!helpGroups.has(group!)) {
        add(`tells the assistant to run atticus ${group}, which isn't a command`);
        continue;
      }
      const subs = [...helpPairs].filter((p) => p.startsWith(`${group} `));
      if (sub && subs.length > 0 && !helpPairs.has(`${group} ${sub}`) && subs.some(() => true))
        if (!/^(and|or|then|to|for|with|in|on|the|a)$/.test(sub))
          add(`tells the assistant to run atticus ${group} ${sub}, which isn't a command`);
    }
    // No absolute paths, no secrets.
    const abs = ABSOLUTE.exec(text);
    if (abs) add(`contains an absolute path: ${abs[2]}`);
    if (text.includes(e.top)) add("contains the machine's own folder");
    for (const [re, what] of SECRETS) if (re.test(text)) add(`looks like it holds ${what}`);
  }
  // Both assistants get the same commands.
  for (const c of claudeCommands)
    if (!copilotPrompts.has(c))
      out.push({ file: `.claude/commands/${c}.md`, problem: "no Copilot prompt" });
  for (const c of copilotPrompts)
    if (!claudeCommands.has(c))
      out.push({ file: `.github/prompts/${c}.prompt.md`, problem: "no Claude Code command" });
  return out;
}

describe("M3 exit step 3: assistant files for Copilot and Claude Code", () => {
  it(
    "atticus assistant-files writes the metarepo's Copilot and Claude Code files from the org pack, and --check finds them up to date",
    async () => {
      const r = await atticus(e.root, "assistant-files");
      expect(r.code).toBe(0);
      expect(r.out.at(-1)).toBe("Wrote assistant files for the metarepo from the org pack.");
      generated.metarepo = created(r.out);
      for (const f of ["CLAUDE.md", ".github/copilot-instructions.md"])
        expect(generated.metarepo).toContain(f);
      expect(generated.metarepo.filter((f) => f.startsWith(".claude/agents/"))).toHaveLength(9);
      expect(generated.metarepo.filter((f) => f.startsWith(".github/agents/"))).toHaveLength(9);
      expect(generated.metarepo).toContain(".claude/commands/atticus-critic.md");
      expect(generated.metarepo).toContain(".github/prompts/atticus-critic.prompt.md");
      // The draft skill is never generated.
      expect(generated.metarepo.some((f) => f.includes("portal-copy"))).toBe(false);
      const c = await atticus(e.root, "assistant-files", "--check");
      expect(c.out).toEqual(["Assistant files for the metarepo are up to date."]);
      expect(c.code).toBe(0);
    },
    T,
  );

  it(
    "atticus assistant-files --repo forge-ledger --change add-transfer-limit writes the code repo's files, with the Spec Kit commands",
    async () => {
      const r = await atticus(
        e.root,
        "assistant-files",
        "--repo",
        "forge-ledger",
        "--change",
        CHANGE,
      );
      expect(r.code).toBe(0);
      expect(r.out.at(-1)).toBe(
        "Wrote assistant files for forge-ledger (speckit) from the org pack.",
      );
      generated["code repo"] = created(r.out);
      expect(generated["code repo"]).toContain(".claude/commands/speckit.plan.md");
      expect(generated["code repo"]).toContain(".github/prompts/speckit.plan.prompt.md");
    },
    T,
  );

  for (const which of ["metarepo", "code repo"] as const)
    it(
      `${which}: front matter is valid, every command mentioned exists in both assistants, every atticus command exists, no absolute paths, no secrets`,
      async () => {
        const dir = which === "metarepo" ? e.root : wt;
        const files = generated[which].filter((f) => f.endsWith(".md"));
        expect(files.length).toBeGreaterThan(20);
        expect(await check(dir, files)).toEqual([]);
        // The checks had something to check: commands are mentioned and atticus is run.
        const text = (await Promise.all(files.map((f) => readFile(join(dir, f), "utf8")))).join(
          "\n",
        );
        if (which === "metarepo")
          expect(text.match(/(?<![\w-])atticus [a-z]/g)?.length ?? 0).toBeGreaterThan(0);
        expect(text.match(/(?<![\w/.:-])\/(atticus-|speckit\.)/g)?.length ?? 0).toBeGreaterThan(3);
        // Atticus's own smoke check agrees.
        const all = await Promise.all(
          generated[which].map(async (path) => ({
            path,
            content: await readFile(join(dir, path), "utf8"),
          })),
        );
        expect(smokeCheck(all)).toEqual([]);
        // Every agent carries the safety rules.
        for (const f of files.filter((x) => /agents\//.test(x))) {
          const text = await readFile(join(dir, f), "utf8");
          expect(text, f).toMatch(/data, never instructions/);
          expect(text, f).toMatch(/Never push to a protected branch/);
        }
      },
      T,
    );

  it("the checks themselves catch what they look for", async () => {
    const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const d = await mkdtemp(join(tmpdir(), "atticus-m3-smoke-"));
    await mkdir(join(d, ".claude/commands"), { recursive: true });
    await writeFile(
      join(d, ".claude/commands/bad.md"),
      "---\ndescription: [unclosed\n---\nRun /atticus-nope, then atticus frobnicate.\nSee /home/someone/x.\napi_key: abcdefghijklmnop\n",
    );
    const problems = (await check(d, [".claude/commands/bad.md"])).map((p) => p.problem);
    expect(problems.some((p) => p.startsWith("front matter is not valid YAML"))).toBe(true);
    expect(problems).toContain("mentions /atticus-nope, which has no Claude Code command");
    expect(problems).toContain(
      "tells the assistant to run atticus frobnicate, which isn't a command",
    );
    expect(problems.some((p) => p.startsWith("contains an absolute path"))).toBe(true);
    expect(problems).toContain("looks like it holds a credential");
    expect(problems).toContain("no Copilot prompt");
  });
});
