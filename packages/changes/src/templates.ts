import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { RecordId } from "@maycombhq/core";

/**
 * Change templates: the brief skeleton a new change starts from. Built-in templates cover
 * the common kinds of change; an organisation overrides one, or adds its own, with a file
 * at `org-pack/process/change-templates/<id>.md` (YAML front matter, then the skeleton).
 *
 * A skeleton holds headings and HTML comments only, so a brief nobody has filled in is
 * recognisably empty and can't be handed off.
 */
export const TemplateMeta = z.strictObject({
  id: RecordId,
  name: z.string().min(1),
  /** The change type this template is normally used with. */
  changeType: RecordId,
  description: z.string().min(1).optional(),
});

export interface ChangeTemplate extends z.infer<typeof TemplateMeta> {
  body: string;
  /** "built-in", or the file under org-pack it came from. */
  source: string;
}

/** Values a skeleton may use, written as {{name}}. */
export const TEMPLATE_VARIABLES = ["title", "id", "type", "by", "date"] as const;
export type TemplateVariables = Record<(typeof TEMPLATE_VARIABLES)[number], string>;

const intro =
  "<!-- Brief for {{id}} ({{type}}), started by {{by}} on {{date}}. Replace every comment with your own words; the proposal is drafted from this file. -->";

function skeleton(sections: [string, string][]): string {
  return (
    ["# {{title}}", "", intro, ""]
      .concat(...sections.map(([h, c]) => [`## ${h}`, "", `<!-- ${c} -->`, ""]))
      .join("\n")
      .replace(/\n+$/, "") + "\n"
  );
}

const builtIn = (
  id: string,
  name: string,
  changeType: string,
  description: string,
  sections: [string, string][],
): ChangeTemplate => ({
  id,
  name,
  changeType,
  description,
  body: skeleton(sections),
  source: "built-in",
});

export const BUILT_IN_TEMPLATES: readonly ChangeTemplate[] = [
  builtIn("feature", "New feature", "feature", "Something new for customers or users.", [
    ["Problem", "Who has the problem, what it costs them today, and why now."],
    ["Outcome", "What is true when this is done, in the customer's or user's words."],
    ["Scope", "In scope, and what is out of scope."],
    ["Systems", "Systems you expect to be involved, by name or catalog id. Leave it if unsure."],
    ["Success measures", "How we will know it worked."],
    ["Open questions", "Anything you don't know yet, and who might."],
  ]),
  builtIn("defect-fix", "Defect fix", "bug-fix", "Something that should work and doesn't.", [
    ["Defect", "What goes wrong, for whom, and since when."],
    ["Steps to reproduce", "Numbered steps, with the environment."],
    ["Expected and actual", "What should happen, and what happens instead."],
    ["Impact", "How many people or transactions, and any workaround."],
    ["Ticket", "The work-tracker or service-desk ticket."],
  ]),
  builtIn(
    "emergency-fix",
    "Emergency fix",
    "emergency-fix",
    "A fix that ships before the usual reviews; the skipped lenses run after release.",
    [
      ["Incident", "The incident or alert, when it started, and its ticket."],
      ["Impact", "Who is affected right now, and how badly."],
      ["Fix", "The smallest change that stops the harm."],
      ["Rollback", "How to undo the fix if it makes things worse."],
      ["Follow-up", "What the post-release review should look at."],
    ],
  ),
  builtIn(
    "small-change",
    "Small change",
    "small-change",
    "A small change: one step from brief to tasks, checked and criticised at one gate (ADR 0113).",
    [
      ["Change", "What changes, for whom, in two or three sentences."],
      ["Where", "The flow, screen, endpoint or table it is in, if you know. Leave it if unsure."],
      ["Done when", "What a test can check when it is done."],
    ],
  ),
  builtIn("tech-debt", "Technical debt", "tech-debt", "Work that makes later change cheaper.", [
    ["Debt", "What is wrong with the code, design or platform today."],
    ["Cost of leaving it", "What it slows down or puts at risk, with examples."],
    ["Proposed change", "What you would change, and what stays the same for users."],
    ["Risk", "What could break, and how you will know."],
  ]),
  builtIn(
    "vulnerability-fix",
    "Vulnerability fix",
    "bug-fix",
    "A security weakness to close. Keep exploit details out of the brief.",
    [
      ["Vulnerability", "The advisory or scan id and a one-line description. No exploit details."],
      ["Affected components", "Components, versions and environments affected."],
      ["Severity", "The severity and the deadline that comes with it."],
      ["Fix", "Upgrade, patch or configuration change."],
      ["Verification", "How we prove it is closed, such as a rescan."],
    ],
  ),
  builtIn(
    "config-flag",
    "Configuration or feature flag",
    "config-change",
    "A setting or flag changes; no code changes.",
    [
      ["Setting or flag", "Its name and where it lives."],
      ["Values", "Current and new value in each environment."],
      ["Why", "What the change achieves."],
      ["Rollback", "How to put the old value back, and how fast."],
    ],
  ),
  builtIn("data-fix", "Data fix", "bug-fix", "Stored data is wrong and must be corrected.", [
    ["Data problem", "What is wrong in which data store, and how it happened."],
    ["Records affected", "How many records, and how they are found."],
    ["Correction", "What the corrected data looks like, and the script or tool."],
    ["Verification", "How we check the correction, before and after."],
    ["Data owner", "Who owns the data and must approve the fix."],
  ]),
  builtIn(
    "decommission",
    "Decommission",
    "integration",
    "A system, interface or data store retires.",
    [
      ["What retires", "Systems, interfaces or data stores, by catalog id."],
      ["Consumers", "Who uses it today, from the catalog, and what they move to."],
      ["Replacement", "What replaces it, if anything."],
      ["Data", "What happens to the data: migrate, archive or delete, with retention."],
      ["Timeline", "Notice to consumers, switch-off and clean-up dates."],
    ],
  ),
];

