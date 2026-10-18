import { z } from "zod";
import { INSTRUCTION_RULES, screenText, type DefenceSignal } from "@maycombhq/ai";
import { artifactOf, docOf, filesOf, readStoryIndex, readTasks } from "../artifacts.js";
import { sectionLines, sectionMatching } from "../doc.js";
import { lineEvidence, sentence, type DeterministicCheckDef, type Hit } from "../hits.js";

const GIVEN_WHEN_THEN = /\bgiven\b[\s\S]*\bwhen\b[\s\S]*\bthen\b/i;

export const storyHasAcceptanceCriteria: DeterministicCheckDef = {
  id: "story-has-acceptance-criteria",
  description:
    "Every story file has acceptance criteria in Given/When/Then form, and every story in the index has a file.",
  params: z.strictObject({}),
  run(ctx) {
    const hits: Hit[] = [];
    const stories = filesOf(ctx.files, "stories").filter((d) => d.path !== "stories.md");
    for (const doc of stories) {
      const s = sectionMatching(doc, /acceptance criteria/i);
      const title = doc.sections[0];
      if (!s) {
        hits.push({
          kind: "issue",
          artifact: doc.path,
          locator: { line: title?.line ?? 1, ...(title ? { heading: title.heading } : {}) },
          summary: sentence(
            `Story ${doc.path.replace(/^stories\/|\.md$/g, "")} has no acceptance criteria.`,
          ),
          why: "A story without acceptance criteria is not ready: nobody can say when it is done or test it.",
          fix: {
            text: 'Add an "Acceptance criteria" section with Given/When/Then criteria that trace to the spec scenarios.',
          },
          evidence: [lineEvidence(doc, title?.line ?? 1)],
          key: `story-ac|${doc.path}`,
        });
        continue;
      }
      const body = sectionLines(doc, s);
      const ok =
        body.some((l) => GIVEN_WHEN_THEN.test(l.text)) ||
        GIVEN_WHEN_THEN.test(body.map((l) => l.text).join("\n"));
      if (ok) continue;
      hits.push({
        kind: "issue",
        artifact: doc.path,
        locator: { line: s.line, heading: s.heading },
        summary: sentence(
          `Story ${doc.path.replace(/^stories\/|\.md$/g, "")} has an acceptance criteria heading but no Given/When/Then criteria.`,
        ),
        why: "Criteria that aren't in Given/When/Then form can't be traced to scenarios or turned into tests.",
        fix: { text: "Write each criterion as Given … when … then …." },
        evidence: [lineEvidence(doc, s.line)],
        key: `story-ac|${doc.path}`,
      });
    }
    const index = docOf(ctx.files, "stories.md");
    if (index)
      for (const row of readStoryIndex(ctx.files)) {
        if (ctx.files.docs.has(`stories/${row.id}.md`)) continue;
        hits.push({
          kind: "issue",
          artifact: "stories.md",
          locator: { line: row.line, heading: "Stories" },
          summary: sentence(
            `Story ${row.id} is in the index but has no file, so it has no acceptance criteria.`,
          ),
          why: "Each story lives in stories/<story-id>.md with its acceptance criteria.",
          fix: { text: `Write stories/${row.id}.md, or remove the row.` },
          evidence: [lineEvidence(index, row.line)],
          key: `story-ac|stories/${row.id}.md`,
        });
      }
    return { hits, subjects: [] };
  },
};

