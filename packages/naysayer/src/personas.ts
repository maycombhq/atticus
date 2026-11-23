import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { buildContextPack, type AiRuntime } from "@maycombhq/ai";
import { AgentDefinition, orgPackDirOf } from "@maycombhq/core";
import { numbered, OUTPUT_FORMAT, parseLensOutput, personaRule, rulesText } from "./ai.js";
import type { CriticContext } from "./context.js";
import { parseDoc } from "./doc.js";
import type { EffectiveRule } from "./rules.js";

/**
 * ADR 0203 C: a persona's naysayer as one more lens of the critic. A naysayer of the org pack
 * (`org-pack/agents/<name>-naysayer.md`, ADR 0201) whose frontmatter gives `gates: [design, …]`
 * runs at those gates after the four questions, through the same code: an agent definition and
 * one rule built in memory, `persona.<name>`, org layer, severity risk, whose look-for is the
 * file's body. No `gates`, no lens: of the starters, only the application architect's and the
 * security naysayers give `gates: [design]` (v31). Another team's agents
 * (`agents/imported/`, ADR 0177) are never run as lenses. The file's words are the
 * organisation's, reviewed like the rest of the org pack; what the lens reads is data.
 */

export interface PersonaLens {
  /** The file's name: the agent's id and the finding's persona. */
  name: string;
  /** The `## <Role>` heading its persona's section has in a requirements file (`owns`). */
  owns?: string;
  /** Gate ids its frontmatter gives; none when it has no `gates`. */
  gates: string[];
  rule: EffectiveRule;
  agent: AgentDefinition;
}

const NAYSAYER = /^([a-z0-9][a-z0-9-]*-naysayer)\.md$/;

/** Every naysayer of the org pack, whether or not it gives gates. */
export async function personaLenses(root: string, budget: number): Promise<PersonaLens[]> {
  const dir = join(orgPackDirOf(root), "agents");
  const out: PersonaLens[] = [];
  const names = (await readdir(dir).catch(() => [] as string[])).sort();
  for (const file of names) {
    const name = NAYSAYER.exec(file)?.[1];
    if (!name) continue;
    const text = (await readFile(join(dir, file), "utf8")).replace(/\r\n?/g, "\n");
    const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
    let fm: Record<string, unknown>;
    try {
      fm = (m ? (parse(m[1]!) as Record<string, unknown>) : undefined) ?? {};
    } catch {
      fm = {};
    }
    const body = (m ? m[2]! : text).trim();
    if (!body) continue;
    const gates = Array.isArray(fm.gates) ? fm.gates.map(String) : [];
    const words = typeof fm.description === "string" ? fm.description : `${name}'s questions.`;
    out.push({
      name,
      ...(typeof fm.owns === "string" ? { owns: fm.owns } : {}),
      gates,
      rule: {
        id: `persona.${name}`,
        title: `${name} asks what the draft got wrong or left out`,
        description: words,
        layer: "org",
        effectiveLayer: "org",
        lens: "complete",
        asks: "complete",
        appliesTo: {
          artifacts: ["brief", "proposal", "specs", "design", "stories", "tasks"],
          changeTypes: [],
        },
        severity: "risk",
        check: { type: "ai", prompt: body },
        evidenceRequired: true,
        waivable: false,
        source: `org-pack/agents/${file}`,
        status: "active",
        needs: [],
        pack: "personas",
        file: `agents/${file}`,
        replaces: [],
        persona: name,
      } as EffectiveRule,
      agent: AgentDefinition.parse({
        schemaVersion: 1,
        id: name,
        role:
          typeof fm.role === "string" && /^[a-z0-9][a-z0-9-]*$/.test(fm.role)
            ? fm.role
            : "reviewer",
        description: `A persona's naysayer as a lens of the critic: ${words}`,
        inputs: ["brief", "proposal", "specs", "design", "stories", "tasks", "catalog-slice"],
        outputArtifact: "findings",
        checklist: "constitution",
        tokenBudget: budget,
        allowedRuntimes: ["hand-off", "model", "headless-claude-code", "mock", "replay"],
      }),
    });
  }
  return out;
}

