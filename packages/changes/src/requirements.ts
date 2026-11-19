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
  /**
   * Each item under `## Planned` with its line, and `by` when it says "not created here, planned
   * by `<change id>`" (the change that plans it; empty when it names none).
   */
  plannedItems: { id: string; line: number; by?: string }[];
  /** Each `## <Role>` section that holds a six-column table, in the file's order. */
  roles: RequirementsRole[];
  /** What can't be read for sure, so is refused: its line, its role if any, and the words. */
  problems: { line: number; role: string; words: string }[];
}

export type RequirementsReasonCode =
  | "requirements.open-question"
  | "requirements.unknown-id"
  | "requirements.unreadable"
  // ADR 0201 addendum, 2026-11-19 (additive): an id under Planned that the map has, and a file
  // and line beside a record that the record doesn't cite.
  | "requirements.planned-exists"
  | "requirements.wrong-line";

/**
 * What the door check reads of the map beyond `has` (ADR 0201 addendum, 2026-11-19). Each is left
 * out by a caller that can't say, and its check then isn't made.
 */
export interface RequirementsMap {
  /** The map itself has the id: a record, a manifest's repo, a name exactly one record has. */
  exists?: (id: string) => boolean;
  /** Whether a change is open and plans an id. */
  plans?: (change: string, id: string) => "plans" | "not-open" | "not-planned";
  /** The files and lines a catalog record cites; undefined when the id is no record. */
  cites?: (id: string) => { path: string; repo?: string; line?: number }[] | undefined;
}

/** How far from a line the map cites a row's line may be. */
const NEAR = 3;

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

/** A line that is a table's row on its face: it starts with a bar, or has five or more. */
const rowLike = (line: string) =>
  line.startsWith("|") || (line.match(/(?<!\\)\|/g)?.length ?? 0) >= 5;

/** A word without the backticks around it or the colon after it. */
const bare = (w: string) => w.replace(/^`+|[`:,;]+$/g, "").trim();

