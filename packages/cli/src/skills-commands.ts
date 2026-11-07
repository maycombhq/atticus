import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";
import { isAdopted, orgPackDirOf, writeFileAtomic } from "@maycombhq/core";
import type { Output } from "./commands.js";

/**
 * G5 (ADR 0177): skills, agents and team instructions from other product teams, for Claude and
 * Copilot alike. `atticus skills import` takes a pinned copy into the org pack (the copy people
 * review); `atticus skills write` writes from it, and from the organisation's own, where each
 * assistant looks; `atticus skills check` says when what is written is behind. Another team's
 * text is installed for the person's own assistant after review, never fed into Atticus's own
 * reading prompts (rule 6), and nothing in it runs during an import.
 *
 *   org-pack/skills/[imported/<team>/]<name>/SKILL.md (+ files)  →  .claude/skills/<name>/, .github/prompts/<name>.prompt.md
 *   org-pack/agents/[imported/<team>/]<name>.md                   →  .claude/agents/<name>.md, .github/agents/<name>.agent.md
 *   org-pack/instructions/[imported/<team>/]<name>.md             →  CLAUDE.md (an @ import), .github/instructions/<name>.instructions.md
 */

import { originOf } from "./file-lock.js";

const run = promisify(execFile);
const sha = (t: string) => createHash("sha256").update(t).digest("hex").slice(0, 16);
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MARK = (src: string, h: string) =>
  `<!-- atticus: written from ${src} (${h}); edit the source, or keep your edit here: atticus skills write leaves an edited file alone -->`;

export type Kind = "skill" | "agent" | "instructions";

export interface SourceItem {
  kind: Kind;
  name: string;
  /** Where it is kept in the org pack, relative to the root. */
  source: string;
  team?: string;
  /** The text (SKILL.md for a skill), and a skill's other files by their path in its folder. */
  text: string;
  files: { path: string; text: string }[];
}

const packRel = (root: string) => (isAdopted(root) ? ".atticus/org-pack" : "org-pack");

/** A file's front matter and body, split. */
export function splitFm(text: string): { fm: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { fm: {}, body: text };
  try {
    const fm = parse(m[1]!) as unknown;
    return { fm: fm && typeof fm === "object" ? (fm as Record<string, unknown>) : {}, body: m[2]! };
  } catch {
    return { fm: {}, body: m[2]! };
  }
}
const fmText = (o: Record<string, unknown>) =>
  `---\n${stringify(o, { lineWidth: 0 }).trimEnd()}\n---\n`;

/** Plain files only: a link (to a file anywhere on this machine) is never followed or copied. */
async function filesUnder(dir: string, rel = "", links?: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) links?.push(r);
    else if (e.isDirectory()) out.push(...(await filesUnder(join(dir, e.name), r, links)));
    else if (e.isFile()) out.push(r);
  }
  return out.sort();
}

/** A tag or branch name, never an option git would read. */
export const REF = /^(?!.*(?:\.\.|\/\/|\.lock(?:\/|$)|\/$|\.$))[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/** Every skill, agent and instructions file the org pack keeps: the organisation's and imported. */
export async function sourcesOf(root: string): Promise<SourceItem[]> {
  const pack = orgPackDirOf(root);
  const rel = packRel(root);
  const out: SourceItem[] = [];
  const scan = async (sub: string, team?: string) => {
    // Skills: a folder with SKILL.md.
    const sk = join(pack, "skills", sub);
    for (const e of await readdir(sk, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory() || e.name === "imported") continue;
      const d = join(sk, e.name);
      const text = await readFile(join(d, "SKILL.md"), "utf8").catch(() => undefined);
      if (text === undefined) continue;
      const files = (await filesUnder(d)).filter((f) => f !== "SKILL.md");
      out.push({
        kind: "skill",
        name: e.name,
        source: `${rel}/skills/${sub ? `${sub}/` : ""}${e.name}`,
        ...(team ? { team } : {}),
        text,
        files: await Promise.all(
          files.map(async (f) => ({ path: f, text: await readFile(join(d, f), "utf8") })),
        ),
      });
    }
    for (const [kind, folder] of [
      ["agent", "agents"],
      ["instructions", "instructions"],
    ] as const) {
      const d = join(pack, folder, sub);
      for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
        if (!e.isFile() || !e.name.endsWith(".md")) continue;
        out.push({
          kind,
          name: e.name.slice(0, -3),
          source: `${rel}/${folder}/${sub ? `${sub}/` : ""}${e.name}`,
          ...(team ? { team } : {}),
          text: await readFile(join(d, e.name), "utf8"),
          files: [],
        });
      }
    }
  };
  await scan("");
  const teams = new Set<string>();
  for (const folder of ["skills", "agents", "instructions"])
    for (const e of await readdir(join(pack, folder, "imported"), { withFileTypes: true }).catch(
      () => [],
    ))
      if (e.isDirectory()) teams.add(e.name);
  for (const t of [...teams].sort()) await scan(`imported/${t}`, t);
  return out.sort((a, b) => (a.kind + a.name < b.kind + b.name ? -1 : 1));
}

