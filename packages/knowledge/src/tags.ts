import { isMap, isSeq, parseDocument, type YAMLMap } from "yaml";
import { Sources, SOURCE_KIND_SUGGESTIONS } from "@maycombhq/core";

/**
 * Tags on a knowledge source (ADR 0083): which kinds of knowledge it holds, which frameworks
 * it is about, and its owner. `atticus sources tag` writes them into sources.yaml, keeping the
 * rest of the file (comments included) as it was; the change goes through a pull request like
 * any org-pack change.
 */

export { SOURCE_KIND_SUGGESTIONS };

export interface TagChange {
  /** Replace the source's kinds with these. */
  kinds?: string[];
  /** Replace the source's frameworks with these. */
  frameworks?: string[];
  /** Set the source's owner. */
  owner?: string;
}

export type TagResult =
  | {
      ok: true;
      text: string;
      tags: { kinds: string[]; frameworks: string[]; owner?: string };
      /** Kinds that aren't among the suggestions: allowed, said aloud in case of a typo. */
      unusualKinds: string[];
    }
  | { ok: false; error: string };

const slug = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** Split "a, b" and repeated values into tag slugs, without repeats. */
export function tagList(values: string[]): string[] {
  return [
    ...new Set(
      values
        .flatMap((v) => v.split(","))
        .map(slug)
        .filter(Boolean),
    ),
  ];
}

/** Write a source's tags into the text of sources.yaml. */
export function setSourceTags(text: string, sourceId: string, change: TagChange): TagResult {
  const doc = parseDocument(text);
  if (doc.errors.length)
    return { ok: false, error: `sources.yaml can't be read: ${doc.errors[0]!.message}` };
  const wikis = doc.get("wikis");
  if (!isSeq(wikis))
    return { ok: false, error: `sources.yaml has no wikis, so there is no ${sourceId} to tag.` };
  const entry = wikis.items.find((w) => isMap(w) && w.get("id") === sourceId) as
    YAMLMap | undefined;
  if (!entry) {
    const ids = wikis.items.map((w) => (isMap(w) ? String(w.get("id")) : "")).filter(Boolean);
    return {
      ok: false,
      error: `There is no source ${sourceId} in sources.yaml${ids.length ? ` (there is ${ids.join(", ")})` : ""}.`,
    };
  }
  // A flow-style entry ({ id: ..., type: ... }) becomes block style so the tags read well.
  entry.flow = false;
  const current =
    (entry.toJSON() as { tags?: { kinds?: string[]; frameworks?: string[] } }).tags ?? {};
  const kinds = change.kinds ? tagList(change.kinds) : (current.kinds ?? []);
  const frameworks = change.frameworks ? tagList(change.frameworks) : (current.frameworks ?? []);
  const tags: Record<string, string[]> = {};
  if (kinds.length) tags.kinds = kinds;
  if (frameworks.length) tags.frameworks = frameworks;
  if (Object.keys(tags).length) {
    const node = doc.createNode(tags);
    node.flow = false;
    for (const v of node.items) if (isSeq(v.value)) v.value.flow = true;
    entry.set("tags", node);
  } else entry.delete("tags");
  if (change.owner !== undefined) {
    if (change.owner.trim()) entry.set("owner", change.owner.trim());
    else entry.delete("owner");
  }
  const out = doc.toString();
  const check = Sources.safeParse(parseDocument(out).toJSON());
  if (!check.success)
    return {
      ok: false,
      error: check.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    };
  const owner = entry.get("owner");
  return {
    ok: true,
    text: out,
    tags: { kinds, frameworks, ...(typeof owner === "string" ? { owner } : {}) },
    unusualKinds: kinds.filter((k) => !(SOURCE_KIND_SUGGESTIONS as readonly string[]).includes(k)),
  };
}
