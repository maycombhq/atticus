/**
 * The requirements file a quick change starts from (ADR 0201), and the one deterministic check at
 * the quick path's door. Free-form Markdown; three things in it are read: the first `# ` heading
 * (the title), the ids listed under `## Planned`, and each role's table of questions. No I/O and
 * no model: the caller reads the file and says which ids the map has.
 */

/** The requirements file a quick change was made from, in its change folder. */
export const REQUIREMENTS_FILE = "requirements.md";

/** The six cells of a role's table, in order (any case). */
const HEADER = ["question", "evidence", "asked by", "answered by", "answer", "state"];
const STATES = ["open", "answered", "accepted"];

export interface RequirementsRow {
  /** The row's line in the file, from 1. */
  line: number;
  /** Its cells as written, trimmed. Six when the row reads. */
  cells: string[];
}

export interface RequirementsRole {
  /** The `## <Role>` heading's words. */
  role: string;
  rows: RequirementsRow[];
}

export interface ParsedRequirements {
  /** The first `# ` heading. */
  title?: string;
  /** The ids under `## Planned`: what the change plans, or what nobody has read yet. */
  planned: string[];
  /** Each `## <Role>` section that holds a six-column table, in the file's order. */
  roles: RequirementsRole[];
}

export type RequirementsReasonCode =
  "requirements.open-question" | "requirements.unknown-id" | "requirements.unreadable";

export interface RequirementsReason {
  code: RequirementsReasonCode;
  line: number;
  role: string;
  message: string;
}

export interface RequirementsCheck {
  ok: boolean;
  reasons: RequirementsReason[];
  /** Role sections with a table; none means no persona asked a question. */
  roles: number;
  questions: number;
  answered: number;
  accepted: number;
  /** The evidence ids the map has, each once. */
  inMap: number;
  /** The ids listed under Planned. */
  planned: number;
}

/** A table row's cells: split on `|` (a `\|` is a bar in a cell), the outer bars dropped. */
function cellsOf(line: string): string[] {
  const parts = line.trim().split(/(?<!\\)\|/);
  if (parts[0]?.trim() === "") parts.shift();
  if (parts.at(-1)?.trim() === "") parts.pop();
  return parts.map((c) => c.trim().replace(/\\\|/g, "|"));
}

/** The id an item starts with: its first word, without backticks or the colon after it. */
function firstId(item: string): string {
  const t = item.trim();
  const ticked = /^`([^`]+)`/.exec(t);
  return (ticked ? ticked[1]! : (t.split(/\s+/)[0] ?? "")).replace(/[`:,]+$/, "").trim();
}

export function parseRequirements(text: string): ParsedRequirements {
  const out: ParsedRequirements = { planned: [], roles: [] };
  let section: "none" | "planned" | "role" = "none";
  let heading = "";
  let role: RequirementsRole | undefined;
  let inTable = false;
  let fence: string | undefined;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    const f = /^(```+|~~~+)/.exec(line)?.[1];
    if (f && (fence === undefined || f.startsWith(fence))) {
      fence = fence === undefined ? f : undefined;
      inTable = false;
      return;
    }
    if (fence !== undefined) return;
    const h = /^(#{1,2})\s+(.+?)\s*#*$/.exec(line);
    if (h) {
      inTable = false;
      role = undefined;
      if (h[1] === "#") {
        out.title ??= h[2]!;
        section = "none";
      } else {
        heading = h[2]!;
        section = /^planned$/i.test(heading) ? "planned" : "role";
      }
      return;
    }
    if (section === "planned") {
      const item = /^[-*+]\s+(.+)$/.exec(line)?.[1];
      const id = item ? firstId(item) : "";
      if (id && !out.planned.includes(id)) out.planned.push(id);
      return;
    }
    if (section !== "role") return;
    if (!line.startsWith("|")) {
      inTable = false;
      return;
    }
    const cells = cellsOf(line);
    if (!inTable) {
      // Only a table with the six cells is a role's questions; any other is free text.
      if (
        cells.length === HEADER.length &&
        cells.every((c, n) => c.replace(/\s+/g, " ").toLowerCase() === HEADER[n])
      ) {
        inTable = true;
        if (!role) out.roles.push((role = { role: heading, rows: [] }));
      }
      return;
    }
    if (cells.length && cells.every((c) => /^:?-+:?$/.test(c))) return;
    role!.rows.push({ line: i + 1, cells });
  });
  return out;
}

/** The map ids a row's Evidence names: `-` is none; items are split by `;`, the id first. */
function evidenceIds(cell: string): string[] {
  if (cell === "" || cell === "-") return [];
  return [...new Set(cell.split(";").map(firstId).filter(Boolean))];
}

/**
 * The check at the quick path's door: every question closed, every evidence id in the map
 * (`has`) or listed under Planned, every row readable. `file` is how the messages name the file.
 */
export function checkRequirements(
  parsed: ParsedRequirements,
  has: (id: string) => boolean,
  file = "requirements.md",
): RequirementsCheck {
  const reasons: RequirementsReason[] = [];
  const planned = new Set(parsed.planned);
  const inMap = new Set<string>();
  let questions = 0;
  let answered = 0;
  let accepted = 0;
  for (const { role, rows } of parsed.roles)
    for (const { line, cells } of rows) {
      questions += 1;
      const at = `${file}:${line}:`;
      const unreadable = (why: string) =>
        reasons.push({
          code: "requirements.unreadable",
          line,
          role,
          message: `${at} this row of ${role}'s questions doesn't read: ${why}.`,
        });
      if (cells.length !== HEADER.length) {
        unreadable(`it has ${cells.length} cells, not the six of its header`);
        continue;
      }
      const [question, evidence, , answeredBy, , stateCell] = cells as [
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      const state = stateCell.toLowerCase();
      if (!STATES.includes(state)) {
        unreadable(`its State is "${stateCell}", not open, answered or accepted`);
        continue;
      }
      if (state !== "open" && (answeredBy === "" || answeredBy === "-")) {
        unreadable(`it is ${state} and names nobody under Answered by`);
        continue;
      }
      if (state === "answered") answered += 1;
      if (state === "accepted") accepted += 1;
      if (state === "open")
        reasons.push({
          code: "requirements.open-question",
          line,
          role,
          message: `${at} ${role} has an open question: "${question}". Answer it (State answered) or accept it (State accepted, with who and why), then run this again.`,
        });
      for (const id of evidenceIds(evidence)) {
        if (has(id)) inMap.add(id);
        else if (!planned.has(id))
          reasons.push({
            code: "requirements.unknown-id",
            line,
            role,
            message: `${at} the evidence names ${id}, which is not in the map and not listed under "## Planned". Name an id the map has (atticus query ${id}), or list it under Planned.`,
          });
      }
    }
  reasons.sort((a, b) => a.line - b.line);
  return {
    ok: reasons.length === 0,
    reasons,
    roles: parsed.roles.length,
    questions,
    answered,
    accepted,
    inMap: inMap.size,
    planned: planned.size,
  };
}