/**
 * The frontmatter keys another team's file keeps: what describes it, and for an agent the keys
 * that can only narrow what it may do. None that gives it tools, hooks, permissions or a model
 * here (those are this organisation's to set, in its own files).
 */
const TEAM_KEYS: Record<Kind, ReadonlySet<string>> = {
  skill: new Set(["name", "description"]),
  agent: new Set(["name", "description", "tools", "disallowedTools"]),
  instructions: new Set(["name", "description"]),
};
/** An agent of another team's that names no tools reads only (Claude gives one with none all). */
const TEAM_AGENT_TOOLS = "Read, Grep, Glob";

/** Another team's frontmatter as written here, and the keys left out (said to the person). */
export function teamFrontmatter(
  kind: Kind,
  fm: Record<string, unknown>,
): { fm: Record<string, unknown>; dropped: string[]; readOnly: boolean } {
  const keep = TEAM_KEYS[kind];
  const out = Object.fromEntries(Object.entries(fm).filter(([k]) => keep.has(k)));
  const readOnly = kind === "agent" && out.tools === undefined;
  if (readOnly) out.tools = TEAM_AGENT_TOOLS;
  return { fm: out, dropped: Object.keys(fm).filter((k) => !keep.has(k)), readOnly };
}

/** What each assistant reads, written from one source item. */
export function outputsOf(i: SourceItem): { path: string; text: string }[] {
  const { fm: all, body } = splitFm(i.text);
  // Another team's file keeps only the keys that describe it: none that gives it tools, hooks,
  // permissions or a model here (those are this organisation's to set, in its own files).
  const fm = i.team ? teamFrontmatter(i.kind, all).fm : all;
  const description =
    typeof fm.description === "string" && fm.description.trim()
      ? fm.description.trim()
      : (body.split("\n").find((l) => l.trim() && !l.startsWith("#")) ?? i.name)
          .trim()
          .slice(0, 200);
  const from = i.team ? `${i.source} (${i.team})` : i.source;
  const h = sha(i.text + i.files.map((f) => f.path + f.text).join(""));
  const mark = MARK(from, h);
  switch (i.kind) {
    case "skill":
      return [
        {
          path: `.claude/skills/${i.name}/SKILL.md`,
          text: `${fmText({ ...fm, name: i.name, description })}${mark}\n${body}`,
        },
        ...i.files.map((f) => ({ path: `.claude/skills/${i.name}/${f.path}`, text: f.text })),
        {
          path: `.github/prompts/${i.name}.prompt.md`,
          text: `${fmText({ description, agent: "agent" })}${mark}\n${body}${i.files.length ? `\n\nThis skill's files are in \`.claude/skills/${i.name}/\`: ${i.files.map((f) => `\`${f.path}\``).join(", ")}.\n` : ""}`,
        },
      ];
    case "agent":
      return [
        {
          path: `.claude/agents/${i.name}.md`,
          text: `${fmText({ ...fm, name: i.name, description })}${mark}\n${body}`,
        },
        {
          path: `.github/agents/${i.name}.agent.md`,
          text: `${fmText({ name: i.name, description })}${mark}\n${body}`,
        },
      ];
    case "instructions":
      return [
        {
          path: `.github/instructions/${i.name}.instructions.md`,
          // Applied by itself only where its source says (`applyTo`): with none, a person attaches
          // it, so another team's words never reach a session (Atticus's own reads among them)
          // that didn't ask for them. Another team's never apply by themselves: a person attaches
          // them (their `applyTo` could reach every file, the reading sessions' too).
          text: `${fmText({ description, ...(typeof fm.applyTo === "string" && !i.team ? { applyTo: fm.applyTo } : {}) })}${mark}\n${body}`,
        },
      ];
  }
}