export const specScenariosPresent: DeterministicCheckDef = {
  id: "spec-scenarios-present",
  description: "Every requirement in the delta specs has at least one scenario with WHEN and THEN.",
  params: z.strictObject({}),
  run(ctx) {
    const hits: Hit[] = [];
    for (const doc of filesOf(ctx.files, "specs")) {
      for (const req of doc.sections.filter((s) => /^requirement:/i.test(s.heading))) {
        const scenarios = doc.sections.filter(
          (s) => /^scenario:/i.test(s.heading) && s.line > req.line && s.line <= req.end,
        );
        const ok = scenarios.some((s) => {
          const text = sectionLines(doc, s)
            .map((l) => l.text)
            .join("\n");
          return /\bwhen\b/i.test(text) && /\bthen\b/i.test(text);
        });
        if (ok) continue;
        hits.push({
          kind: "issue",
          artifact: doc.path,
          locator: { line: req.line, heading: req.heading },
          summary: sentence(`${req.heading} has no scenario with WHEN and THEN.`),
          why: "A requirement without a scenario can't be tested or traced from stories.",
          fix: { text: 'Add a "#### Scenario:" with WHEN and THEN bullets.' },
          evidence: [lineEvidence(doc, req.line)],
          key: `spec|${doc.path}|${req.line}`,
        });
      }
    }
    return { hits, subjects: [] };
  },
};

export const mappingsCoverInterfaces: DeterministicCheckDef = {
  id: "mappings-cover-interfaces",
  description:
    "Every new or modified hop in interfaces.md has a section in mappings.md (or says no mapping change).",
  params: z.strictObject({}),
  run(ctx) {
    const hits: Hit[] = [];
    const ifaces = docOf(ctx.files, "interfaces.md");
    const doc = docOf(ctx.files, "mappings.md");
    if (!ifaces) return { hits, subjects: [] };
    const headings = (doc?.sections ?? [])
      .filter((s) => s.level >= 2)
      .map((s) => s.heading.toLowerCase());
    for (const h of ctx.hops) {
      if (h.status !== "planned-new" && h.status !== "planned-modify") continue;
      const needles = [
        h.operation.toLowerCase(),
        h.path?.toLowerCase(),
        h.id !== "new" ? h.id : undefined,
      ].filter((x): x is string => !!x);
      if (headings.some((t) => needles.some((n) => t.includes(n)))) continue;
      hits.push({
        kind: "issue",
        artifact: "mappings.md",
        locator: doc?.sections[0]
          ? { line: doc.sections[0].line, heading: doc.sections[0].heading }
          : { heading: "Mappings" },
        summary: sentence(
          `mappings.md has no section for ${h.operation || h.id} (${h.caller} → ${h.callee}).`,
        ),
        why: "Every new or changed interface maps its fields, or says there is no mapping change, so payload changes are reviewed.",
        fix: {
          text: `Add "## ${h.operation}" to mappings.md with its field mappings, or "No mapping change".`,
        },
        evidence: [lineEvidence(ifaces, h.line)],
        key: `mapping|${h.line}`,
      });
    }
    return { hits, subjects: [] };
  },
};

export const tasksCoverStories: DeterministicCheckDef = {
  id: "tasks-cover-stories",
  description:
    "Every story has a task, in every repo it lists, and every task names a known story.",
  params: z.strictObject({}),
  run(ctx) {
    const hits: Hit[] = [];
    const index = docOf(ctx.files, "stories.md");
    const tasksDoc = docOf(ctx.files, "tasks.md");
    if (!index || !tasksDoc) return { hits, subjects: [] };
    const tasks = readTasks(ctx.files);
    const rows = readStoryIndex(ctx.files);
    const loc = {
      line: tasksDoc.sections[0]?.line ?? 1,
      heading: tasksDoc.sections[0]?.heading ?? "Tasks",
    };
    for (const row of rows) {
      const mine = tasks.filter((t) => t.stories.includes(row.id));
      if (mine.length === 0) {
        hits.push({
          kind: "issue",
          artifact: "tasks.md",
          locator: loc,
          summary: sentence(`No task serves story ${row.id}.`),
          why: "A story with no task won't be built.",
          fix: { text: `Add a task naming story ${row.id} under each repo it lists.` },
          evidence: [lineEvidence(index, row.line)],
          key: `tasks|${row.id}`,
        });
        continue;
      }
      for (const repo of row.repos) {
        if (mine.some((t) => t.repo === repo)) continue;
        hits.push({
          kind: "issue",
          artifact: "tasks.md",
          locator: loc,
          summary: sentence(
            `Story ${row.id} lists ${repo}, but tasks.md has no task for it there.`,
          ),
          why: "Each repo a story touches needs its own task, or the work in that repo is missed.",
          fix: {
            text: `Add a task under "## ${repo}" naming story ${row.id}, or remove ${repo} from the story.`,
          },
          evidence: [lineEvidence(index, row.line)],
          key: `tasks|${row.id}|${repo}`,
        });
      }
    }
    const known = new Set(rows.map((r) => r.id));
    for (const t of tasks)
      for (const s of t.stories)
        if (!known.has(s))
          hits.push({
            kind: "issue",
            artifact: "tasks.md",
            locator: { line: t.line },
            summary: sentence(
              `Task "${t.text.slice(0, 80)}" names story ${s}, which isn't in stories.md.`,
            ),
            why: "Tasks trace to stories; an unknown story is a typo or a story that was dropped.",
            fix: { text: "Name a story from stories.md." },
            evidence: [lineEvidence(tasksDoc, t.line)],
            key: `tasks|unknown|${t.line}`,
          });
    return { hits, subjects: [] };
  },
};