export interface TemplateProblem {
  file: string;
  message: string;
}

/**
 * Built-in templates overlaid with the org pack's `process/change-templates/*.md`. A file
 * whose id matches a built-in replaces it. Broken files are reported, never half-used.
 */
export async function loadTemplates(
  orgPackDir: string,
): Promise<{ templates: ChangeTemplate[]; problems: TemplateProblem[] }> {
  const byId = new Map(BUILT_IN_TEMPLATES.map((t) => [t.id, t]));
  const problems: TemplateProblem[] = [];
  const dir = join(orgPackDir, "process", "change-templates");
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".md")).sort();
  } catch {
    // no templates folder: built-ins only
  }
  for (const name of names) {
    const file = `process/change-templates/${name}`;
    const text = (await readFile(join(dir, name), "utf8")).replace(/\r\n/g, "\n");
    const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
    if (!m) {
      problems.push({ file, message: "a change template starts with YAML front matter" });
      continue;
    }
    let meta: unknown;
    try {
      meta = parse(m[1]!);
    } catch (e) {
      problems.push({ file, message: `can't read the front matter: ${(e as Error).message}` });
      continue;
    }
    const r = TemplateMeta.safeParse(meta);
    if (!r.success) {
      for (const i of r.error.issues)
        problems.push({ file, message: `${i.path.join(".") || "(front matter)"}: ${i.message}` });
      continue;
    }
    if (`${r.data.id}.md` !== name) {
      problems.push({ file, message: `says id ${r.data.id}; name the file ${r.data.id}.md` });
      continue;
    }
    const unknown = [...m[2]!.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)]
      .map((x) => x[1]!)
      .filter((v) => !(TEMPLATE_VARIABLES as readonly string[]).includes(v));
    if (unknown.length > 0) {
      problems.push({
        file,
        message: `unknown placeholder ${unknown.map((u) => `{{${u}}}`).join(", ")}; use ${TEMPLATE_VARIABLES.map((v) => `{{${v}}}`).join(", ")}`,
      });
      continue;
    }
    byId.set(r.data.id, { ...r.data, body: m[2]!.replace(/^\n+/, ""), source: file });
  }
  return {
    templates: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
    problems,
  };
}

/** Fill a skeleton's placeholders. */
export function renderTemplate(t: Pick<ChangeTemplate, "body">, vars: TemplateVariables): string {
  return t.body.replace(
    /\{\{\s*(title|id|type|by|date)\s*\}\}/g,
    (_, k: keyof TemplateVariables) => vars[k],
  );
}

/**
 * The template for a new change: the one asked for, else the one with the type's id, else
 * the first whose changeType is the type, else the feature template.
 */
export function pickTemplate(
  templates: readonly ChangeTemplate[],
  type: string,
  wanted?: string,
): ChangeTemplate | undefined {
  if (wanted) return templates.find((t) => t.id === wanted);
  return (
    templates.find((t) => t.id === type) ??
    templates.find((t) => t.changeType === type) ??
    templates.find((t) => t.id === "feature")
  );
}
