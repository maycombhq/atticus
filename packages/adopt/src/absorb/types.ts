/** What absorb finds in another team's repo and what it proposes for each piece. */

export type ItemKind =
  | "prompt"
  | "agent"
  | "instructions"
  | "skill"
  | "critic-rule"
  | "schema"
  /** A TypeSpec source file (.tsp): a reference with its namespace, operations and models. */
  | "typespec"
  | "constitution-principle"
  | "speckit-template"
  | "speckit-spec"
  | "speckit-plan"
  | "speckit-command"
  | "speckit-script"
  | "openspec-spec"
  | "openspec-change"
  | "openspec-config"
  | "atticus-orgpack"
  | "atticus-catalog"
  | "atticus-change"
  /** Documentation about the repo itself (README, LICENSE...): nothing to absorb. */
  | "doc"
  /** Code and build files, as one item: the scan reads code; absorb doesn't. */
  | "code"
  /** A file absorb could not place. Counts against the translated share. */
  | "other";

/** Kinds that are never translated by design; left out of the translated share. */
export const NOT_TRANSLATABLE: ReadonlySet<ItemKind> = new Set(["doc", "code"]);

export type Action = "adopt" | "link" | "ignore";
export type Confidence = "high" | "medium" | "low";

/** A translated artifact, at its path inside the proposal folder. */
export interface Artifact {
  path: string;
  content: string;
}

export interface AbsorbItem {
  /** Stable id: `<kind>:<path>` (plus `#<n>` for one item of a list). */
  id: string;
  kind: ItemKind;
  /** Path in the absorbed repo, forward slashes. */
  path: string;
  line?: number;
  title: string;
  action: Action;
  reason: string;
  confidence: Confidence;
  /** True when the item has an Atticus-terms counterpart (its artifact, or one Atticus has). */
  translated: boolean;
  artifact?: Artifact;
  /** The item or built-in this one is the same as. */
  sameAs?: string;
}
