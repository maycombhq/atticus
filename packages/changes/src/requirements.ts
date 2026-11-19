/**
 * The requirements file a quick change starts from (ADR 0201), and the one deterministic check at
 * the quick path's door. Free-form Markdown; three things in it are read: the first `# ` heading
 * (the title), the ids listed under `## Planned`, and each role's table of questions. No I/O and
 * no model: the caller reads the file and says which ids the map has. It is the only check on
 * the quick path, so a table it can't be sure of is refused, never passed over.
 */

/** The requirements file a quick change was made from, in its change folder. */
export const REQUIREMENTS_FILE = "requirements.md";

/** The six cells of a role's table, in order (any case, emphasis aside). */
const HEADER = ["question", "evidence", "asked by", "answered by", "answer", "state"];
const STATES = ["open", "answered", "accepted"];

export interface RequirementsRole {
  /** The `## <Role>` heading's words. */
  role: string;
  /** Each row's line in the file (from 1) and its cells as written, trimmed. */
  rows: { line: number; cells: string[] }[];
}

export interface ParsedRequirements {
  /** The first `# ` heading. */
  title?: string;
  /** The ids under `## Planned`: what the change plans, or what nobody has read yet. */
  planned: string[];
  /** Each `## <Role>` section that holds a six-column table, in the file's order. */
  roles: RequirementsRole[];
  /** Tables that can't be read as a role's questions, each with its line and why. */
  problems: { line: number; role: string; why: string }[];
}

export type RequirementsReasonCode =
  "requirements.open-question" | "requirements.unknown-id" | "requirements.unreadable";

export interface RequirementsCheck {
  ok: boolean;
  reasons: { code: RequirementsReasonCode; line: number; role: string; message: string }[];
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
  const parts = line.split(/(?<!\\)\|/);
  if (parts[0]?.trim() === "") parts.shift();
  if (parts.at(-1)?.trim() === "") parts.pop();
  return parts.map((c) => c.trim().replace(/\\\|/g, "|"));
}

