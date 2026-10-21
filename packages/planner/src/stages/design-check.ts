import type { DesignRead } from "./figma.js";
import type { StageIssue } from "./loop.js";
import type { FeaturePlacement } from "./schema.js";
import { endpointKey } from "./estate.js";

/**
 * The deterministic checks of a design mapped against the estate (ADR 0087): every element
 * named is one the reader found; every field and action the reader found is mapped or set
 * aside with a reason; an existing field says what backs it and that is in the estate; a new
 * or unbacked field says what is missing; an action names a call the estate serves, or a gap.
 */

export type DesignAnswer = NonNullable<FeaturePlacement["design"]>;

export interface DesignKnown {
  /** Whether a catalog or flow id exists. */
  id(id: string): boolean;
  /** "METHOD /path" keys (endpointKey) the estate serves. */
  endpoints: Set<string>;
}

const NAV = /^(none|navigation)\b/i;

export function checkDesign(d: DesignAnswer, read: DesignRead, known: DesignKnown): StageIssue[] {
  const out: StageIssue[] = [];
  const issue = (rule: string, target: string, message: string) =>
    out.push({ rule, target, message, blocking: true });
  const mapped = new Set<string>();
  for (const i of d.ignored ?? []) mapped.add(i.figmaId);
  for (const s of d.screens) {
    if (!read.ids.has(s.figmaId))
      issue(
        "design.unknown-element",
        s.figmaId,
        `Screen ${s.figmaId} "${s.name}" isn't in the design file.`,
      );
    if (s.flow && !known.id(s.flow))
      issue(
        "design.unknown-ref",
        `${s.figmaId}:${s.flow}`,
        `Screen "${s.name}" names flow ${s.flow}, which isn't in the estate.`,
      );
    for (const f of s.fields) {
      mapped.add(f.figmaId);
      if (!read.ids.has(f.figmaId))
        issue(
          "design.unknown-element",
          f.figmaId,
          `Field ${f.figmaId} "${f.label}" isn't in the design file.`,
        );
      if (f.backing === "existing" && !f.mapsTo?.trim() && f.refs.length === 0)
        issue(
          "design.no-mapping",
          f.figmaId,
          `Field "${f.label}" (${f.figmaId}) is marked existing but says nothing about what backs it: name the API field and column.`,
        );
      if (f.backing !== "existing" && !f.gap?.trim())
        issue(
          "design.no-gap",
          f.figmaId,
          `Field "${f.label}" (${f.figmaId}) is ${f.backing} but names no gap: say what has to be added.`,
        );
      for (const r of f.refs)
        if (!known.id(r))
          issue(
            "design.unknown-ref",
            `${f.figmaId}:${r}`,
            `Field "${f.label}" cites ${r}, which isn't in the estate. Cite an id from the index, or mark the field new.`,
          );
    }
    for (const a of s.actions) {
      mapped.add(a.figmaId);
      if (!read.ids.has(a.figmaId))
        issue(
          "design.unknown-element",
          a.figmaId,
          `Action ${a.figmaId} "${a.label}" isn't in the design file.`,
        );
      const ep = a.endpoint?.trim();
      if (ep && !NAV.test(ep) && !known.endpoints.has(endpointKey(ep)))
        issue(
          "design.unknown-endpoint",
          `${a.figmaId}:${endpointKey(ep)}`,
          `Action "${a.label}" (${a.figmaId}) calls ${ep}, which the estate doesn't serve. Name an endpoint it serves, or write the missing one as a gap.`,
        );
      if (!ep && !a.gap?.trim())
        issue(
          "design.action-unmapped",
          a.figmaId,
          `Action "${a.label}" (${a.figmaId}) names no call and no gap: name the endpoint, "none" for navigation, or the gap.`,
        );
      if (a.flow && !known.id(a.flow))
        issue(
          "design.unknown-ref",
          `${a.figmaId}:${a.flow}`,
          `Action "${a.label}" names flow ${a.flow}, which isn't in the estate.`,
        );
    }
  }
  for (const s of read.screens)
    for (const x of [...s.fields, ...s.actions])
      if (!mapped.has(x.figmaId))
        issue(
          "design.not-mapped",
          x.figmaId,
          `"${x.label}" (${x.figmaId}) on "${s.name}" is neither mapped nor set aside: map it, or list it under ignored with why.`,
        );
  return out;
}

/** Every gap the design implies, as feature gaps: a field or action with no backing is a gap. */
export function designGaps(d: DesignAnswer): FeaturePlacement["gaps"] {
  const out: FeaturePlacement["gaps"] = [];
  for (const s of d.screens) {
    for (const f of s.fields)
      if (f.gap?.trim())
        out.push({
          what: f.gap.trim(),
          why: `"${f.label}" on "${s.name}" is ${f.backing}`,
          from: f.figmaId,
        });
    for (const a of s.actions)
      if (a.gap?.trim())
        out.push({
          what: a.gap.trim(),
          why: `"${a.label}" on "${s.name}" has nothing to call`,
          from: a.figmaId,
        });
  }
  return out;
}
