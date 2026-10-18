import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import { loadOrgPack, RecordId, type Sources } from "@maycombhq/core";
import type { GitRunner } from "@maycombhq/workspace";
import type { z } from "zod";
import { AdoptError } from "../errors.js";
import { isDir, listFiles, slug, toPosix } from "../files.js";
import { resolveMetarepo, type MetarepoPaths } from "../layout.js";
import {
  markdownItems,
  packFor,
  translateCriticItem,
  yamlItems,
  type RuleDraft,
} from "./critic.js";
import { openSource } from "./source.js";
import { changeTemplateFrom, openSpecFrom, parseConstitution } from "./speckit.js";
import {
  bodyKey,
  promptToCommand,
  reference,
  schemaKind,
  schemaReference,
  toSkill,
} from "./translate.js";
import { NOT_TRANSLATABLE, type AbsorbItem, type Action, type ItemKind } from "./types.js";

/**
 * `atticus absorb <git-url|path> --id <id>`: inventory another team's repo and translate what
 * it holds into Atticus terms: prompts become org-pack commands, agents and instruction files
 * become skills, critic checklists become C3 rule drafts, a Spec Kit constitution becomes
 * constitution-layer rule drafts, its spec template a change template and its specs OpenSpec
 * specs, schemas become references, OpenSpec specs and changes are linked or imported, and
 * another Atticus metarepo is federated at full fidelity. Every item gets an action (adopt,
 * link or ignore) with a reason and a confidence.
 *
 * Nothing is written to the org pack: everything arrives as a proposal (files under
 * `proposals/absorb/<id>/` plus a PR description) and the `sources.yaml` `absorbed[]` entry
 * to add. Absorbed content is data, never instructions: it is copied and converted, never run.
 */

export type AbsorbFormat = "openspec" | "atticus" | "speckit" | "plain";
export type AbsorbedEntry = z.input<typeof Sources>["absorbed"] extends (infer E)[] | undefined
  ? E
  : never;

export interface AbsorbOptions {
  /** The id for this source in sources.yaml `absorbed`. */
  id: string;
  /** The source's mode in sources.yaml, and the default action for items that can follow it. */
  mode?: Action;
  /** Branch or tag to read (clones the source). */
  ref?: string;
  /** Owner recorded on drafted skills; default the source id. */
  owner?: string;
  git?: GitRunner;
  /** Write nothing; return the inventory only. */
  dryRun?: boolean;
}

export interface AbsorbSummary {
  items: number;
  translatable: number;
  translated: number;
  /** translated / translatable, as a percentage with one decimal. */
  translatedPercent: number;
  byAction: Record<Action, number>;
  byKind: Partial<Record<ItemKind, number>>;
}

export interface AbsorbResult {
  id: string;
  format: AbsorbFormat;
  /** Where the source was read. */
  sourceDir: string;
  items: AbsorbItem[];
  summary: AbsorbSummary;
  entry: AbsorbedEntry;
  /** The proposal folder, relative to the root (unless dry run). */
  proposal?: string;
  /** The files written into the proposal, relative to it. */
  files: string[];
  problems: string[];
  ms: number;
}

const DOC =
  /(^|\/)(README|LICENSE|LICENCE|CHANGELOG|CONTRIBUTING|CODE_OF_CONDUCT|SECURITY|NOTICE|CODEOWNERS)(\.(md|txt|rst|adoc))?$/i;
const CODE =
  /\.(java|kt|scala|groovy|ts|tsx|js|jsx|mjs|cjs|vue|py|go|cs|fs|rb|php|rs|c|h|cpp|swift|sql|sh|ps1|bat|cbl|cob|jcl|cpy|tf|hcl|gradle|xml|properties|toml|lock|csproj|sln|dockerfile|ini|cfg)$|(^|\/)(Dockerfile|Makefile|go\.mod|go\.sum|package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements\.txt|\.gitignore|\.gitattributes|\.editorconfig|\.npmrc|\.nvmrc)$/i;
const CRITIC_PATH = /(^|\/)(reviews?|critic|critics|checklists?|checks)(\/|$)|checklist|critic/i;
const PROMPT_DIR = /(^|\/)\.?prompts\//i;

async function formatOf(
  dir: string,
): Promise<{ format: AbsorbFormat; orgPack?: string; openspec?: string }> {
  if (await isDir(join(dir, "org-pack"))) return { format: "atticus", orgPack: "org-pack" };
  if (await isDir(join(dir, ".atticus", "org-pack")))
    return { format: "atticus", orgPack: ".atticus/org-pack" };
  if (await isDir(join(dir, "openspec"))) return { format: "openspec", openspec: "openspec" };
  if (await isDir(join(dir, ".specify"))) return { format: "speckit" };
  return { format: "plain" };
}