/** A header cell without its emphasis, in one case. */
const plain = (c: string) => c.replace(/[*_`]/g, "").replace(/\s+/g, " ").trim().toLowerCase();

/** The row under a table's header: `| --- | :-: |`, with or without the outer bars. */
const isDelimiter = (line: string) =>
  line.includes("|") && line.includes("-") && /^[\s|:-]+$/.test(line);

/** A word without the backticks around it or the colon after it. */
const bare = (w: string) => w.replace(/^`+|[`:,;]+$/g, "").trim();

/** The id a list item starts with: its first word, without backticks. */
const firstId = (item: string) => bare(/^`([^`]+)`/.exec(item)?.[1] ?? item.split(/\s+/)[0] ?? "");

interface Table {
  /** The header's line, from 1. */
  line: number;
  header: string[];
  rows: { line: number; cells: string[] }[];
}

export function parseRequirements(text: string): ParsedRequirements {
  const out: ParsedRequirements = { planned: [], roles: [], problems: [] };
  const planned = new Set<string>();
  const lines = text.split(/\r?\n/);
  // A quoted table is read as the table it is.
  const body = lines.map((l) => l.trim().replace(/^(>\s*)+/, ""));
  let section: { kind: "none" | "planned" | "role"; heading: string; tables: Table[] } = {
    kind: "none",
    heading: "",
    tables: [],
  };
  // A section's tables are judged together: one questions table makes it a role's section.
  const close = () => {
    const isQuestions = (t: Table) =>
      t.header.length === HEADER.length && t.header.every((c, n) => plain(c) === HEADER[n]);
    const looksLike = (t: Table) =>
      t.header.length === HEADER.length || t.header.some((c) => HEADER.includes(plain(c)));
    const role = section.kind === "role" ? section.heading : "";
    const mine = section.tables.filter(isQuestions);
    const rows: RequirementsRole["rows"] = [];
    for (const t of section.tables) {
      const refuse = (why: string) => out.problems.push({ line: t.line, role, why });
      if (isQuestions(t) && role) rows.push(...t.rows);
      else if (isQuestions(t))
        refuse(
          section.kind === "planned"
            ? 'a table of questions is under "## Planned", not under a "## <Role>" heading'
            : 'a table of questions is under no "## <Role>" heading',
        );
      else if (looksLike(t) || mine.length)
        refuse(
          `its header is ${t.header.map((c) => `"${c}"`).join(", ")}, not the six columns Question, Evidence, Asked by, Answered by, Answer, State`,
        );
    }
    if (role && mine.length) out.roles.push({ role, rows });
  };
  let fence: { char: string; length: number } | undefined;
  let table: Table | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = body[i]!;
    // Fences as CommonMark has them: three or more of one character, no backtick after a
    // backtick fence's opener; closed by at least as many of the same, and nothing else.
    const f = /^(`{3,}|~{3,})(.*)$/.exec(lines[i]!.trim());
    if (fence) {
      if (f && f[1]![0] === fence.char && f[1]!.length >= fence.length && !f[2]!.trim())
        fence = undefined;
      continue;
    }
    if (f && !(f[1]![0] === "`" && f[2]!.includes("`"))) {
      fence = { char: f[1]![0]!, length: f[1]!.length };
      table = undefined;
      continue;
    }
    if (table) {
      if (line === "") {
        // A blank line ends the table unless a row follows it.
        const next = body.slice(i + 1).find((l) => l !== "");
        if (!next?.startsWith("|")) table = undefined;
        continue;
      }
      if (line.includes("|")) {
        if (!isDelimiter(line)) table.rows.push({ line: i + 1, cells: cellsOf(line) });
        continue;
      }
      table = undefined;
    }
    const h = /^(#{1,2})\s+(.+?)\s*#*$/.exec(lines[i]!.trim());
    if (h) {
      close();
      if (h[1] === "#") out.title ??= h[2]!;
      const kind = h[1] === "#" ? "none" : /^planned$/i.test(h[2]!) ? "planned" : "role";
      section = { kind, heading: h[2]!, tables: [] };
      continue;
    }
    if (line.startsWith("|") || (line.includes("|") && isDelimiter(body[i + 1] ?? ""))) {
      table = { line: i + 1, header: cellsOf(line), rows: [] };
      section.tables.push(table);
      continue;
    }
    if (section.kind === "planned") {
      const item = /^[-*+]\s+(.+)$/.exec(line)?.[1];
      const id = item ? firstId(item) : "";
      if (id) planned.add(id);
    }
  }
  close();
  out.planned = [...planned];
  return out;
}

/**
 * The map ids a row's Evidence names: `-` is none; items are split by `;` or `,`. In an item,
 * every word in backticks that isn't a file (`src/a.java:41`, `pom.xml:7`) is an id or a name
 * (an entry's path starts with `/`); with none, its first word.
 */
function evidenceIds(cell: string): string[] {
  if (cell === "" || cell === "-") return [];
  const ids = cell.split(/[;,]/).flatMap((item) => {
    const ticked = [...item.matchAll(/`([^`]+)`/g)].map((m) => m[1]!.trim());
    const named = ticked.filter((w) => !/^[^/]+[\\/]|:\d+$/.test(w));
    return ticked.length ? named : [bare(item.trim().split(/\s+/)[0] ?? "")];
  });
  return [...new Set(ids.filter(Boolean))];
}

/**
 * The check at the quick path's door: every question closed, every evidence id in the map
 * (`has`: true, or the ids of the several records a name matches, which is refused) or listed
 * under Planned, every table and row readable. `file` is how the messages name the file.
 */
export function checkRequirements(
  parsed: ParsedRequirements,
  has: (id: string) => boolean | readonly string[],
  file = "requirements.md",
): RequirementsCheck {
  const planned = new Set(parsed.planned);
  const inMap = new Set<string>();
  const count = { questions: 0, answered: 0, accepted: 0 };
  const reasons: RequirementsCheck["reasons"] = parsed.problems.map(({ line, role, why }) => ({
    code: "requirements.unreadable",
    line,
    role,
    message: `${file}:${line}: this table${role ? ` of ${role}'s questions` : ""} doesn't read: ${why}.`,
  }));
  for (const { role, rows } of parsed.roles)
    for (const { line, cells } of rows) {
      count.questions += 1;
      const say = (code: RequirementsReasonCode, words: string) =>
        reasons.push({ code, line, role, message: `${file}:${line}: ${words}` });
      const unreadable = (why: string) =>
        say("requirements.unreadable", `this row of ${role}'s questions doesn't read: ${why}.`);
      if (cells.length !== HEADER.length) {
        unreadable(`it has ${cells.length} cells, not the six of its header`);
        continue;
      }
      const state = cells[5]!.toLowerCase();
      if (!STATES.includes(state)) {
        unreadable(`its State is "${cells[5]}", not open, answered or accepted`);
        continue;
      }
      if (state !== "open" && (cells[3] === "" || cells[3] === "-")) {
        unreadable(`it is ${state} and names nobody under Answered by`);
        continue;
      }
      if (state === "open")
        say(
          "requirements.open-question",
          `${role} has an open question: "${cells[0]}". Answer it (State answered) or accept it (State accepted, with who and why), then run this again.`,
        );
      else count[state as "answered" | "accepted"] += 1;
      for (const id of evidenceIds(cells[1]!)) {
        const found = has(id);
        if (found === true) inMap.add(id);
        else if (found !== false)
          say(
            "requirements.unknown-id",
            `the evidence names ${id}, which matches several records of the map (${found.join(", ")}). Name the id of the one meant.`,
          );
        else if (!planned.has(id))
          say(
            "requirements.unknown-id",
            `the evidence names ${id}, which is not in the map and not listed under "## Planned". Name an id the map has (atticus query ${id}), or list it under Planned.`,
          );
      }
    }
  reasons.sort((a, b) => a.line - b.line);
  return {
    ok: reasons.length === 0,
    reasons,
    roles: parsed.roles.length,
    ...count,
    inMap: inMap.size,
    planned: planned.size,
  };
}
