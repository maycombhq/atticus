import { join } from "node:path";
import { ChecklistRule, type Lens } from "@maycombhq/core";
import { changeFolder, writeFileAtomic } from "@maycombhq/changes";
import type { QuarantineItem } from "@maycombhq/ai";
import type { RuledHit } from "./findings.js";
import type { EffectiveRule } from "./rules.js";

/**
 * Ingested-content defences at the agents (ADR 0042). A context pack leaves out any source the
 * defences rate high risk and records the decision in `pack.defences`. This file turns that
 * record into two things a person can act on: the quarantine items written under the change
 * (`review/defences/<id>.json`), and, for the critic, a knowledge gap per quarantined source.
 */

export const QUARANTINE_RULE = "defences-quarantine";

/**
 * Write the quarantine items of one agent run under the change folder, as
 * `review/defences/<id>.json` (id: the gate and round, or a run id). Writes nothing and returns
 * undefined when there are none. Returns the path relative to the change folder.
 */
export async function writeQuarantineItems(
  root: string,
  change: string,
  id: string,
  items: readonly QuarantineItem[],
): Promise<string | undefined> {
  if (items.length === 0) return undefined;
  const rel = `review/defences/${id}.json`;
  await writeFileAtomic(
    join(changeFolder(root, change), rel),
    `${JSON.stringify(items, null, 2)}\n`,
  );
  return rel;
}

/** The built-in rule behind the critic's quarantine gaps, one per lens (never waivable). */
export function quarantineRule(lens: Lens): EffectiveRule {
  const rule = ChecklistRule.parse({
    id: QUARANTINE_RULE,
    title: "Nothing the defences quarantine is reviewed without a person",
    description:
      "A source rated high risk (hidden, encoded or disguised instructions) is left out of the AI lens that wanted it; a person decides what to do with it.",
    layer: "constitution",
    lens,
    appliesTo: { artifacts: ["catalog"] },
    severity: "risk",
    check: { type: "deterministic", check: QUARANTINE_RULE, params: {} },
    waivable: false,
    source: "Atticus defences for ingested content (ADR 0042)",
  });
  return {
    ...rule,
    effectiveLayer: "constitution",
    pack: "built-in",
    file: "built-in",
    replaces: [],
  };
}

/**
 * A knowledge gap for a person for every quarantined source: the lens that wanted the source
 * could not read it. `isArtifact` says whether a source id is a change artifact (otherwise the
 * gap is about the catalog slice). One gap per source and file hash, whichever lens saw it first.
 */
export function quarantineHits(
  lens: Lens,
  owner: string,
  items: readonly QuarantineItem[],
  isArtifact: (source: string) => boolean,
): RuledHit[] {
  const rule = quarantineRule(lens);
  return items.map((item) => {
    const artifact = isArtifact(item.source);
    const first = item.signals[0];
    return {
      rule,
      layer: "deterministic" as const,
      also: [],
      hit: {
        kind: "knowledge-gap" as const,
        artifact: artifact ? item.source : "catalog",
        locator: artifact ? { line: first?.line ?? 1 } : { heading: item.source },
        summary: `Left out of the ${lens} lens: ${item.summary}`.slice(0, 200),
        why: item.why,
        fix: { text: item.fix },
        evidence: [
          artifact
            ? {
                source: "artifact" as const,
                path: item.source,
                ...(first ? { line: first.line } : {}),
              }
            : { source: "catalog" as const, path: item.source },
        ],
        question: { text: item.question, owner },
        key: `defences|${item.source}|${item.sha256}`,
      },
    };
  });
}