export async function absorb(
  root: string,
  source: string,
  o: AbsorbOptions,
  paths?: MetarepoPaths,
): Promise<AbsorbResult> {
  const t0 = performance.now();
  if (!RecordId.safeParse(o.id).success)
    throw new AdoptError(
      "usage",
      `"${o.id}" can't be an absorbed id; use a lowercase slug such as payments-team.`,
    );
  const p = paths ?? (await resolveMetarepo(root));
  const opened = await openSource(source, {
    root,
    stateDir: p.stateDir,
    id: o.id,
    ...(o.ref ? { ref: o.ref } : {}),
    ...(o.git ? { git: o.git } : {}),
  });
  const dir = opened.dir;
  const fmt = await formatOf(dir);
  // A metarepo adopted in place keeps its own openspec where its layout says.
  if (fmt.format === "atticus" && fmt.orgPack) {
    const theirs = await loadOrgPack(join(dir, ...fmt.orgPack.split("/")));
    fmt.openspec = theirs.sources.layout.openspec;
  }
  const files = await listFiles(dir, { skipNames: new Set([".git", "node_modules"]) });
  const read = async (f: string) => (await readFile(join(dir, f), "utf8")).replace(/\r\n/g, "\n");

  const items: AbsorbItem[] = [];
  const problems: string[] = [];
  const claimed = new Set<string>();
  const prefix = o.id;
  const owner = o.owner ?? o.id;
  const usedRuleIds = new Set<string>();
  /** Critic drafts per proposal pack path, for the pack files. */
  const packs = new Map<
    string,
    { name: string; description: string; drafts: RuleDraft[]; items: AbsorbItem[] }
  >();
  const add = (i: AbsorbItem) => items.push(i);
  const claim = (f: string) => claimed.add(f);

  // ---------------------------------------------------------------- another Atticus metarepo
  if (fmt.format === "atticus") {
    const op = fmt.orgPack!;
    const theirs = await loadOrgPack(join(dir, ...op.split("/")));
    const bad = new Set(theirs.problems.map((x) => x.file));
    for (const x of theirs.problems)
      problems.push(`${op}/${x.file}: ${x.path ? `${x.path}: ` : ""}${x.message}`);
    const adoptable = /^(checklists|patterns|dialects|agents|process)\//;
    for (const f of files.filter((f) => f.startsWith(`${op}/`))) {
      claim(f);
      const rel = f.slice(op.length + 1);
      add({
        id: `atticus-orgpack:${f}`,
        kind: "atticus-orgpack",
        path: f,
        title: rel,
        action: "link",
        reason: adoptable.test(rel)
          ? "Their org-pack file, read as it is (federation keeps full fidelity); adopt to own a copy."
          : "Part of their org pack's identity (pack, roles, profiles, sources): read for federation, never copied.",
        confidence: bad.has(rel) ? "medium" : "high",
        translated: true,
        ...(adoptable.test(rel)
          ? { artifact: { path: `org-pack/${rel}`, content: await read(f) } }
          : {}),
      });
    }
    const catalogRel = theirs.sources.layout.catalog;
    const cat = files.filter((f) => f.startsWith(`${catalogRel}/`));
    if (cat.length) {
      cat.forEach(claim);
      const kinds = new Map<string, number>();
      for (const f of cat.filter((f) => f.startsWith(`${catalogRel}/generated/`))) {
        const k = f.split("/")[catalogRel.split("/").length + 1] ?? "other";
        kinds.set(k, (kinds.get(k) ?? 0) + 1);
      }
      const n = [...kinds.values()].reduce((a, b) => a + b, 0);
      add({
        id: `atticus-catalog:${catalogRel}`,
        kind: "atticus-catalog",
        path: catalogRel,
        title: `${n} catalog records (${[...kinds.entries()].map(([k, v]) => `${v} ${k}`).join(", ")})`,
        action: "link",
        reason:
          "Federated at full fidelity: every scan adds their records with their origin kept, and local code wins.",
        confidence: "high",
        translated: true,
      });
    }
    const os = fmt.openspec ?? "openspec";
    const changeDirs = new Set(
      files
        .filter((f) => f.startsWith(`${os}/changes/`) && f.endsWith("/change.yaml"))
        .map((f) => dirname(f)),
    );
    for (const cd of [...changeDirs].sort()) {
      const inside = files.filter((f) => f.startsWith(`${cd}/`));
      inside.forEach(claim);
      add({
        id: `atticus-change:${cd}`,
        kind: "atticus-change",
        path: cd,
        title: cd.split("/").pop()!,
        action: "link",
        reason: cd.includes("/archive/")
          ? "An archived change: history, read only."
          : "Their open change: visible read-only for conflict detection with ours.",
        confidence: "high",
        translated: true,
      });
    }
  }

  // ---------------------------------------------------------------- OpenSpec
  const os =
    fmt.openspec ?? (files.some((f) => f.startsWith("openspec/")) ? "openspec" : undefined);
  if (os) {
    for (const f of files.filter(
      (f) => !claimed.has(f) && f.startsWith(`${os}/specs/`) && f.endsWith("/spec.md"),
    )) {
      claim(f);
      const cap = f.split("/").slice(-2)[0]!;
      add({
        id: `openspec-spec:${f}`,
        kind: "openspec-spec",
        path: f,
        title: `Living spec ${cap}`,
        action: o.mode === "adopt" ? "adopt" : "link",
        reason:
          o.mode === "adopt"
            ? "Imported once into our openspec/specs (already OpenSpec: no conversion)."
            : "Followed as their living spec; adopt to import it into ours.",
        confidence: "high",
        translated: true,
        artifact: {
          path:
            o.mode === "adopt"
              ? `openspec/specs/${prefix}-${cap}/spec.md`
              : `references/openspec/${prefix}-${cap}.md`,
          content: await read(f),
        },
      });
    }
    const changeDirs = new Set(
      files
        .filter((f) => !claimed.has(f) && f.startsWith(`${os}/changes/`))
        .map((f) => f.slice(`${os}/changes/`.length).split("/"))
        .filter((s) => s.length > 1 && s[0] !== "archive")
        .map((s) => `${os}/changes/${s[0]}`),
    );
    for (const cd of [...changeDirs].sort()) {
      const inside = files.filter((f) => f.startsWith(`${cd}/`));
      inside.forEach(claim);
      const proposal = inside.includes(`${cd}/proposal.md`) ? await read(`${cd}/proposal.md`) : "";
      const title = /^#\s+(.+)$/m.exec(proposal)?.[1]?.trim() ?? cd.split("/").pop()!;
      add({
        id: `openspec-change:${cd}`,
        kind: "openspec-change",
        path: cd,
        title,
        action: "link",
        reason:
          "Their change in progress: followed read-only so overlaps with our changes show up.",
        confidence: "high",
        translated: true,
        artifact: {
          path: `references/openspec-changes/${prefix}-${cd.split("/").pop()}.yaml`,
          content: stringify(
            {
              change: cd.split("/").pop(),
              title,
              files: inside.map((f) => f.slice(cd.length + 1)),
            },
            { lineWidth: 0 },
          ),
        },
      });
    }
    for (const f of files.filter((f) => !claimed.has(f) && f.startsWith(`${os}/`))) {
      claim(f);
      add({
        id: `openspec-config:${f}`,
        kind: "openspec-config",
        path: f,
        title: f.slice(os.length + 1),
        action: /\/(archive)\//.test(f) ? "ignore" : "link",
        reason: /\/schemas\//.test(f)
          ? "Their OpenSpec workflow schema: Atticus keeps its own org-flow schema; kept as a reference."
          : /\/archive\//.test(f)
            ? "An archived change: history only."
            : "OpenSpec project context, kept as a reference.",
        confidence: "high",
        translated: true,
        artifact: reference(
          "openspec",
          f,
          prefix,
          "OpenSpec configuration or context of the absorbed repo.",
        ),
      });
    }
  }

  // ---------------------------------------------------------------- Spec Kit
  for (const f of files.filter((f) => !claimed.has(f) && f.startsWith(".specify/"))) {
    claim(f);
    if (f.endsWith("memory/constitution.md")) {
      const c = parseConstitution(await read(f));
      if (c.generatedByAtticus) {
        add({
          id: `constitution-principle:${f}`,
          kind: "constitution-principle",
          path: f,
          title: "Constitution generated by Atticus",
          action: "ignore",
          reason: "Generated by Atticus's own hand-down from an org pack: nothing new to absorb.",
          confidence: "high",
          translated: true,
          sameAs: "the Atticus constitution",
        });
        continue;
      }
      const packPath = `org-pack/checklists/${prefix}-constitution.yaml`;
      const pack = {
        name: `${prefix}-constitution`,
        description: `Constitution principles absorbed from ${prefix} (Spec Kit).`,
        drafts: [] as RuleDraft[],
        items: [] as AbsorbItem[],
      };
      packs.set(packPath, pack);
      c.principles.forEach((pr, n) => {
        const draft = translateCriticItem(
          {
            text: `${pr.title}: ${pr.body.split("\n").join(" ")}`,
            line: pr.line,
            ...(pr.nonNegotiable ? { severity: "blocking" } : {}),
            sourceId: pr.title,
          },
          { prefix, source: `${prefix}:${f}`, layer: "constitution", usedIds: usedRuleIds },
        );
        draft.rule.title = pr.title;
        draft.rule.description = pr.body.replace(/\s+/g, " ").trim();
        const item: AbsorbItem = {
          id: `constitution-principle:${f}#${n + 1}`,
          kind: "constitution-principle",
          path: f,
          line: pr.line,
          title: pr.title,
          action: o.mode === "link" || o.mode === "ignore" ? o.mode : "adopt",
          reason: draft.deterministic
            ? `A constitution-layer rule run by the built-in check ${(draft.rule.check as { check: string }).check}; never waived.`
            : "A constitution-layer rule with an AI check (its words are the prompt); never waived.",
          confidence: draft.problems.length ? "low" : draft.deterministic ? "high" : "medium",
          translated: draft.problems.length === 0,
          artifact: { path: packPath, content: stringify(draft.rule, { lineWidth: 0 }) },
        };
        if (draft.problems.length)
          problems.push(`${f} principle ${pr.title}: ${draft.problems.join("; ")}`);
        pack.drafts.push(draft);
        pack.items.push(item);
        add(item);
      });
      for (const s of c.sections) {
        const governance = /governance/i.test(s.title);
        if (governance) {
          add({
            id: `constitution-principle:${f}#${slug(s.title)}`,
            kind: "constitution-principle",
            path: f,
            line: s.line,
            title: s.title,
            action: "ignore",
            reason:
              "Atticus's governance applies instead: constitution rules are never waived, tightened only, and changed by PR to the org pack.",
            confidence: "high",
            translated: true,
            sameAs: "Atticus constitution governance",
          });
          continue;
        }
        const draft = translateCriticItem(
          { text: `${s.title}: ${s.body.split("\n").join(" ")}`, line: s.line, sourceId: s.title },
          { prefix, source: `${prefix}:${f}`, layer: "constitution", usedIds: usedRuleIds },
        );
        draft.rule.title = s.title;
        draft.rule.severity = "risk";
        const item: AbsorbItem = {
          id: `constitution-principle:${f}#${slug(s.title)}`,
          kind: "constitution-principle",
          path: f,
          line: s.line,
          title: s.title,
          action: o.mode === "link" || o.mode === "ignore" ? o.mode : "adopt",
          reason:
            "Extra constraints in the constitution, as a constitution-layer risk rule with an AI check.",
          confidence: "medium",
          translated: true,
          artifact: { path: packPath, content: stringify(draft.rule, { lineWidth: 0 }) },
        };
        pack.drafts.push(draft);
        pack.items.push(item);
        add(item);
      }
      continue;
    }
    if (f.startsWith(".specify/templates/")) {
      const base = f.split("/").pop()!.replace(/\.md$/, "");
      if (/^spec-template$/.test(base)) {
        const id = slug(`${prefix}-spec`);
        add({
          id: `speckit-template:${f}`,
          kind: "speckit-template",
          path: f,
          title: "Spec Kit feature spec template",
          action: o.mode === "link" || o.mode === "ignore" ? o.mode : "adopt",
          reason: "Becomes an org-pack change template: a brief skeleton with the same sections.",
          confidence: "medium",
          translated: true,
          artifact: {
            path: `org-pack/process/change-templates/${id}.md`,
            content: changeTemplateFrom(id, `${prefix} feature spec`, await read(f)),
          },
        });
      } else
        add({
          id: `speckit-template:${f}`,
          kind: "speckit-template",
          path: f,
          title: `Spec Kit ${base}`,
          action: o.mode === "ignore" ? "ignore" : "link",
          reason:
            "Atticus hands down plan.md and tasks.md itself; their template is kept as a reference for the build skill.",
          confidence: "high",
          translated: true,
          artifact: reference(
            "speckit-templates",
            f,
            prefix,
            "A Spec Kit template of the absorbed repo.",
          ),
        });
      continue;
    }
    add({
      id: `speckit-script:${f}`,
      kind: "speckit-script",
      path: f,
      title: f,
      action: "ignore",
      reason:
        "Spec Kit's own machinery: Atticus installs the pinned Spec Kit files through assistant files.",
      confidence: "high",
      translated: true,
      sameAs: "Atticus Spec Kit adapter files",
    });
  }
  const speckitSpecs = files.filter((f) => !claimed.has(f) && /^specs\/[^/]+\//.test(f));
  if (
    speckitSpecs.length &&
    (fmt.format === "speckit" || files.some((f) => f.startsWith(".specify/")))
  ) {
    for (const f of speckitSpecs) {
      const feature = f.split("/")[1]!;
      const name = f.split("/").slice(2).join("/");
      if (name === "spec.md") {
        claim(f);
        const conv = openSpecFrom(feature, await read(f));
        const adopt = o.mode === "adopt";
        add({
          id: `speckit-spec:${f}`,
          kind: "speckit-spec",
          path: f,
          title: `Feature spec ${feature}`,
          action: adopt ? "adopt" : o.mode === "ignore" ? "ignore" : "link",
          reason: adopt
            ? `One-off import into our OpenSpec living specs (${conv.requirements} requirements).`
            : "A read-only reference: the speckit extractor reads it on every scan; adopt to import it into OpenSpec.",
          confidence: conv.requirements ? "high" : "low",
          translated: conv.requirements > 0,
          artifact: {
            path: adopt
              ? `openspec/specs/${prefix}-${feature}/spec.md`
              : `references/specs/${prefix}-${feature}.md`,
            content: conv.spec,
          },
        });
      } else if (/^(plan|tasks|research|quickstart|data-model)\.md$/.test(name)) {
        claim(f);
        add({
          id: `speckit-plan:${f}`,
          kind: "speckit-plan",
          path: f,
          title: `${feature} ${name}`,
          action: o.mode === "ignore" ? "ignore" : "link",
          reason:
            "Repo-level plan: the speckit extractor reads it as planned records and progress when the repo is scanned.",
          confidence: "high",
          translated: true,
          artifact: reference(
            "speckit-plans",
            f,
            prefix,
            "Read by the speckit extractor when the repo is in a manifest.",
          ),
        });
      }
    }
  }

  // ---------------------------------------------------------------- prompts, agents, skills
  const seen = new Map<string, string>();
  const dup = (text: string, id: string): string | undefined => {
    const k = bodyKey(text);
    const other = seen.get(k);
    if (!other) seen.set(k, id);
    return other;
  };
  const isSpecKitCommand = (f: string) => /(^|\/)speckit\.[a-z-]+(\.prompt|\.agent)?\.md$/i.test(f);
  for (const f of files.filter((f) => !claimed.has(f))) {
    const prompt =
      /^\.github\/prompts\/.+\.prompt\.md$/i.test(f) ||
      /^\.claude\/commands\/.+\.md$/i.test(f) ||
      (PROMPT_DIR.test(f) && /\.md$/i.test(f) && !DOC.test(f));
    const agent =
      /^\.github\/agents\/.+\.agent\.md$/i.test(f) ||
      /^\.github\/chatmodes\/.+\.chatmode\.md$/i.test(f) ||
      /^\.claude\/agents\/.+\.md$/i.test(f);
    const skill =
      /^\.claude\/skills\/.+\/SKILL\.md$/.test(f) ||
      /^\.github\/instructions\/.+\.instructions\.md$/i.test(f);
    const instructions = /^(CLAUDE\.md|AGENTS\.md|\.github\/copilot-instructions\.md)$/.test(f);
    if (!prompt && !agent && !skill && !instructions) continue;
    claim(f);
    const text = await read(f);
    if (isSpecKitCommand(f)) {
      add({
        id: `speckit-command:${f}`,
        kind: "speckit-command",
        path: f,
        title: f.split("/").pop()!,
        action: "ignore",
        reason: "A Spec Kit command: Atticus generates the Spec Kit-compatible commands itself.",
        confidence: "high",
        translated: true,
        sameAs: "Atticus Spec Kit commands",
      });
      continue;
    }
    const id = `${prompt ? "prompt" : agent ? "agent" : skill ? "skill" : "instructions"}:${f}`;
    const same = dup(text, id);
    if (prompt) {
      const t = promptToCommand(f, text, prefix);
      add({
        id,
        kind: "prompt",
        path: f,
        title: t.title,
        action: same ? "ignore" : o.mode === "link" || o.mode === "ignore" ? o.mode : "adopt",
        reason: same
          ? `The same prompt as ${same.split(":").slice(1).join(":")} (one command serves both assistants).`
          : "Becomes an org-pack command, generated for Copilot and Claude Code from one source.",
        confidence: t.confidence,
        translated: true,
        artifact: { path: t.path, content: t.content },
        ...(same ? { sameAs: same } : {}),
      });
      continue;
    }
    const s = toSkill(f, text, {
      prefix,
      owner,
      source: `${prefix}:${f}`,
      kind: agent ? "agent" : skill ? "skill" : "instructions",
    });
    if (s.problems.length) problems.push(`${f}: ${s.problems.join("; ")}`);
    add({
      id,
      kind: agent ? "agent" : skill ? "skill" : "instructions",
      path: f,
      title: s.title,
      action: same
        ? "ignore"
        : instructions
          ? o.mode === "ignore"
            ? "ignore"
            : o.mode === "adopt"
              ? "adopt"
              : "link"
          : o.mode === "link" || o.mode === "ignore"
            ? o.mode
            : "adopt",
      reason: same
        ? `The same text as ${same.split(":").slice(1).join(":")}.`
        : instructions
          ? "Their standing instructions, as a draft skill: linked (they describe their repo), adopt to make them an org skill."
          : "Becomes an org-pack skill (one source for Copilot instructions and Claude Code skills).",
      confidence: s.problems.length ? "low" : s.confidence,
      translated: s.problems.length === 0,
      artifact: { path: s.path, content: s.content },
      ...(same ? { sameAs: same } : {}),
    });
  }

  // ---------------------------------------------------------------- schemas
  for (const f of files.filter((f) => !claimed.has(f))) {
    const text = /\.(ya?ml|json)$/i.test(f) ? await read(f) : "";
    const kind = text ? schemaKind(f, text) : undefined;
    if (!kind) continue;
    claim(f);
    const t = schemaReference(f, text, kind, prefix);
    const adopt = o.mode === "adopt";
    add({
      id: `schema:${f}`,
      kind: "schema",
      path: f,
      title: `${t.title} (${kind})`,
      action: adopt ? "adopt" : o.mode === "ignore" ? "ignore" : "link",
      reason: adopt
        ? "Copied into inputs/specs/ so intake reads it on every scan."
        : "Kept as a reference; copy it into inputs/specs/ (adopt) for intake to read it.",
      confidence: "high",
      translated: true,
      artifact: adopt
        ? { path: `inputs/specs/${prefix}/${f}`, content: text }
        : { path: t.path, content: t.content },
    });
  }

  // ---------------------------------------------------------------- critic definitions
  for (const f of files.filter((f) => !claimed.has(f) && CRITIC_PATH.test(f) && !DOC.test(f))) {
    const text = await read(f);
    const list = /\.ya?ml$/i.test(f)
      ? yamlItems(text)
      : /\.md$/i.test(f)
        ? markdownItems(text)
        : undefined;
    if (!list || list.length < 2) continue;
    claim(f);
    const fileSlug = slug(
      f
        .replace(/\.[a-z]+$/i, "")
        .split("/")
        .pop()!,
    );
    const packPath = `org-pack/checklists/${prefix}-${fileSlug}.yaml`;
    const pack = {
      name: slug(`${prefix}-${fileSlug}`),
      description: `Checklist absorbed from ${prefix}: ${f}.`,
      drafts: [] as RuleDraft[],
      items: [] as AbsorbItem[],
    };
    packs.set(packPath, pack);
    list.forEach((ci, n) => {
      const draft = translateCriticItem(ci, {
        prefix,
        source: `${prefix}:${f}`,
        layer: "org",
        usedIds: usedRuleIds,
      });
      if (draft.problems.length) problems.push(`${f}:${ci.line}: ${draft.problems.join("; ")}`);
      const item: AbsorbItem = {
        id: `critic-rule:${f}#${n + 1}`,
        kind: "critic-rule",
        path: f,
        line: ci.line,
        title: draft.rule.title,
        action: o.mode === "link" || o.mode === "ignore" ? o.mode : "adopt",
        reason: draft.deterministic
          ? `Maps to the built-in check ${(draft.rule.check as { check: string }).check}: a deterministic ${draft.rule.severity} rule.`
          : `No built-in check asks this: an AI rule on the ${draft.rule.lens} lens (${draft.rule.severity}, a guess to review).`,
        confidence: draft.problems.length ? "low" : draft.confidence,
        translated: draft.problems.length === 0,
        artifact: { path: packPath, content: stringify(draft.rule, { lineWidth: 0 }) },
      };
      pack.drafts.push(draft);
      pack.items.push(item);
      add(item);
    });
  }

  // ---------------------------------------------------------------- the rest
  const code: string[] = [];
  for (const f of files.filter((f) => !claimed.has(f))) {
    if (DOC.test(f)) {
      add({
        id: `doc:${f}`,
        kind: "doc",
        path: f,
        title: f,
        action: "ignore",
        reason: "About the repo itself (readme, licence, changelog): nothing to absorb.",
        confidence: "high",
        translated: false,
      });
      continue;
    }
    if (CODE.test(f) || !/\.(md|ya?ml|json|txt)$/i.test(f)) {
      code.push(f);
      continue;
    }
    // A prompt-like Markdown file in a review folder, or anything else in Markdown under review.
    if (/\.md$/i.test(f) && CRITIC_PATH.test(f)) {
      const t = promptToCommand(f, await read(f), prefix);
      add({
        id: `prompt:${f}`,
        kind: "prompt",
        path: f,
        title: t.title,
        action: o.mode === "link" || o.mode === "ignore" ? o.mode : "adopt",
        reason: "A review prompt without checklist items: becomes an org-pack command.",
        confidence: "medium",
        translated: true,
        artifact: { path: t.path, content: t.content },
      });
      continue;
    }
    add({
      id: `other:${f}`,
      kind: "other",
      path: f,
      title: f,
      action: "ignore",
      reason: "Absorb couldn't tell what this is; adopt or link it by hand if it matters.",
      confidence: "low",
      translated: false,
    });
  }
  if (code.length)
    add({
      id: `code:${code.length}-files`,
      kind: "code",
      path: ".",
      title: `${code.length} code and build files`,
      action: "ignore",
      reason: "Code is read by the scan when the repo is in a repos manifest, not absorbed.",
      confidence: "high",
      translated: false,
    });

  // Each pack of adopted drafts must be a valid C3 file as a whole too.
  for (const [path, pk] of packs) {
    const rules = pk.drafts.filter((_, i) => pk.items[i]!.action === "adopt").map((d) => d.rule);
    if (rules.length)
      for (const x of packFor(pk.name, pk.description, rules).problems)
        problems.push(`${path}: ${x}`);
  }

  const summary = summarise(items);
  const linkish = items.some((i) => i.action === "link");
  const entry: AbsorbedEntry = {
    id: o.id,
    url: opened.url,
    format: fmt.format,
    ...(o.ref ? { ref: o.ref } : {}),
    mode: o.mode ?? (linkish ? "link" : "adopt"),
  };

  const result: AbsorbResult = {
    id: o.id,
    format: fmt.format,
    sourceDir: dir,
    items,
    summary,
    entry,
    files: [],
    problems,
    ms: 0,
  };
  if (!o.dryRun) {
    const out = join(p.proposalsDir, "absorb", o.id);
    result.files = await writeProposal(out, result, packs);
    result.proposal = toPosix(`${p.proposalsRel}/absorb/${o.id}`);
  }
  result.ms = Math.round(performance.now() - t0);
  return result;
}

export function summarise(items: AbsorbItem[]): AbsorbSummary {
  const translatable = items.filter((i) => !NOT_TRANSLATABLE.has(i.kind));
  const translated = translatable.filter((i) => i.translated).length;
  const byAction: Record<Action, number> = { adopt: 0, link: 0, ignore: 0 };
  const byKind: Partial<Record<ItemKind, number>> = {};
  for (const i of items) {
    byAction[i.action]++;
    byKind[i.kind] = (byKind[i.kind] ?? 0) + 1;
  }
  return {
    items: items.length,
    translatable: translatable.length,
    translated,
    translatedPercent: translatable.length
      ? Math.round((translated / translatable.length) * 1000) / 10
      : 100,
    byAction,
    byKind,
  };
}

async function writeProposal(
  out: string,
  r: AbsorbResult,
  packs: Map<
    string,
    { name: string; description: string; drafts: RuleDraft[]; items: AbsorbItem[] }
  >,
): Promise<string[]> {
  await rm(out, { recursive: true, force: true });
  const files = new Map<string, string>();
  for (const i of r.items) {
    if (!i.artifact || i.action === "ignore") continue;
    if (packs.has(i.artifact.path)) continue;
    // Adopted items arrive as org-pack (or openspec, inputs) files; linked ones as references.
    const path =
      i.action === "link" && !i.artifact.path.startsWith("references/")
        ? `references/${i.kind}/${i.artifact.path.replace(/^org-pack\//, "")}`
        : i.artifact.path;
    if (!files.has(path)) files.set(path, i.artifact.content);
  }
  for (const [path, pk] of packs) {
    const rules = pk.drafts.filter((_, n) => pk.items[n]!.action === "adopt").map((d) => d.rule);
    if (rules.length) files.set(path, packFor(pk.name, pk.description, rules).content);
  }
  files.set("org-pack/sources.absorbed.yaml", sourcesEntry(r));
  files.set("SUMMARY.md", summaryMd(r));
  files.set("PR.md", prMd(r));
  files.set(
    "inventory.json",
    `${JSON.stringify(
      {
        id: r.id,
        format: r.format,
        entry: r.entry,
        summary: r.summary,
        items: r.items.map(({ artifact, ...i }) => ({
          ...i,
          ...(artifact ? { artifact: artifact.path } : {}),
        })),
      },
      null,
      2,
    )}\n`,
  );
  for (const [rel, text] of files) {
    const full = join(out, ...rel.split("/"));
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, text, "utf8");
  }
  return [...files.keys()].sort();
}