/** The id a list item starts with: its first word, without backticks. */
const firstId = (item: string) => bare(/^`([^`]+)`/.exec(item)?.[1] ?? item.split(/\s+/)[0] ?? "");

/**
 * The change a Planned item says plans its id: "not created here, planned by `<change id>`".
 * Undefined when the item doesn't say so; empty when it says so and names no change.
 */
function plannedBy(item: string): string | undefined {
  const said = /\bnot created here\b.*?\bplanned by\b(.*)$/i.exec(item);
  if (!said) return undefined;
  const ticked = /`([^`]+)`/.exec(said[1]!);
  if (ticked) return bare(ticked[1]!);
  const word = said[1]!
    .split(/\s+/)
    .map((w) => w.replace(/[.,;:()]+$/g, ""))
    .find((w) => w && !/^(the|an?|open|other|same|change|changes)$/i.test(w));
  return word && /^[a-z0-9][a-z0-9._-]*$/.test(word) ? word : "";
}

interface Table {
  /** The header's line, from 1. */
  line: number;
  header: string[];
  rows: { line: number; cells: string[] }[];
}

/**
 * A requirements file's bytes as text: UTF-16 by its byte-order mark (what Windows PowerShell 5
 * writes), else UTF-8, its mark dropped. Text that still holds a NUL is refused by the parser.
 */
export function decodeRequirements(bytes: Uint8Array): string {
  const utf16 =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? "utf-16be"
        : undefined;
  return new TextDecoder(utf16 ?? "utf-8").decode(bytes);
}

/** A `# ` or `## ` heading's level and words, read without a regex that backtracks. */
function headingOf(raw: string): { level: 1 | 2; words: string } | undefined {
  const level = raw.startsWith("## ") ? 2 : raw.startsWith("# ") ? 1 : undefined;
  if (!level) return undefined;
  const text = raw.trimEnd();
  // A closing run of #s after a space is not part of the words.
  let end = text.length;
  while (end > level && text[end - 1] === "#") end -= 1;
  const words = text.slice(level, text[end - 1] === " " ? end : text.length).trim();
  return words ? { level, words } : undefined;
}

/** The number of bars in a line that aren't escaped. */
const bars = (line: string) => line.match(/(?<!\\)\|/g)?.length ?? 0;

export function parseRequirements(text: string): ParsedRequirements {
  const out: ParsedRequirements = { planned: [], plannedItems: [], roles: [], problems: [] };
  if (text.includes("\0")) {
    out.problems.push({ line: 1, role: "", words: "the file isn't text: save it as UTF-8." });
    return out;
  }
  const planned = new Set<string>();
  const lines = text.split(/\r?\n/);
  let section: { kind: "none" | "planned" | "role"; heading: string; tables: Table[] } = {
    kind: "none",
    heading: "",
    tables: [],
  };
  const role = () => (section.kind === "role" ? section.heading : "");
  // The lines taken as a question row, or as part of a table that is refused.
  const taken = new Set<number>();
  // The net under the parser: every line that is a question row on its face.
  const crude: number[] = [];
  // A section's tables are judged together: one questions table makes it a role's section.
  const close = () => {
    const isQuestions = (t: Table) =>
      t.header.length === HEADER.length && t.header.every((c, n) => plain(c) === HEADER[n]);
    const looksLike = (t: Table) =>
      t.header.length === HEADER.length || t.header.some((c) => HEADER.includes(plain(c)));
    const mine = section.tables.filter(isQuestions);
    const rows: RequirementsRole["rows"] = [];
    for (const t of section.tables) {
      const refuse = (why: string) => {
        taken.add(t.line);
        for (const r of t.rows) taken.add(r.line);
        out.problems.push({
          line: t.line,
          role: role(),
          words: `this table${role() ? ` of ${role()}'s questions` : ""} doesn't read: ${why}.`,
        });
      };
      if (isQuestions(t) && role()) rows.push(...t.rows);
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
    for (const r of rows) taken.add(r.line);
    if (role() && mine.length) out.roles.push({ role: role(), rows });
  };
  // The fence that is open, with the line it opened on, and how many blockquotes deep it opened.
  let fence: { char: string; length: number; line: number; depth: number } | undefined;
  // The line an HTML comment opened on, while it is open.
  let comment: number | undefined;
  let table: Table | undefined;
  let afterBlank = false;
  // Each line outside fences, without what HTML comments hold; a quoted table is read as a table.
  const body: (string | undefined)[] = lines.map((raw, i) => {
    // A fence may be inside a blockquote, at any depth: its lines carry the quote's marks, and it
    // ends, closed or not, with the quote it opened in: on the first line with fewer marks.
    const quote = /^ {0,3}(?:> ?)+/.exec(raw)?.[0] ?? "";
    const inner = raw.slice(quote.length);
    const depth = quote.split(">").length - 1;
    if (fence && depth < fence.depth) fence = undefined;
    // Fences as CommonMark has them: three or more of one character, no backtick after a
    // backtick fence's opener; closed by at least as many of the same, and nothing else.
    if (fence) {
      // Any indent closes one (a fence in a list item is indented with it): a line wrongly
      // taken as closing only means more of the file is read.
      const c = /^\s*(`{3,}|~{3,})\s*$/.exec(fence.depth ? inner : raw);
      if (c && c[1]![0] === fence.char && c[1]!.length >= fence.length) fence = undefined;
      return undefined;
    }
    // An opener is indented three spaces at most: four or more, or a tab, is indented code, and
    // taking it as a fence would hide what follows it.
    const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(inner);
    if (comment === undefined && f && !(f[1]![0] === "`" && f[2]!.includes("`"))) {
      fence = { char: f[1]![0]!, length: f[1]!.length, line: i + 1, depth };
      return undefined;
    }
    const kept: string[] = [];
    let at = 0;
    while (at < raw.length) {
      if (comment !== undefined) {
        const end = raw.indexOf("-->", at);
        if (end < 0) break;
        comment = undefined;
        at = end + 3;
      }
      const start = raw.indexOf("<!--", at);
      kept.push(raw.slice(at, start < 0 ? raw.length : start));
      if (start < 0) break;
      comment = i + 1;
      at = start + 4;
    }
    return kept.join("");
  });
  // A fence never closed would hide every table after it, so it is refused where it opens.
  if (fence)
    out.problems.push({
      line: fence.line,
      role: "",
      words: `a code fence opens here and is never closed, so the rest of the file isn't read: close it (${fence.char.repeat(fence.length)}).`,
    });
  if (comment !== undefined)
    out.problems.push({
      line: comment,
      role: "",
      words:
        "an HTML comment opens here and is never closed, so the rest of the file isn't read: close it (-->).",
    });
  const rowOf = (i: number) => (body[i] ?? "").trim().replace(/^(>\s*)+/, "");
  for (let i = 0; i < lines.length; i++) {
    if (body[i] === undefined) {
      table = undefined;
      continue;
    }
    const line = rowOf(i);
    if (bars(line) >= 5) {
      const last = cellsOf(line).findLast((c) => c !== "") ?? "";
      if (STATES.includes(plain(last).replace(/\s/g, ""))) crude.push(i + 1);
    }
    if (/&(#124|#x7c|vert|verbar);/i.test(line) && (role() || line.includes("|")))
      out.problems.push({
        line: i + 1,
        role: role(),
        words:
          "this line writes a bar as &#124;, which isn't read: write the row as a Markdown table's, with \\| for a bar inside a cell.",
      });
    if (role() && /<table[\s>]/i.test(line))
      out.problems.push({
        line: i + 1,
        role: role(),
        words: `${role()} has an HTML table, which isn't read: write its questions as a Markdown table.`,
      });
    // A row over a delimiter row is a header, and always starts a table of its own.
    const header = line.includes("|") && isDelimiter(rowOf(i + 1));
    if (table && !header) {
      if (line === "") {
        afterBlank = true;
        continue;
      }
      // After a blank line, only a row of the table's own width goes on with it.
      const cells = line.includes("|") ? cellsOf(line) : [];
      if (afterBlank ? rowLike(line) && cells.length === table.header.length : cells.length > 0) {
        afterBlank = false;
        if (!isDelimiter(line)) table.rows.push({ line: i + 1, cells });
        continue;
      }
    }
    table = undefined;
    afterBlank = false;
    const h = headingOf(body[i]!.trim());
    if (h) {
      close();
      if (h.level === 1) out.title ??= h.words;
      const kind = h.level === 1 ? "none" : /^planned$/i.test(h.words) ? "planned" : "role";
      section = { kind, heading: h.words, tables: [] };
      continue;
    }
    if (header || rowLike(line)) {
      table = { line: i + 1, header: cellsOf(line), rows: [] };
      section.tables.push(table);
      continue;
    }
    if (section.kind === "planned") {
      const item = /^[-*+]\s+(.+)$/.exec(line)?.[1];
      const id = item ? firstId(item) : "";
      if (id && !planned.has(id)) {
        const by = plannedBy(item!);
        out.plannedItems.push({ id, line: i + 1, ...(by === undefined ? {} : { by }) });
      }
      if (id) planned.add(id);
    }
  }
  close();
  const missed = crude.find((l) => !taken.has(l));
  if (missed !== undefined)
    out.problems.push({
      line: missed,
      role: "",
      words: "this looks like a question row that isn't in a questions table.",
    });
  out.planned = [...planned];
  return out;
}

/** The endings of a file's name, so `pom.xml` is a file and the topic `orders.shipped` is not. */
const FILE_ENDINGS =
  /\.(java|kts?|scala|groovy|gradle|xml|ya?ml|json|properties|toml|ini|conf|cfg|env|sql|[cm]?[jt]sx?|py|rb|go|rs|cs|cshtml|php|html?|s?css|md|txt|sh|ps1|proto|avsc|graphql|tf)$/i;

/** A later word in backticks that names a file, not an id: by its `:line` or its ending. */
const isFile = (w: string) => /:\d+$/.test(w) || FILE_ENDINGS.test(w);

/**
 * The map ids a row's Evidence names. Items are split by `;`, `,` or `<br>`; `-` is none. An
 * item's first word, in backticks or bare, is its id, whatever it looks like. Every other word
 * in backticks is checked too unless it is a file (`src/a.java:41`, `pom.xml`).
 */
export function evidenceIds(cell: string): string[] {
  const ids = cell.split(/[;,]|<br\s*\/?>/i).flatMap((raw) => {
    const item = raw.trim();
    if (item === "" || item === "-") return [];
    const first = /^`([^`]+)`/.exec(item);
    const rest = item.slice(first ? first[0].length : (/^\S+/.exec(item)?.[0].length ?? 0));
    const more = [...rest.matchAll(/`([^`]+)`/g)].map((m) => m[1]!.trim());
    return [
      first ? first[1]!.trim() : bare(item.split(/\s+/)[0]!),
      ...more.filter((w) => !isFile(w)),
    ];
  });
  return [...new Set(ids.filter(Boolean))];
}

/** The `<file>:<line>` an evidence item gives after its id, when its first word is an id. */
function evidenceCites(cell: string): { id: string; path: string; line: number }[] {
  return cell.split(/[;,]|<br\s*\/?>/i).flatMap((raw) => {
    const item = raw.trim();
    if (item === "" || item === "-") return [];
    const first = /^`([^`]+)`/.exec(item);
    const id = first ? first[1]!.trim() : bare(item.split(/\s+/)[0]!);
    const rest = item.slice(first ? first[0].length : (/^\S+/.exec(item)?.[0].length ?? 0));
    return rest
      .split(/\s+/)
      .map((w) => /^`?([^`\s]+):(\d+)`?[.)]?$/.exec(w))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => ({ id, path: m[1]!.replace(/^\.\//, ""), line: Number(m[2]) }));
  });
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
  map: RequirementsMap = {},
): RequirementsCheck {
  const planned = new Set(parsed.planned);
  const inMap = new Set<string>();
  const count = { questions: 0, answered: 0, accepted: 0 };
  const reasons: RequirementsCheck["reasons"] = parsed.problems.map(({ line, role, words }) => ({
    code: "requirements.unreadable",
    line,
    role,
    message: `${file}:${line}: ${words}`,
  }));
  // What is under Planned is planned: not something the map has, and by an open change that
  // plans it when the item says another change does.
  for (const { id, line, by } of parsed.plannedItems) {
    const say = (code: RequirementsReasonCode, words: string) =>
      reasons.push({ code, line, role: "", message: `${file}:${line}: ${words}` });
    if (map.exists?.(id)) {
      say(
        "requirements.planned-exists",
        `${id} is in the map: take it off Planned. "## Planned" lists only what the map doesn't have yet.`,
      );
      continue;
    }
    if (by === undefined) continue;
    const says = `"## Planned" says ${id} is planned by`;
    if (by === "")
      say(
        "requirements.unknown-id",
        `${says} another change and names none. Write it as: \`${id}\`: not created here, planned by \`<change id>\`.`,
      );
    else {
      const plans = map.plans?.(by, id) ?? "plans";
      if (plans === "not-open")
        say(
          "requirements.unknown-id",
          `${says} ${by}, which is not an open change (atticus change list). Name the open change that plans it, or plan it here.`,
        );
      else if (plans === "not-planned")
        say(
          "requirements.unknown-id",
          `${says} ${by}, which doesn't plan it: its requirements file doesn't list it under "## Planned" and its tasks.md has no "## ${id}". Name the open change that plans it, or plan it here.`,
        );
    }
  }
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
      const noAnswer = cells[4] === "" || cells[4] === "-";
      if (state === "open")
        say(
          "requirements.open-question",
          `${role} has an open question: "${cells[0]}". Answer it (State answered) or accept it (State accepted, with who and why), then run this again.`,
        );
      // Closed in name only (b30 proof run): the State says so and nothing says how.
      else if (state === "answered" && noAnswer)
        say(
          "requirements.open-question",
          `${role} has a question answered with no answer: "${cells[0]}". Write the answer under Answer, then run this again.`,
        );
      else if (state === "accepted" && noAnswer)
        say(
          "requirements.open-question",
          `${role} has a question accepted with no reason: "${cells[0]}". Under Answer, say why ${cells[3]} goes on without an answer, then run this again.`,
        );
      else count[state as "answered" | "accepted"] += 1;
      // A file and line beside a record is one the record cites, at or near a line it cites.
      for (const c of map.cites ? evidenceCites(cells[1]!) : []) {
        const known = map.cites!(c.id);
        if (!known?.length) continue;
        // A Windows path reads as its forward-slash form; a bare file name is the record's file
        // of that name when only one of its files has it (the review of b30/proof-fixes).
        const path = c.path.replace(/\\/g, "/");
        const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
        const byName = path.includes("/")
          ? []
          : [...new Set(known.filter((k) => base(k.path) === path).map((k) => k.path))];
        const same = known.filter(
          (k) =>
            path === k.path ||
            path === `${k.repo}/${k.path}` ||
            (byName.length === 1 && k.path === byName[0]),
        );
        if (same.some((k) => k.line === undefined || Math.abs(k.line - c.line) <= NEAR)) continue;
        const where = same.length
          ? `line${same.length === 1 ? "" : "s"} ${same.map((k) => k.line).join(", ")} of that file`
          : [...new Set(known.map((k) => (k.line === undefined ? k.path : `${k.path}:${k.line}`)))]
              .slice(0, 4)
              .join(", ");
        say(
          "requirements.wrong-line",
          `the evidence cites ${c.path}:${c.line} for ${c.id}, which the map read from ${where}. Cite a file and line the map cites for it (atticus context show ${c.id}), or name the id alone.`,
        );
      }
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