/** The CLAUDE.md block that imports every instructions file (Claude Code reads `@path` imports). */
export function claudeBlock(items: readonly SourceItem[]): string {
  const ins = items.filter((i) => i.kind === "instructions");
  if (!ins.length) return "";
  // The organisation's own are imported (Claude reads `@path`); another team's are listed for a
  // person to bring in when they want them, never loaded into every session by default.
  const own = ins.filter((i) => !i.team);
  const others = ins.filter((i) => i.team);
  return [
    "<!-- atticus:team-instructions:begin (written by atticus skills write; edit the sources in the org pack) -->",
    "## Team instructions",
    "",
    ...own.map((i) => `- @${i.source}`),
    ...(others.length
      ? [
          ...(own.length ? [""] : []),
          "Other teams' instructions, reviewed in the org pack; mention one to use it:",
          "",
          ...others.map((i) => `- \`${i.source}\` (from ${i.team})`),
        ]
      : []),
    "<!-- atticus:team-instructions:end -->",
  ].join("\n");
}

const STATE = (root: string) => join(orgPackDirOf(root), "skills", ".written.yaml");

/** What `write` would change: files to write, files kept because a person edited them. */
export async function planWrite(root: string): Promise<{
  write: { path: string; text: string }[];
  kept: string[];
  current: number;
  claude?: string;
}> {
  const items = await sourcesOf(root);
  const written =
    (
      (parse((await readFile(STATE(root), "utf8").catch(() => "")) || "{}") ?? {}) as {
        files?: Record<string, string>;
      }
    ).files ?? {};
  const write: { path: string; text: string }[] = [];
  const kept: string[] = [];
  let current = 0;
  for (const i of items)
    for (const o of outputsOf(i)) {
      const on = await readFile(join(root, ...o.path.split("/")), "utf8").catch(() => undefined);
      if (on === o.text) {
        current++;
        continue;
      }
      // Edited here since Atticus wrote it: kept, never lost on the next import.
      if (on !== undefined && written[o.path] && written[o.path] !== sha(on)) kept.push(o.path);
      else if (on !== undefined && !written[o.path]) kept.push(o.path);
      else write.push(o);
    }
  const block = claudeBlock(items);
  const claudePath = join(root, "CLAUDE.md");
  const claude = await readFile(claudePath, "utf8").catch(() => "");
  const re = /<!-- atticus:team-instructions:begin[\s\S]*?atticus:team-instructions:end -->/;
  const next = block
    ? re.test(claude)
      ? claude.replace(re, block)
      : `${claude.trimEnd()}${claude.trim() ? "\n\n" : ""}${block}\n`
    : claude.replace(re, "").trimEnd() + (claude.trim() ? "\n" : "");
  return { write, kept, current, ...(next !== claude ? { claude: next } : {}) };
}