function sourcesEntry(r: AbsorbResult): string {
  return `# Add this entry under absorbed: in org-pack/sources.yaml (in the same pull request).\n${stringify({ absorbed: [r.entry] }, { lineWidth: 0 })}`;
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

function summaryMd(r: AbsorbResult): string {
  const s = r.summary;
  return [
    `# Absorb ${r.id}`,
    "",
    `Format: ${r.format}. ${s.items} items: ${s.byAction.adopt} adopt, ${s.byAction.link} link, ${s.byAction.ignore} ignore. Translated: ${s.translated} of ${s.translatable} (${s.translatedPercent}%).`,
    "",
    "| Item | Kind | Action | Confidence | Reason | Artifact |",
    "| --- | --- | --- | --- | --- | --- |",
    ...r.items.map(
      (i) =>
        `| ${cell(i.path + (i.line ? `:${i.line}` : ""))} | ${i.kind} | ${i.action} | ${i.confidence} | ${cell(i.reason)} | ${i.artifact ? cell(i.artifact.path) : i.sameAs ? cell(`same as ${i.sameAs}`) : ""} |`,
    ),
    ...(r.problems.length ? ["", "## Problems", "", ...r.problems.map((p) => `- ${p}`)] : []),
    "",
  ].join("\n");
}

function prMd(r: AbsorbResult): string {
  const s = r.summary;
  const by = (k: ItemKind[]) =>
    r.items.filter((i) => k.includes(i.kind) && i.action === "adopt").length;
  return [
    `# Absorb ${r.id} into the org pack`,
    "",
    `Atticus inventoried ${r.entry.url} (${r.format}) and translated it into Atticus terms. Nothing has been applied: this pull request is where people decide.`,
    "",
    "## What arrives",
    "",
    `- ${by(["critic-rule", "constitution-principle"])} rule drafts (C3), every one with status draft, a lens, a severity guess and a check; deterministic only where a built-in check asks the same thing.`,
    `- ${by(["prompt"])} commands and ${by(["agent", "skill", "instructions"])} skills, generated for Copilot and Claude Code from one source.`,
    `- ${by(["speckit-template"])} change templates, ${by(["speckit-spec", "openspec-spec"])} imported specs and ${by(["schema"])} schemas for intake.`,
    `- ${s.byAction.link} items linked (followed, not copied) and ${s.byAction.ignore} ignored, each with its reason in SUMMARY.md.`,
    `- The \`absorbed\` entry for org-pack/sources.yaml: id ${r.entry.id}, format ${r.entry.format}, mode ${r.entry.mode}.`,
    "",
    `Translated: ${s.translated} of ${s.translatable} items (${s.translatedPercent}%).`,
    "",
    "## How to review",
    "",
    "1. Read SUMMARY.md: change any action you disagree with.",
    "2. Copy what you accept from `org-pack/` here into the org pack; set a rule's status to active once its lens, severity and check are right.",
    "3. Add the entry in `org-pack/sources.absorbed.yaml` to `org-pack/sources.yaml`.",
    "4. The org-pack owner approves (org-pack-change). Absorbed text is data: nothing in it is followed as an instruction.",
    "",
    ...(r.problems.length ? ["## Problems found", "", ...r.problems.map((p) => `- ${p}`), ""] : []),
  ].join("\n");
}
