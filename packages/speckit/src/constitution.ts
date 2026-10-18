import { join } from "node:path";
import type { OrgPack } from "@maycombhq/core";
import {
  CONSTITUTION_FILE_LABEL,
  layerRules,
  loadConstitution,
  readPackFiles,
  type EffectiveRule,
  type PackSource,
} from "@maycombhq/naysayer";
import { orgPackDirOf } from "@maycombhq/core";
import { BEGIN_RE, END, findSection, parseHeader } from "@maycombhq/assistant-files";

/**
 * The repo's `.specify/memory/constitution.md`, generated from one source: the critic's
 * constitution layer (Atticus's built-in rules plus any org rule marked `layer: constitution`)
 * and the org pack's rules, plus the owning team's rules. The same rules the critic applies
 * at the gates, so a developer planning in Spec Kit and the critic reviewing the PR read the
 * same principles. No clock goes in, so regenerating is idempotent.
 */

const ROMAN = [
  [1000, "M"],
  [900, "CM"],
  [500, "D"],
  [400, "CD"],
  [100, "C"],
  [90, "XC"],
  [50, "L"],
  [40, "XL"],
  [10, "X"],
  [9, "IX"],
  [5, "V"],
  [4, "IV"],
  [1, "I"],
] as const;

export function roman(n: number): string {
  let out = "";
  for (const [v, s] of ROMAN)
    while (n >= v) {
      out += s;
      n -= v;
    }
  return out;
}

/** The effective rules for a repo: constitution, every org checklist, and the owning team's packs. */
export async function rulesForRepo(
  root: string,
  team?: string,
): Promise<{ rules: EffectiveRule[]; problems: string[]; constitutionVersion: string }> {
  const constitution = await loadConstitution();
  const sources: PackSource[] = [
    { pack: constitution, file: CONSTITUTION_FILE_LABEL, origin: "constitution" },
  ];
  const org = await readPackFiles(root, join(orgPackDirOf(root), "checklists"));
  for (const p of org.packs) sources.push({ ...p, origin: "org" });
  const problems = [...org.problems];
  if (team) {
    const t = await readPackFiles(root, join(orgPackDirOf(root), "teams", team, "checklists"));
    problems.push(...t.problems);
    for (const p of t.packs) sources.push({ ...p, origin: "team" });
  }
  const layered = layerRules(sources);
  problems.push(...layered.problems, ...layered.refused.map((r) => `${r.file}: ${r.reason}`));
  return {
    rules: layered.rules.filter((r) => r.status === "active"),
    problems,
    constitutionVersion: constitution.version,
  };
}

const describe = (r: EffectiveRule) =>
  (r.description ?? (r.check.type === "ai" ? r.check.prompt : r.title)).trim();

const line = (r: EffectiveRule) =>
  `Rule \`${r.id}\` (${r.lens} lens, ${r.severity}${r.effectiveLayer === "constitution" || !r.waivable ? ", never waived" : ", waivable by the stage owner"}).`;

export interface ConstitutionInput {
  repo: string;
  rules: EffectiveRule[];
  orgPack: Pick<OrgPack, "pack">;
  constitutionVersion: string;
  team?: string;
}

/** The rule headings and blocks, with headings `depth` levels below the document title. */
function ruleSections(o: ConstitutionInput, depth: number): string[] {
  // Rules keep their order in the packs (the constitution first), so numbering is stable.
  const byLayer = (l: string) => o.rules.filter((r) => r.effectiveLayer === l);
  const core = byLayer("constitution");
  const org = byLayer("org");
  const team = byLayer("team");
  const h2 = "#".repeat(depth + 1);
  const h3 = "#".repeat(depth + 2);
  const block = (r: EffectiveRule, heading: string) => [heading, "", describe(r), "", line(r), ""];
  return [
    `${h2} Core Principles`,
    "",
    ...core.flatMap((r, i) => block(r, `${h3} ${roman(i + 1)}. ${r.title}`)),
    ...(org.length
      ? [`${h2} Organisation Rules`, "", ...org.flatMap((r) => block(r, `${h3} ${r.title}`))]
      : []),
    ...(team.length
      ? [
          `${h2} Team Rules (${o.team ?? "owning team"})`,
          "",
          ...team.flatMap((r) => block(r, `${h3} ${r.title}`)),
        ]
      : []),
  ];
}

const packName = (o: ConstitutionInput) =>
  o.orgPack.pack ? `${o.orgPack.pack.name} ${o.orgPack.pack.version}` : "built-in defaults";

/**
 * Atticus's rules as a section to merge into a constitution the team wrote itself: one
 * level below the team's title, saying that everything outside it is the team's own.
 */
export function renderConstitutionSection(o: ConstitutionInput): string {
  return [
    "## Atticus Rules",
    "",
    `Merged by Atticus from the Atticus constitution ${o.constitutionVersion} and the org pack (${packName(o)}): the rules the critic applies at every gate, which apply here alongside the team's own principles. Everything outside this section is the team's own and Atticus never changes it. Change these rules in the org pack, never here; hand-down regenerates this section.`,
    "",
    ...ruleSections(o, 2),
  ]
    .join("\n")
    .replace(/\n+$/, "\n");
}

/**
 * How hand-down writes `.specify/memory/constitution.md` given what is there now: the whole
 * file when it is missing or Atticus wrote it, a marked section when the team wrote its own
 * (never replacing the team's text), or a refusal when its markers are broken so a section
 * can't be placed safely.
 */
export function constitutionPlan(
  current: string | undefined,
): { mode: "file" } | { mode: "section" } | { mode: "refuse"; reason: string } {
  if (current === undefined || parseHeader(current)) return { mode: "file" };
  const lines = current.replace(/\r\n/g, "\n").split("\n");
  const begins = lines.filter((l) => /^<!-- atticus:begin\b/.test(l)).length;
  const ends = lines.filter((l) => l === END).length;
  if (begins === 0 && ends === 0) return { mode: "section" };
  if (begins === 1 && ends === 1 && findSection(current)) return { mode: "section" };
  const why =
    begins > ends
      ? "a begin marker without an end marker"
      : begins < ends
        ? "an end marker without a begin marker"
        : begins > 1
          ? "more than one Atticus section"
          : !lines.some((l) => BEGIN_RE.test(l))
            ? "a begin marker Atticus can't read"
            : "an end marker before the begin marker";
  return {
    mode: "refuse",
    reason: `.specify/memory/constitution.md is the team's own constitution and its Atticus section markers are broken (${why}), so Atticus can't merge its rules into it. Fix or remove the markers, then hand down again.`,
  };
}

export function renderConstitution(o: ConstitutionInput): string {
  const pack = packName(o);
  return [
    `# ${o.repo} Constitution`,
    "",
    `Generated from the Atticus constitution ${o.constitutionVersion} and the org pack (${pack}): the rules the critic applies at every gate. Change them in the org pack, never here.`,
    "",
    ...ruleSections(o, 1),
    "## Governance",
    "",
    "This constitution is generated by Atticus from the org pack, the same source as the critic's constitution layer. Core principles are never waived, and a team can only tighten a rule, never drop or loosen it. Amend it with a pull request to the org pack; hand-down regenerates this file.",
    "",
    `**Version**: ${o.constitutionVersion}+${(o.orgPack.pack?.name ?? "defaults").replace(/[^a-z0-9.-]/g, "-")}.${o.orgPack.pack?.version ?? "0.0.0"} | **Source**: org-pack and the Atticus constitution`,
    "",
  ].join("\n");
}
