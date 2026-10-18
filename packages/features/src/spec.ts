import type { CatalogRecord } from "@maycombhq/core";
import type { Capability } from "./detect.js";
import { FeatureError } from "./decisions.js";
import { FlowGraph } from "./graph.js";

/**
 * Seed an OpenSpec capability spec from a confirmed feature (ADR 0031), so the as-is
 * specification starts from real code. The draft has one requirement per entry point, each
 * with a WHEN/THEN scenario whose result a person still has to describe; it is written as
 * `openspec/specs/<capability>/spec.md` only where no spec exists (the CLI never overwrites).
 */

export interface SpecDraft {
  /** Metarepo-relative path of the spec. */
  path: string;
  /** The capability folder name. */
  capability: string;
  text: string;
}

export function featureToSpec(feature: Capability, records: readonly CatalogRecord[]): SpecDraft {
  if (feature.namedBy !== "person")
    throw new FeatureError(
      `${feature.id} isn't confirmed yet: name it with atticus feature name first`,
    );
  const g = new FlowGraph(records);
  const capability = feature.id.replace(/^feature\./, "");
  const who = [
    ...new Set(feature.evidence.filter((e) => e.source === "manual" && e.by).map((e) => e.by!)),
  ];
  const where = (id: string) =>
    (g.records.get(id)?.evidence ?? [])
      .filter((e) => e.path)
      .map((e) => `${e.repo ? `${e.repo} ` : ""}${e.path}${e.line ? `:${e.line}` : ""}`)
      .join(", ");

  const requirements: string[] = [];
  for (const id of feature.entryPoints) {
    const e = g.endpoints.get(id);
    const i = g.interfaces.get(id);
    const s = g.settings.get(id);
    const c = g.components.get(id);
    if (e) {
      const op = `${e.method ? `${e.method} ` : ""}${e.pathOrTopic}`;
      requirements.push(
        `### Requirement: ${op}`,
        `The system SHALL serve ${op} on ${e.component}.`,
        "",
        `#### Scenario: ${op} is called`,
        `- **WHEN** a caller sends ${op} to ${e.component}`,
        `- **THEN** ${e.component} answers <!-- describe the observable result -->`,
        "",
      );
    } else if (i) {
      requirements.push(
        `### Requirement: Handle ${i.normalizedPath}`,
        `The system SHALL start work in ${i.to} when ${i.from} publishes ${i.normalizedPath}.`,
        "",
        `#### Scenario: ${i.normalizedPath} is published`,
        `- **WHEN** ${i.from} publishes ${i.normalizedPath}`,
        `- **THEN** ${i.to} handles it <!-- describe what it does next -->`,
        "",
      );
    } else if (s) {
      requirements.push(
        `### Requirement: Run ${s.key.replace(/^schedule\./, "")}`,
        `The system SHALL run ${s.component} on the schedule ${s.valueOrRef}.`,
        "",
        `#### Scenario: the schedule fires`,
        `- **WHEN** the schedule ${s.valueOrRef} fires`,
        `- **THEN** ${s.component} runs <!-- describe what it produces -->`,
        "",
      );
    } else if (c) {
      requirements.push(
        `### Requirement: Run ${c.id}`,
        `The system SHALL run the ${c.id} batch job.`,
        "",
        `#### Scenario: the job runs`,
        `- **WHEN** ${c.id} is started`,
        `- **THEN** it completes <!-- describe what it produces -->`,
        "",
      );
    }
  }

  const lines = [
    `# ${feature.name} Specification`,
    "",
    `<!-- Drafted by Atticus from feature ${feature.id}${who.length ? `, confirmed by ${who.join(", ")}` : ""}. The requirements say what the code does today: check each one and describe its results before this spec is merged. -->`,
    "",
    "## Purpose",
    "",
    feature.description ?? `${feature.name}.`,
    "",
    "Where it is in code:",
    "",
    ...feature.entryPoints.map((id) => `- ${id}: ${where(id) || "no file recorded"}`),
    "",
    "## Requirements",
    "",
    ...requirements,
  ];
  return {
    path: `openspec/specs/${capability}/spec.md`,
    capability,
    text: lines.join("\n").replace(/\n+$/, "\n"),
  };
}
