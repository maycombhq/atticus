import { parse, stringify } from "yaml";
import { ChecklistPack, ChecklistRule, type Lens } from "@maycombhq/core";
import { BUILT_IN_CHECKS } from "@maycombhq/naysayer";
import type { z } from "zod";
import { slug } from "../files.js";
import type { Confidence } from "./types.js";

/**
 * A team's critic definitions, translated to C3 rule drafts. Each checklist item becomes one
 * rule with a lens, a severity guess, a check and its needs. The check is deterministic only
 * when the item maps to a built-in check (by what it asks, not by guessing); everything else
 * becomes an AI check whose prompt is the item itself. Every draft is validated against C3.
 */

export interface CriticItem {
  text: string;
  line: number;
  /** An id the source gave the item (YAML checklists). */
  sourceId?: string;
  /** A severity the source gave the item. */
  severity?: string;
  /** A heading the item sits under, as context for the lens guess. */
  section?: string;
}

type RuleInput = z.input<typeof ChecklistRule>;
type Artifact = RuleInput["appliesTo"]["artifacts"][number];

interface Mapping {
  re: RegExp;
  check: string;
  lens: Lens;
  artifacts: Artifact[];
  params?: (text: string) => Record<string, unknown>;
}

const known = new Set(BUILT_IN_CHECKS.map((c) => c.id));

/** Items that ask what a built-in check checks. Order matters: the most specific first. */
const ALL_MAPPINGS: Mapping[] = [
  {
    re: /pattern code.*registry|registry.*pattern code|pattern.*in the (pattern )?registry/i,
    check: "pattern-code-in-registry",
    lens: "architecture",
    artifacts: ["interfaces"],
  },
  {
    re: /approved (integration )?pattern/i,
    check: "interface-pattern-approved",
    lens: "architecture",
    artifacts: ["interfaces"],
  },
  {
    re: /(names?|has|uses) an? (integration )?pattern/i,
    check: "interface-has-pattern",
    lens: "architecture",
    artifacts: ["interfaces"],
  },
  {
    re: /both ends|(caller|callee)s?.*(catalog|known)|ends? of (every|each) interface/i,
    check: "interface-ends-in-catalog",
    lens: "architecture",
    artifacts: ["interfaces"],
  },
  {
    re: /vendor.*operation|operation.*vendor/i,
    check: "vendor-operation-known",
    lens: "architecture",
    artifacts: ["interfaces"],
  },
  {
    re: /timeouts?|retr(y|ies)|circuit.?breaker/i,
    check: "settings-present",
    lens: "architecture",
    artifacts: ["interfaces", "design"],
    params: (t) => ({
      settingKinds: [
        ...(/timeout/i.test(t) ? ["timeout"] : []),
        ...(/retr(y|ies)/i.test(t) ? ["retry"] : []),
        ...(/circuit.?breaker/i.test(t) ? ["circuit-breaker"] : []),
      ],
    }),
  },
  {
    re: /alerts?|dashboards?|observability/i,
    check: "observability-present",
    lens: "release",
    artifacts: ["design"],
    params: (t) => ({
      assetKinds: [
        ...(/alert/i.test(t) ? ["alert"] : []),
        ...(/dashboard/i.test(t) ? ["dashboard"] : []),
      ].concat(/alert|dashboard/i.test(t) ? [] : ["alert"]),
    }),
  },
  {
    re: /acceptance criteria/i,
    check: "story-has-acceptance-criteria",
    lens: "story",
    artifacts: ["stories"],
  },
  {
    re: /requirement.*scenario|scenario.*requirement/i,
    check: "spec-scenarios-present",
    lens: "story",
    artifacts: ["specs"],
  },
  {
    re: /(story|stories).*(covered by|has|have).*task|task.*(every|each) story/i,
    check: "tasks-cover-stories",
    lens: "delivery",
    artifacts: ["tasks"],
  },
  {
    re: /mappings?/i,
    check: "mappings-cover-interfaces",
    lens: "architecture",
    artifacts: ["mappings"],
  },
  {
    re: /how long.*(kept|retained)|retention/i,
    check: "data-retention-stated",
    lens: "architecture",
    artifacts: ["data"],
  },
  {
    re: /personal data|classif/i,
    check: "data-columns-classified",
    lens: "architecture",
    artifacts: ["data"],
  },
  {
    re: /migration/i,
    check: "data-migration-named",
    lens: "architecture",
    artifacts: ["data"],
  },
  {
    re: /data (design|doc)|data\.md|touches a data store/i,
    check: "data-doc-present",
    lens: "architecture",
    artifacts: ["data"],
  },
  {
    re: /service.?desk|change request|snow/i,
    check: "snow-drafts-present",
    lens: "delivery",
    artifacts: ["snow"],
  },
  {
    re: /instructions? (aimed at|for|to) an? (assistant|ai|agent|model)|prompt injection/i,
    check: "no-embedded-instructions",
    lens: "architecture",
    artifacts: ["brief", "proposal", "design", "stories"],
  },
];
const MAPPINGS = ALL_MAPPINGS.filter((m) => known.has(m.check));

