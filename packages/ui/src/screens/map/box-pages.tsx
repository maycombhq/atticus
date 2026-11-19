import type { ReactNode } from "react";
import type { Api } from "@maycombhq/core";
import { COPY } from "../../copy.js";

const B = COPY.boxPages;

/**
 * v30 slice 8: the Map's pages that are about one box, opened from its panel for that box: its
 * contracts, its impact (Impact) and what the AI decided in it (Decided by AI).
 * They were tabs of the Map; each is still a page of its own, found by Ctrl+K.
 */
export function boxPages(node: Api.HierNodeT): ReactNode[] {
  const name = encodeURIComponent(node.label);
  const links: ReactNode[] = [];
  // A repo's or a component's own APIs and calls; an outside system's are its callers' (Declare).
  if (node.kind === "repo" || node.kind === "component")
    links.push(
      <a key="contracts" className="btn" href={`#/contracts?q=${name}`}>
        {B.contracts}
      </a>,
    );
  // A repo box has no record of its own (diagrams' hierarchy): Impact lists its components.
  const impact = node.record
    ? `#/impact?q=${encodeURIComponent(node.record.id)}`
    : node.kind === "repo"
      ? `#/impact?repo=${name}`
      : undefined;
  if (impact)
    links.push(
      <a key="impact" className="btn" href={impact}>
        {B.impact}
      </a>,
    );
  if (node.kind === "repo")
    links.push(
      <a key="decisions" className="btn" href={`#/decisions?repo=${name}`}>
        {B.decisions}
      </a>,
    );
  return links;
}