/** atticus skills write [--check]: write what each assistant reads from the org pack's sources. */
export async function skillsWriteCommand(
  root: string,
  o: { check?: boolean },
  io: Output,
): Promise<number> {
  const p = await planWrite(root);
  if (o.check) {
    for (const f of p.write) io.out(`behind: ${f.path}`);
    if (p.claude) io.out("behind: CLAUDE.md (team instructions)");
    for (const k of p.kept) io.out(`edited here, kept: ${k}`);
    const behind = p.write.length + (p.claude ? 1 : 0);
    io.out(
      behind
        ? `${behind} files are behind the org pack: atticus skills write`
        : "The skills, agents and instructions written are current.",
    );
    return behind ? 1 : 0;
  }
  const state =
    (
      (parse((await readFile(STATE(root), "utf8").catch(() => "")) || "{}") ?? {}) as {
        files?: Record<string, string>;
      }
    ).files ?? {};
  for (const f of p.write) {
    await mkdir(dirname(join(root, ...f.path.split("/"))), { recursive: true });
    await writeFileAtomic(join(root, ...f.path.split("/")), f.text);
    state[f.path] = sha(f.text);
    io.out(`wrote ${f.path}`);
  }
  if (p.claude !== undefined) {
    await writeFileAtomic(join(root, "CLAUDE.md"), p.claude);
    io.out("wrote CLAUDE.md (team instructions)");
  }
  for (const k of p.kept)
    io.out(`kept ${k}: it was edited here; remove it to have it written again`);
  await mkdir(dirname(STATE(root)), { recursive: true });
  await writeFileAtomic(
    STATE(root),
    stringify({ schemaVersion: 1, files: Object.fromEntries(Object.entries(state).sort()) }),
  );
  io.out(`${p.write.length} written, ${p.current} current, ${p.kept.length} kept as edited.`);
  return 0;
}

/** A note for the reviewer: a skill that states estate facts with no command to get them. */
export function factsWithoutSource(text: string): boolean {
  const claims = /\b(topic|queue|schema|endpoint|field|payload|contract|route)s?\b/i.test(text);
  const grounded =
    /\batticus (ask|query|guide|show|contracts|flows|map|catalog)\b|\/atticus-/i.test(text);
  return claims && !grounded;
}

/** The kinds of file a team repo keeps its skills, agents and instructions in. */
/** Whether a path, every link on the way resolved, is inside their repo. */
export function inside(dir: string, rel: string): boolean {
  try {
    const top = realpathSync(dir);
    const p = realpathSync(join(dir, ...rel.split("/")));
    return p === top || p.startsWith(top + sep);
  } catch {
    return false;
  }
}

async function theirs(
  dir: string,
): Promise<{ kind: Kind; name: string; path: string; folder?: string }[]> {
  const out: { kind: Kind; name: string; path: string; folder?: string }[] = [];
  // Present and a plain file: a link to a file elsewhere on this machine is never taken.
  const has = (p: string) => {
    try {
      return lstatSync(join(dir, ...p.split("/"))).isFile();
    } catch {
      return false;
    }
  };
  for (const base of [".claude/skills", "org-pack/skills"])
    for (const e of await readdir(join(dir, ...base.split("/")), { withFileTypes: true }).catch(
      () => [],
    ))
      if (e.isDirectory() && e.name !== "imported" && has(`${base}/${e.name}/SKILL.md`))
        out.push({
          kind: "skill",
          name: e.name,
          path: `${base}/${e.name}/SKILL.md`,
          folder: `${base}/${e.name}`,
        });
  for (const [base, suffix] of [
    [".claude/agents", ".md"],
    ["org-pack/agents", ".md"],
    [".github/agents", ".agent.md"],
    [".github/chatmodes", ".chatmode.md"],
  ] as const)
    for (const e of await readdir(join(dir, ...base.split("/")), { withFileTypes: true }).catch(
      () => [],
    ))
      if (e.isFile() && e.name.endsWith(suffix))
        out.push({
          kind: "agent",
          name: e.name.slice(0, -suffix.length),
          path: `${base}/${e.name}`,
        });
  for (const [base, suffix] of [
    [".github/instructions", ".instructions.md"],
    ["org-pack/instructions", ".md"],
  ] as const)
    for (const e of await readdir(join(dir, ...base.split("/")), { withFileTypes: true }).catch(
      () => [],
    ))
      if (e.isFile() && e.name.endsWith(suffix))
        out.push({
          kind: "instructions",
          name: e.name.slice(0, -suffix.length),
          path: `${base}/${e.name}`,
        });
  // The same name kept twice (for Claude and for Copilot) is one: the first found.
  const seen = new Set<string>();
  // A folder linked to somewhere else on this machine is never read: only what is in their repo.
  return out.filter(
    (x) =>
      inside(dir, x.folder ?? x.path) &&
      !seen.has(`${x.kind}:${x.name}`) &&
      !!seen.add(`${x.kind}:${x.name}`),
  );
}

