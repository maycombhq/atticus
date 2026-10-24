import { parse } from "yaml";
import { parseHeader, findSection, sha256 } from "./header.js";
import { ASSISTANT_FORMATS } from "./assistants.js";

/**
 * Structural smoke checks on generated assistant files, the part of "do these work in the
 * assistant?" a machine can answer: front matter parses and has what each assistant needs,
 * every slash command a file mentions exists for each assistant, no absolute paths, no
 * secrets, and every generated file still carries a valid header. Real assistant smoke runs
 * are done by a person.
 */

export interface SmokeProblem {
  path: string;
  message: string;
}

const ABSOLUTE =
  /(^|[\s"'(`=])(\/(?:home|Users|tmp|var|etc|root|opt|mnt|private)\/[^\s"'`)]*|[A-Za-z]:\\[^\s"'`)]*)/;
const SECRETS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "a cloud access key"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/, "a Git host token"],
  [/\b(?:sk|xox[abp])-[A-Za-z0-9-]{20,}\b/, "an API token"],
  [
    /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*["']?[A-Za-z0-9+/_-]{8,}/i,
    "a credential",
  ],
];

function frontMatter(text: string): { data?: Record<string, unknown>; error?: string } | undefined {
  if (!text.startsWith("---\n")) return undefined;
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) return { error: "front matter has no closing ---" };
  try {
    const data = parse(text.slice(4, end)) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data))
      return { error: "front matter is not a YAML mapping" };
    return { data: data as Record<string, unknown> };
  } catch (e) {
    return { error: `front matter is not valid YAML: ${(e as Error).message.split("\n")[0]}` };
  }
}

const REQUIRED: [RegExp, string[]][] = [
  [/^\.claude\/agents\/[^/]+\.md$/, ["name", "description"]],
  [/^\.claude\/skills\/[^/]+\/SKILL\.md$/, ["name", "description"]],
  [/^\.claude\/commands\/[^/]+\.md$/, ["description"]],
  [/^\.github\/prompts\/[^/]+\.prompt\.md$/, ["description"]],
  [/^\.github\/agents\/[^/]+\.agent\.md$/, ["description"]],
  [/^\.github\/instructions\/[^/]+\.instructions\.md$/, ["applyTo"]],
];

/** Commands each assistant can run, from the files present. */
/** Files a person shares, where only Atticus's marked section is its own: from the registry (ADR 0121). */
const SECTION_FILES = new Set(
  Object.values(ASSISTANT_FORMATS)
    .map((a) => a.instructions)
    .filter((i) => i?.mode === "section")
    .map((i) => i!.path),
);

function commandsOf(paths: string[]) {
  const claude = new Set<string>();
  const copilot = new Set<string>();
  for (const p of paths) {
    let m = /^\.claude\/commands\/(.+)\.md$/.exec(p);
    if (m) claude.add(m[1]!);
    m = /^\.claude\/skills\/([^/]+)\/SKILL\.md$/.exec(p);
    if (m) claude.add(m[1]!);
    m = /^\.github\/prompts\/(.+)\.prompt\.md$/.exec(p);
    if (m) copilot.add(m[1]!);
  }
  return { claude, copilot };
}

export function smokeCheck(files: { path: string; content: string }[]): SmokeProblem[] {
  const out: SmokeProblem[] = [];
  const { claude, copilot } = commandsOf(files.map((f) => f.path));
  const hasClaude = files.some((f) => f.path.startsWith(".claude/") || f.path === "CLAUDE.md");
  const hasCopilot = files.some((f) => f.path.startsWith(".github/"));
  for (const f of files) {
    const text = f.content.replace(/\r\n/g, "\n");
    const add = (message: string) => out.push({ path: f.path, message });

    const section = findSection(text);
    if (SECTION_FILES.has(f.path)) {
      if (!section) add("has no Atticus section");
      else if (sha256(section.inner) !== section.hash)
        add("its Atticus section was edited by hand");
    } else {
      const h = parseHeader(text);
      if (!h) add("has no generated-file header");
      else if (sha256(h.body) !== h.hash) add("was edited after it was generated");
    }

    const req = REQUIRED.find(([re]) => re.test(f.path));
    const front = frontMatter(text);
    if (req && !front) add("needs YAML front matter on its first line");
    if (front?.error) add(front.error);
    if (req && front?.data)
      for (const k of req[1])
        if (typeof front.data[k] !== "string" || !(front.data[k] as string).trim())
          add(`front matter needs ${k}`);
    if (
      front?.data &&
      /^\.claude\/agents\//.test(f.path) &&
      String(front.data.name ?? "").includes(":")
    )
      add("an agent name can't contain ':'");
    const skill = /^\.claude\/skills\/([^/]+)\/SKILL\.md$/.exec(f.path);
    if (skill && front?.data && front.data.name !== skill[1])
      add(`the skill's name must match its folder (${skill[1]})`);

    for (const m of text.matchAll(
      /(?<![\w/.])\/((?:atticus-[a-z][a-z-]*[a-z])|(?:speckit\.[a-z]+))\b/g,
    )) {
      const name = m[1]!;
      if (hasClaude && !claude.has(name))
        add(`mentions /${name}, which has no Claude Code command`);
      if (hasCopilot && !copilot.has(name)) add(`mentions /${name}, which has no Copilot prompt`);
    }

    const abs = ABSOLUTE.exec(text);
    if (abs) add(`contains an absolute path (${abs[2]!.slice(0, 40)})`);
    for (const [re, what] of SECRETS) if (re.test(text)) add(`looks like it contains ${what}`);
  }
  // One problem per path and message.
  return out.filter(
    (p, i) => out.findIndex((q) => q.path === p.path && q.message === p.message) === i,
  );
}
