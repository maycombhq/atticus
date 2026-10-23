/**
 * A change's picture in Copilot Chat (ADR 0108): `atticus change map <change> --json` as
 * Markdown, the Mermaid in a block the chat draws, the marks said in words beside it.
 */

export interface ChangeMapJson {
  change: string;
  title: string;
  source: string;
  nodes: { id: string; legend?: "new" | "modify" | "retire" }[];
  edges: { legend?: "new" | "modify" | "retire" }[];
  mermaid: string;
  flows: number;
  problems: string[];
}

export const changeDiagramHash = (change: string) =>
  `#/change-diagram?change=${encodeURIComponent(change)}`;

/** The app's Estimate on one change (ADR 0109). */
export const estimateHash = (change: string) => `#/estimate?change=${encodeURIComponent(change)}`;

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What the chat shows: the picture, what it marks, and what couldn't be drawn. */
export function changeMapMarkdown(m: ChangeMapJson): string {
  if (!m.flows)
    return `${m.change} has no target flows yet, so there is nothing to draw. Its architecture stage writes them: /architecture ${m.change}`;
  const parts = (l: string) =>
    m.nodes.filter((n) => n.legend === l).length + m.edges.filter((e) => e.legend === l).length;
  const lines = [
    `**${m.title}** (${m.change}), drawn from ${count(m.flows, "target flow", "target flows")} in ${m.source}: ${parts("new")} + new, ${parts("modify")} ◇ changed, ${parts("retire")} ✕ retired; unmarked parts are there for context.`,
    "",
    "```mermaid",
    m.mermaid.trimEnd(),
    "```",
  ];
  if (m.problems.length) lines.push("", "Couldn't be drawn:", ...m.problems.map((p) => `- ${p}`));
  return lines.join("\n");
}