/** The naysayers that run at `gate`, and a note for each gate id `gates.yaml` lacks. */
export async function personaLensesAt(
  root: string,
  gate: string,
  known: readonly string[],
  budget: number,
): Promise<{ lenses: PersonaLens[]; notes: string[] }> {
  const all = await personaLenses(root, budget);
  const notes = all.flatMap((p) =>
    p.gates
      .filter((g) => !known.includes(g))
      .map(
        (g) => `${p.name} gives gate ${g}, which gates.yaml doesn't have, so it never runs there.`,
      ),
  );
  return { lenses: all.filter((p) => p.gates.includes(gate)), notes };
}

/** A question a naysayer asked of a free-form file (`atticus review`, ADR 0203 C.4). */
export interface PersonaQuestion {
  persona: string;
  line: number;
  question: string;
  /** The quote it rests on, as `<file>:<line>`. */
  evidence: string;
}

/**
 * Each naysayer as a lens over one free-form file, a requirements file, with no change around it
 * (ADR 0203 C.4): Atticus's instructions, output format and quote rule; a question whose quote
 * isn't on the line it cites is dropped and counted. The runs are kept under `.runs/<change>/`,
 * the change reviewed or `atticus-review` for a file outside one, as every run is.
 */
export async function personaReview(
  root: string,
  o: {
    path: string;
    text: string;
    personas: PersonaLens[];
    runtime: AiRuntime;
    change: string;
    now: Date;
    levels: string[];
  },
): Promise<{ questions: PersonaQuestion[]; dropped: number; notes: string[] }> {
  const doc = parseDoc(o.path, o.text);
  const ctx = { root, change: { id: o.change }, answers: [] } as unknown as CriticContext;
  const out = { questions: [] as PersonaQuestion[], dropped: 0, notes: [] as string[] };
  for (const p of o.personas) {
    const pack = buildContextPack({
      change: o.change,
      agent: p.agent.id,
      budget: p.agent.tokenBudget,
      sources: [
        {
          id: "0-instructions",
          kind: "instruction",
          origin: "atticus/review",
          text: [
            `# ${p.name}'s questions of ${o.path}`,
            "",
            personaRule(p.name, o.change),
            "",
            "Artifact lines are numbered as `<n>: <text>`; cite those numbers.",
            "",
            OUTPUT_FORMAT.replace("ANSWERED_LINE", ""),
          ].join("\n"),
          classification: "public",
          trusted: true,
        },
        {
          id: "1-rules",
          kind: "checklist",
          origin: "org-pack/agents",
          text: rulesText([p.rule]),
          classification: "public",
          trusted: true,
        },
        {
          id: o.path,
          kind: "artifact",
          origin: o.path,
          text: numbered(doc),
          classification: "internal",
          priority: 10,
        },
      ],
      levels: o.levels,
      maxClassification: o.levels.includes("internal") ? "internal" : o.levels[0]!,
      now: o.now,
      step: `review ${o.path} (the ${p.name} lens)`,
    });
    const prepared = await o.runtime.prepare({
      change: o.change,
      agent: p.agent,
      pack,
      outputPath: `findings-${p.name}.yaml`,
      outputIn: "run",
      stepClass: "critic",
    });
    const run = await o.runtime.run(prepared.runId);
    if (run.state !== "validated" || run.output === undefined) {
      out.notes.push(
        run.state === "waiting" || run.state === "prepared"
          ? `${p.name} was handed to your assistant (run ${run.runId}); a review can't read a hand-off back yet: give --mode model.`
          : `${p.name} didn't review: ${run.errors.join("; ") || `the run ended ${run.state}`}.`,
      );
      continue;
    }
    const parsed = parseLensOutput(ctx, "complete", run.output, [p.rule], [doc]);
    out.dropped += parsed.discarded.length;
    for (const h of parsed.hits) {
      const e = h.hit.evidence[0]!;
      out.questions.push({
        persona: p.name,
        line: h.hit.locator.line ?? e.line ?? 1,
        question: h.hit.summary,
        evidence: `${o.path}:${e.line ?? 1}`,
      });
    }
  }
  return out;
}