/** Lens guess for an item no built-in check covers, from its words and its section. */
function lensOf(t: string): Lens {
  if (/\b(tests?|coverage|lint|dependency|library|libraries|code)\b/i.test(t))
    return "code-and-test";
  if (/\b(story|stories|sprint|acceptance|persona|user journey)\b/i.test(t)) return "story";
  if (/\b(screen|ux|accessib\w*|wcag|usability|copy)\b/i.test(t)) return "ux";
  if (/\b(roll(ed|s|ing)? ?back|release|deploy\w*|go-?live|runbook|on-?call)\b/i.test(t))
    return "release";
  if (/\b(business|value|kpi|cost|benefit|customer)\b/i.test(t)) return "business";
  if (/\b(estimate|plan|milestone|owner|team)\b/i.test(t)) return "delivery";
  return "architecture";
}

const ARTIFACTS_BY_LENS: Record<Lens, Artifact[]> = {
  business: ["brief", "proposal"],
  architecture: ["design", "interfaces"],
  story: ["stories"],
  ux: ["ux"],
  delivery: ["tasks"],
  "code-and-test": ["code", "tests"],
  release: ["design", "release"],
};

function severityOf(item: CriticItem, deterministic: boolean): RuleInput["severity"] {
  const s = item.severity?.toLowerCase();
  if (s) {
    if (/block|critical|high|must|error/.test(s)) return "blocking";
    if (/medium|warn|major|risk/.test(s)) return "risk";
    if (/low|minor|info|idea|nice/.test(s)) return "idea";
  }
  if (/\b(never|must|no (credentials|secrets|tokens))\b/i.test(item.text)) return "blocking";
  return deterministic ? "blocking" : "risk";
}

/** Owner questions for facts the item depends on (C3 needs), when it names one plainly. */
function needsOf(t: string): RuleInput["needs"] {
  if (/timeouts?|retr(y|ies)/i.test(t))
    return [
      {
        kind: "Setting",
        scope: "touched-components",
        question: "What timeouts and retries does ${record} use?",
      },
    ];
  if (/alerts?|dashboards?/i.test(t))
    return [
      {
        kind: "ObservabilityAsset",
        scope: "touched-components",
        question: "Which alerts and dashboards cover ${record}?",
      },
    ];
  if (/retention|how long/i.test(t))
    return [
      {
        kind: "Table",
        field: "retention",
        scope: "touched-data-stores",
        question: "How long are the rows of ${record} kept?",
      },
    ];
  return [];
}

export interface RuleDraft {
  rule: RuleInput;
  deterministic: boolean;
  confidence: Confidence;
  problems: string[];
}

const clean = (t: string) =>
  t
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "")
    .replace(/\s+/g, " ")
    .trim();