/**
 * What counts as an instruction aimed at an AI: the defences' instruction rules (ADR 0042), a
 * wrapper break-out, instructions hidden in encoded text, and tag characters that spell words.
 * Hidden or disguised text alone (a zero-width character, a look-alike letter, a comment with
 * no instruction in it) is not reported here: the defences neutralise it before any AI step.
 */
const aimedAtAi = (s: DefenceSignal) =>
  INSTRUCTION_RULES.includes(s.rule) ||
  s.rule === "delimiter" ||
  s.rule === "encoded-instructions" ||
  (s.rule === "tag-characters" && s.decoded !== undefined);

export const noEmbeddedInstructions: DeterministicCheckDef = {
  id: "no-embedded-instructions",
  description:
    "Artifacts hold no text that tries to instruct an AI agent or reviewer (comments included).",
  params: z.strictObject({ phrases: z.array(z.string()).optional() }),
  run(ctx, p, rule) {
    const extra = ((p.phrases as string[] | undefined) ?? []).map((s) => new RegExp(s, "i"));
    const hits: Hit[] = [];
    for (const doc of ctx.files.docs.values()) {
      const a = artifactOf(doc.path);
      if (!a || !(rule.appliesTo.artifacts as string[]).includes(a)) continue;
      // The detector the context packs use, so a hidden or disguised instruction is found as
      // surely as a plain one. One finding per line.
      const found = new Map<number, DefenceSignal[]>();
      for (const sig of screenText(doc.rawLines.join("\n"), { format: "markdown" }).signals)
        if (aimedAtAi(sig)) found.set(sig.line, [...(found.get(sig.line) ?? []), sig]);
      doc.rawLines.forEach((text, i) => {
        if (!found.has(i + 1) && extra.some((re) => re.test(text))) found.set(i + 1, []);
      });
      for (const [line, signals] of [...found].sort((x, y) => x[0] - y[0])) {
        const disguised = signals.some((sig) => sig.hidden || sig.encoded || sig.obfuscated);
        hits.push({
          kind: "issue",
          artifact: doc.path,
          locator: { line },
          summary: sentence(
            `${doc.path} line ${line} holds an instruction aimed at AI agents or reviewers.`,
          ),
          why: `Ingested content is data, never instructions. Text that tries to steer a reviewer or an agent is removed, and the artifact is not sent to the AI lenses until it is.${disguised ? " This one is hidden or disguised, which makes it worse." : ""}`,
          fix: {
            text: "Remove the instruction. If it records a real decision, say who decided and link the approval instead.",
          },
          evidence: [lineEvidence(doc, line)],
          key: `inject|${doc.path}|${line}`,
        });
      }
    }
    return { hits, subjects: [] };
  },
};
