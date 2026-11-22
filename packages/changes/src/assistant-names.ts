import { readdirSync } from "node:fs";
import { join } from "node:path";
import { BUILT_IN_AGENTS, orgPackDirOf } from "@maycombhq/core";
import type { ChangeContext } from "./context.js";

/** Atticus's own agents (in core, so every reader of a resolution knows them). */
export { BUILT_IN_AGENTS };

/**
 * The names that are an AI's in this metarepo, besides the built-in ones: Atticus's own agents,
 * the org pack's agents (its YAML definitions and, with the root, its persona files) and models.
 */
export function assistantNames(
  lifecycle: Pick<ChangeContext, "orgPack"> & { root?: string },
): string[] {
  const rt = lifecycle.orgPack.runtime as { models?: { allowed?: string[] } };
  const personas = lifecycle.root
    ? (() => {
        try {
          return readdirSync(join(orgPackDirOf(lifecycle.root), "agents"))
            .filter((f) => f.endsWith(".md"))
            .map((f) => f.slice(0, -3));
        } catch {
          return [];
        }
      })()
    : [];
  return [
    ...BUILT_IN_AGENTS,
    ...lifecycle.orgPack.agents.map((a) => a.id),
    ...personas,
    ...(rt.models?.allowed ?? []),
  ];
}