export function translateCriticItem(
  item: CriticItem,
  o: {
    prefix: string;
    source: string;
    layer: "constitution" | "org" | "team";
    usedIds: Set<string>;
  },
): RuleDraft {
  const text = clean(item.text);
  const map = MAPPINGS.find((m) => m.re.test(text));
  const deterministic = !!map;
  const severity =
    o.layer === "constitution" && !item.severity ? "blocking" : severityOf(item, deterministic);
  const lens = map?.lens ?? lensOf(`${item.section ?? ""} ${text}`);
  const base = slug(
    `${o.prefix}-${item.sourceId ?? text.split(/\s+/).slice(0, 7).join(" ")}`,
  ).slice(0, 90);
  let id = base;
  for (let n = 2; o.usedIds.has(id); n++) id = `${base}-${n}`;
  o.usedIds.add(id);
  const title = text.length > 120 ? `${text.slice(0, 117)}...` : text;
  const rule: RuleInput = {
    id,
    title,
    ...(text.length > 120 ? { description: text } : {}),
    layer: o.layer,
    lens,
    appliesTo: { artifacts: map?.artifacts ?? ARTIFACTS_BY_LENS[lens] },
    severity,
    check: map
      ? { type: "deterministic", check: map.check, params: map.params?.(text) ?? {} }
      : {
          type: "ai",
          prompt: `Check that this holds for the change: ${text} Quote the artifact line that shows it; when nothing shows it, report a finding with the fix.`,
        },
    waivable: o.layer !== "constitution" && severity === "blocking",
    source: `${o.source}:${item.line}`,
    status: "draft",
    needs: needsOf(text),
  };
  const r = ChecklistRule.safeParse(rule);
  return {
    rule,
    deterministic,
    confidence: map ? "high" : item.severity ? "medium" : "low",
    problems: r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
  };
}

/** The checklist items in a Markdown file: task-list, bullet and numbered lines, with their section. */
export function markdownItems(text: string): CriticItem[] {
  const out: CriticItem[] = [];
  let section: string | undefined;
  text.split("\n").forEach((l, i) => {
    const h = /^#{1,6}\s+(.*)$/.exec(l);
    if (h) {
      section = h[1]!.trim();
      return;
    }
    if (/^\s{0,3}(?:[-*+]|\d+[.)])\s+\S/.test(l) && clean(l).length >= 12)
      out.push({ text: l, line: i + 1, ...(section ? { section } : {}) });
  });
  return out;
}

/** The items of a YAML checklist: a list under items, rules, checks or checklist. */
export function yamlItems(text: string): CriticItem[] | undefined {
  let data: unknown;
  try {
    data = parse(text);
  } catch {
    return undefined;
  }
  const obj = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const list = (["items", "rules", "checks", "checklist"] as const)
    .map((k) => obj[k])
    .find(Array.isArray) as unknown[] | undefined;
  if (!list?.length) return undefined;
  const lines = text.split("\n");
  const out: CriticItem[] = [];
  for (const raw of list) {
    const e = (typeof raw === "string" ? { text: raw } : (raw ?? {})) as Record<string, unknown>;
    const t = [e.text, e.title, e.rule, e.check, e.description].find(
      (v) => typeof v === "string" && v.trim(),
    ) as string | undefined;
    if (!t) continue;
    const at = lines.findIndex((l) => l.includes(t.slice(0, 40)));
    out.push({
      text: t,
      line: at >= 0 ? at + 1 : 1,
      ...(typeof e.id === "string" ? { sourceId: e.id } : {}),
      ...(typeof e.severity === "string" ? { severity: e.severity } : {}),
    });
  }
  return out.length ? out : undefined;
}

/** A pack file for the drafts from one source file, validated against C3. */
export function packFor(
  name: string,
  description: string,
  rules: RuleInput[],
): { content: string; problems: string[] } {
  const pack = { schemaVersion: 1, name, version: "0.1.0", description, rules };
  const r = ChecklistPack.safeParse(pack);
  return {
    content: `# Drafted by atticus absorb. Every rule is a draft: review, then set status: active.\n${stringify(pack, { lineWidth: 0 })}`,
    problems: r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
  };
}