/**
 * atticus skills import <their repo> --team <team> [--at <tag>] [--only a,b]: a pinned copy of
 * another team's skills, agents and instructions in the org pack, with where it came from; then
 * writes them for Claude and Copilot. A file edited here since the last import is kept, said.
 */
export async function skillsImportCommand(
  root: string,
  from: string | undefined,
  o: { team?: string; at?: string; only?: string; replace?: boolean },
  io: Output,
): Promise<number> {
  if (!from || !o.team) {
    io.err(
      "Usage: atticus skills import <their repo folder> --team <their team> [--at <tag>] [--only <names>]",
    );
    return 2;
  }
  if (!NAME.test(o.team)) {
    io.err("--team is lower case, digits and dashes.");
    return 2;
  }
  if (o.at !== undefined && !REF.test(o.at)) {
    io.err(`${o.at} isn't a tag or branch name.`);
    return 2;
  }
  // A tag pins it: their files as that tag has them, read from a worktree of their repo's own history.
  let dir = from;
  let tmp: string | undefined;
  if (o.at) {
    tmp = join(tmpdir(), `atticus-import-${o.team}-${Date.now()}`);
    try {
      await mkdir(dirname(tmp), { recursive: true });
      // Their clone's hooks don't run here: a checkout reads files only.
      await run("git", [
        "-C",
        from,
        "-c",
        `core.hooksPath=${tmp}.no-hooks`,
        "worktree",
        "add",
        "--detach",
        "--",
        tmp,
        `${o.at}^{commit}`,
      ]);
      dir = tmp;
    } catch (e) {
      io.err(`${from} has no ${o.at}: ${(e as Error).message.split("\n")[0]}`);
      return 2;
    }
  }
  try {
    const only = o.only ? new Set(o.only.split(",").map((x) => x.trim())) : undefined;
    const found = (await theirs(dir)).filter((x) => !only || only.has(x.name));
    if (!found.length) {
      io.err(
        `${from} has no skills (.claude/skills/<name>/SKILL.md), agents or instructions${only ? ` named ${[...only].join(", ")}` : ""}.`,
      );
      return 2;
    }
    const pack = orgPackDirOf(root);
    const provPath = join(pack, "imported", `${o.team}.yaml`);
    const prov = (parse((await readFile(provPath, "utf8").catch(() => "")) || "{}") ?? {}) as {
      items?: { kind: Kind; name: string; files: Record<string, string> }[];
    };
    const was = new Map((prov.items ?? []).map((x) => [`${x.kind}:${x.name}`, x.files] as const));
    // Each item says where and at what it came from (an import of some keeps the rest's).
    const items: {
      kind: Kind;
      name: string;
      files: Record<string, string>;
      from?: string;
      at?: string;
    }[] = [];
    const origin = await originOf(from, (a) => run("git", a));
    const notes: string[] = [];
    for (const f of found) {
      if (!NAME.test(f.name)) {
        notes.push(
          `skipped ${f.path}: ${f.name} isn't a name Atticus writes (lower case, digits, dashes)`,
        );
        continue;
      }
      const dest =
        f.kind === "skill"
          ? join(pack, "skills", "imported", o.team, f.name)
          : join(pack, f.kind === "agent" ? "agents" : "instructions", "imported", o.team);
      const files: Record<string, string> = {};
      const copy = async (src: string, to: string, key: string) => {
        if (!inside(dir, src)) {
          notes.push(`left out ${src}: it isn't in their repo (a link to somewhere else)`);
          return;
        }
        const text = await readFile(join(dir, ...src.split("/")), "utf8");
        const on = await readFile(to, "utf8").catch(() => undefined);
        const before = was.get(`${f.kind}:${f.name}`)?.[key];
        // Edited here since the last import: kept, never lost.
        if (
          on !== undefined &&
          before &&
          sha(on) !== before &&
          sha(on) !== sha(text) &&
          !o.replace
        ) {
          notes.push(
            `kept ${to.slice(root.length + 1)}: edited here since the last import (--replace takes theirs)`,
          );
          // Their last import's hash stays the one on record, so the edit is kept next time too.
          files[key] = before;
          return;
        }
        await mkdir(dirname(to), { recursive: true });
        await writeFileAtomic(to, text);
        files[key] = sha(text);
      };
      if (f.kind === "skill") {
        const links: string[] = [];
        const all = await filesUnder(join(dir, ...f.folder!.split("/")), "", links);
        if (links.length)
          notes.push(
            `${f.name}: left out ${links.join(", ")}: a link to a file elsewhere is never copied`,
          );
        for (const p of all) await copy(`${f.folder}/${p}`, join(dest, ...p.split("/")), p);
        const scripts = all.filter((p) => !/\.(md|txt|ya?ml|json)$/i.test(p));
        if (scripts.length)
          notes.push(
            `${f.name} carries files that may run (${scripts.join(", ")}): review them in the PR; nothing ran here`,
          );
        const skillText = await readFile(join(dest, "SKILL.md"), "utf8");
        if (factsWithoutSource(skillText))
          notes.push(
            `${f.name} states things about the estate (topics, fields, routes) with no atticus command to get them: a reviewer checks it against the map`,
          );
      } else await copy(f.path, join(dest, `${f.name}.md`), `${f.name}.md`);
      // What of their frontmatter is left out when it is written for the assistants here.
      const mainFile = f.kind === "skill" ? join(dest, "SKILL.md") : join(dest, `${f.name}.md`);
      const t = teamFrontmatter(
        f.kind,
        splitFm(await readFile(mainFile, "utf8").catch(() => "")).fm,
      );
      if (t.dropped.length)
        notes.push(
          `${f.name}: left out of what the assistants read: ${t.dropped.join(", ")} (another team's file can't give itself these here; set them in your own copy if you want them)`,
        );
      if (t.readOnly)
        notes.push(`${f.name} names no tools, so it is written to read only (${TEAM_AGENT_TOOLS})`);
      items.push({ kind: f.kind, name: f.name, files, from: origin, at: o.at ?? "working copy" });
    }
    await mkdir(dirname(provPath), { recursive: true });
    await writeFileAtomic(
      provPath,
      stringify({
        schemaVersion: 1,
        team: o.team,
        // Where it came from, as the metarepo sees it (no one's home folder in a committed file).
        from: origin,
        at: o.at ?? "working copy",
        // An import of some (--only) keeps the record of the rest.
        items: [
          ...(prov.items ?? []).filter(
            (x) => !items.some((y) => y.kind === x.kind && y.name === x.name),
          ),
          ...items,
        ].sort((a, b) => `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`)),
      }),
    );
    io.out(
      `Imported ${items.length} from ${o.team}${o.at ? ` at ${o.at}` : ""} into ${packRel(root)}/{skills,agents,instructions}/imported/${o.team}/, provenance in ${packRel(root)}/imported/${o.team}.yaml.`,
    );
    for (const n of notes) io.out(`  ${n}`);
    // Written for the assistants only after review: a person runs atticus skills write.
    io.out(
      "Review the copy in a pull request; then atticus skills write puts it where Claude and Copilot read it.",
    );
    return 0;
  } finally {
    if (tmp) {
      await run("git", ["-C", from, "worktree", "remove", "--force", tmp]).catch(() => undefined);
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** atticus skills list: what the org pack keeps and where each is written. */
export async function skillsListCommand(
  root: string,
  o: { json?: boolean },
  io: Output,
): Promise<number> {
  const items = await sourcesOf(root);
  if (o.json) {
    io.out(
      JSON.stringify(
        items.map((i) => ({
          kind: i.kind,
          name: i.name,
          source: i.source,
          team: i.team,
          writes: outputsOf(i).map((x) => x.path),
        })),
        null,
        2,
      ),
    );
    return 0;
  }
  if (!items.length) {
    io.out(
      `No skills, agents or instructions in ${packRel(root)} yet. Take another team's: atticus skills import <their repo> --team <team> --at <tag>.`,
    );
    return 0;
  }
  for (const i of items)
    io.out(
      `${i.kind} ${i.name}${i.team ? ` (from ${i.team})` : ""}: ${i.source} → ${outputsOf(i)
        .filter((x) => !x.path.includes("/" + i.name + "/") || x.path.endsWith("SKILL.md"))
        .map((x) => x.path)
        .join(", ")}`,
    );
  return 0;
}
