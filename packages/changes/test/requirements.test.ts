import { describe, expect, it } from "vitest";
import { checkRequirements, decodeRequirements, parseRequirements } from "../src/index.js";

/** ADR 0201: the requirements file a quick change starts from, and the check at its door. */

const HEADER =
  "| Question | Evidence | Asked by | Answered by | Answer | State |\n| --- | --- | --- | --- | --- | --- |";

const file = (rows: string[], extra = "") =>
  [
    "# Shipped-orders event",
    "",
    "Free text: what is wanted and why.",
    "",
    "## Planned",
    "",
    "- `forge-portal`: the new portal's repo",
    "- forge.orders.shipped: the new topic",
    "",
    "## Application architect",
    "",
    "Free text: this role's part of the requirement.",
    "",
    HEADER,
    ...rows,
    extra,
  ].join("\n");

/** The map of these tests: two catalog records, and a manifest repo nobody has read. */
const records = new Set(["forge-ledger", "forge-orders.place-order"]);
const manifestRepos = new Set(["forge-ledger", "forge-billing"]);
const has = (id: string) => records.has(id) || manifestRepos.has(id);

const answered =
  "| Who reads the topic after day 1? | `forge-ledger` src/events/Shipped.java:41; `forge-portal` | application-architect-naysayer | pat | Ledger only, in wave 2 | answered |";

describe("parseRequirements", () => {
  it("reads the title, the planned ids and each role's rows with their lines", () => {
    const p = parseRequirements(file([answered]));
    expect(p.title).toBe("Shipped-orders event");
    expect(p.planned).toEqual(["forge-portal", "forge.orders.shipped"]);
    expect(p.roles).toHaveLength(1);
    expect(p.roles[0]!.role).toBe("Application architect");
    expect(p.roles[0]!.rows).toEqual([
      {
        line: 16,
        cells: [
          "Who reads the topic after day 1?",
          "`forge-ledger` src/events/Shipped.java:41; `forge-portal`",
          "application-architect-naysayer",
          "pat",
          "Ledger only, in wave 2",
          "answered",
        ],
      },
    ]);
  });

  it("takes a heading with no six-column table as free text, and the header in any case", () => {
    const p = parseRequirements(
      [
        "# Move billing to the new platform",
        "",
        "## Background",
        "",
        "| Service | Platform |",
        "| --- | --- |",
        "| forge-billing | old |",
        "",
        "## QA",
        "",
        "| QUESTION | evidence | Asked By | answered by | ANSWER | state |",
        "|---|---|---|---|---|---|",
        "| How is it rolled back? | - | qa-naysayer | sam | By the old pipeline | Answered |",
        "",
        "### A note inside QA's section",
        "",
        "```markdown",
        "## Not a heading",
        "| Question | Evidence | Asked by | Answered by | Answer | State |",
        "| in a fence | - | x | | | open |",
        "```",
      ].join("\r\n"),
    );
    expect(p.title).toBe("Move billing to the new platform");
    expect(p.planned).toEqual([]);
    expect(p.roles.map((r) => [r.role, r.rows.map((x) => x.line)])).toEqual([["QA", [13]]]);
  });
});

/** The door check is the one check on the quick path: what it can't be sure of, it refuses. */
describe("a table the parser can't be sure of is refused, never passed over", () => {
  const OPEN = "| Who owns the topic? | - | qa-naysayer | | | open |";
  // Shadows the file's `answered`: a closed row that cites nothing.
  const answered = "| Is it logged? | - | qa-naysayer | pat | Yes | answered |";
  const reasons = (text: string) =>
    checkRequirements(parseRequirements(text), has, "r.md").reasons.map((x) => [
      x.code,
      x.line,
      x.message,
    ]);
  const codes = (text: string) => reasons(text).map((x) => [x[0], x[1]]);

  it("reads a row after a blank line, a row with no leading bar and a quoted table", () => {
    const text = [
      "## QA",
      "",
      HEADER,
      answered,
      "",
      OPEN,
      "Is it retried? | - | qa-naysayer | | | open",
      "",
      "## Security",
      "",
      ...`${HEADER}\n${OPEN}`.split("\n").map((l) => `> ${l}`),
      "",
      "## Developer",
      "",
      "Question | Evidence | Asked by | Answered by | Answer | State",
      "--- | --- | --- | --- | --- | ---",
      "Is it idempotent? | - | developer-naysayer | | | open",
    ].join("\n");
    expect(codes(text)).toEqual([
      ["requirements.open-question", 7],
      ["requirements.open-question", 8],
      ["requirements.open-question", 14],
      ["requirements.open-question", 20],
    ]);
  });

  it("follows CommonMark's fences: an inline run of backticks opens none, and only a bare fence closes one", () => {
    const inline = ["## QA", "", "```x``` is code, not a fence", "", HEADER, OPEN].join("\n");
    expect(codes(inline)).toEqual([["requirements.open-question", 7]]);
    const info = ["## QA", "", "````md", "```js", HEADER, OPEN, "```", "````", "", HEADER, OPEN];
    expect(codes(info.join("\n"))).toEqual([["requirements.open-question", 13]]);
    // A longer run closes a shorter fence; a tilde never closes a backtick fence.
    const tilde = ["## QA", "", "```", "~~~", "`````", "", HEADER, OPEN].join("\n");
    expect(codes(tilde)).toEqual([["requirements.open-question", 9]]);
  });

  it("takes a header with emphasis, and refuses one that is reordered or short", () => {
    const bold = [
      "## QA",
      "",
      "| **Question** | _Evidence_ | `Asked by` | Answered  by | *Answer* | __State__ |",
      "|:--|:-:|--:|---|---|---|",
      OPEN,
    ].join("\n");
    expect(codes(bold)).toEqual([["requirements.open-question", 5]]);
    const reordered = [
      "## QA",
      "",
      "| State | Question | Evidence | Asked by | Answered by | Answer |",
      "| --- | --- | --- | --- | --- | --- |",
      "| open | Who owns the topic? | - | qa-naysayer | | |",
    ].join("\n");
    expect(reasons(reordered)).toEqual([
      [
        "requirements.unreadable",
        3,
        'r.md:3: this table of QA\'s questions doesn\'t read: its header is "State", "Question", "Evidence", "Asked by", "Answered by", "Answer", not the six columns Question, Evidence, Asked by, Answered by, Answer, State.',
      ],
    ]);
    const short = ["## QA", "", "| Question | Answer | State |", "|---|---|---|", "| Q | | open |"];
    expect(codes(short.join("\n"))).toEqual([["requirements.unreadable", 3]]);
    // Beside a role's questions, any other table is refused; in a section with none, it is free text.
    const second = [
      "## QA",
      "",
      HEADER,
      answered,
      "",
      "Notes:",
      "",
      "| Service | Platform |",
      "|---|---|",
    ];
    expect(codes(second.join("\n"))).toEqual([["requirements.unreadable", 9]]);
    expect(
      codes("## Background\n\n| Service | Platform |\n|---|---|\n| forge-billing | old |\n"),
    ).toEqual([]);
  });

  it("refuses a questions table that is under no role's heading", () => {
    const table = `${HEADER}\n${answered}`;
    expect(reasons(`# Title\n\n${table}\n`)).toEqual([
      [
        "requirements.unreadable",
        3,
        'r.md:3: this table doesn\'t read: a table of questions is under no "## <Role>" heading.',
      ],
    ]);
    expect(codes(`### QA\n\n${table}\n`)).toEqual([["requirements.unreadable", 3]]);
    expect(codes(`## QA\n\n${table}\n\n# Appendix\n\n${table}\n`)).toEqual([
      ["requirements.unreadable", 9],
    ]);
    expect(reasons(`## Planned\n\n- forge-portal\n\n${table}\n`)[0]![2]).toContain(
      'a table of questions is under "## Planned"',
    );
    // A row with no header at all, where a role's questions are.
    expect(codes(`## QA\n\n${table}\n\nText.\n\n${OPEN}\n`)).toEqual([
      ["requirements.unreadable", 9],
    ]);
    // None of these is "no persona asked".
    expect(checkRequirements(parseRequirements(`### QA\n\n${table}\n`), has).ok).toBe(false);
  });

  it("checks every id of an evidence cell: split by ; or , and each one in backticks", () => {
    const row = (evidence: string) =>
      `## QA\n\n${HEADER}\n| Q | ${evidence} | qa-naysayer | pat | A | answered |\n`;
    const unknown = (evidence: string) =>
      checkRequirements(parseRequirements(row(evidence)), has)
        .reasons.map((x) => /names (\S+),/.exec(x.message)?.[1])
        .sort();
    expect(unknown("`forge-ledger`, `nope`")).toEqual(["nope"]);
    expect(unknown("`forge-ledger` `nope-one`; nope-two src/A.java:3, `forge-billing`")).toEqual([
      "nope-one",
      "nope-two",
    ]);
    // A file in backticks is not an id.
    expect(
      unknown("`forge-ledger` `src/events/Shipped.java:41`; `forge-billing` `pom.xml:7`"),
    ).toEqual([]);
    expect(unknown("-")).toEqual([]);
  });

  it("refuses a name several records have, and takes an entry's path as a name", () => {
    const text = `## QA\n\n${HEADER}\n| Q | \`transfers.completed\`; \`/transfers\` | qa-naysayer | pat | A | answered |\n`;
    const several = (id: string) =>
      id === "transfers.completed" ? ["topic.a", "topic.b"] : id === "/transfers";
    const r = checkRequirements(parseRequirements(text), several, "r.md");
    expect(r.inMap).toBe(1);
    expect(r.reasons).toEqual([
      {
        code: "requirements.unknown-id",
        line: 5,
        role: "QA",
        message:
          "r.md:5: the evidence names transfers.completed, which matches several records of the map (topic.a, topic.b). Name the id of the one meant.",
      },
    ]);
  });

  it("never lets another table swallow the questions table under it (the re-review)", () => {
    const text = [
      "## Arch",
      "",
      "| Repo | Owner |",
      "|---|---|",
      "| forge-ledger | pat |",
      "",
      HEADER,
      "| Who owns it? | nope | arch-naysayer | | | open |",
    ].join("\n");
    const r = checkRequirements(parseRequirements(text), has, "r.md");
    expect(r.ok).toBe(false);
    expect(r.questions).toBe(1);
    expect(r.reasons.map((x) => [x.code, x.line])).toEqual([
      // The other table sits where a role's questions are.
      ["requirements.unreadable", 3],
      ["requirements.open-question", 9],
      ["requirements.unknown-id", 9],
    ]);
    // With no blank line between them, too: a row over a delimiter row is always a header.
    const tight = text.replace("| forge-ledger | pat |\n\n", "| forge-ledger | pat |\n");
    expect(checkRequirements(parseRequirements(tight), has).reasons.map((x) => x.code)).toEqual([
      "requirements.unreadable",
      "requirements.open-question",
      "requirements.unknown-id",
    ]);
    // A plain row after a blank line still belongs to the table above it.
    const cont = `## QA\n\n${HEADER}\n${answered}\n\n\n${OPEN}\n`;
    expect(codes(cont)).toEqual([["requirements.open-question", 8]]);
  });

  it("checks an item's first word even when a file beside it is in backticks (the re-review)", () => {
    const row = (evidence: string) =>
      `## QA\n\n${HEADER}\n| Q? | ${evidence} | nay | pat | a | answered |\n`;
    const unknown = (evidence: string) =>
      checkRequirements(parseRequirements(row(evidence)), has)
        .reasons.map((x) => /names (\S+),/.exec(x.message)?.[1])
        .sort();
    expect(unknown("nope `src/a.java:41`")).toEqual(["nope"]);
    expect(unknown("forge-ledger `src/a.java:41` `nope-two`; `nope-three` build.gradle")).toEqual([
      "nope-three",
      "nope-two",
    ]);
    // A first word is the id whatever it looks like; only later words can be files.
    expect(unknown("`src/a.java:41`")).toEqual(["src/a.java:41"]);
    expect(unknown("forge-ledger `pom.xml` `App.java:3` `deploy/values.yaml`")).toEqual([]);
    // A dotted name is not a file: it is checked.
    expect(unknown("forge-ledger `orders.shipped`")).toEqual(["orders.shipped"]);
    expect(unknown("-; forge-ledger, -")).toEqual([]);
  });

  it("refuses a headerless row after a blank line, with or without its leading bar", () => {
    const bare = "Is it retried? | - | qa-naysayer | | | open";
    // After its own table: read as its row.
    expect(codes(`## QA\n\n${HEADER}\n${answered}\n\n${bare}\n`)).toEqual([
      ["requirements.open-question", 7],
    ]);
    // After prose, with no header: refused, never dropped.
    expect(codes(`## QA\n\n${HEADER}\n${answered}\n\nText.\n\n${bare}\n`)).toEqual([
      ["requirements.unreadable", 9],
    ]);
    expect(codes(`## QA\n\nText.\n\n${bare}\n`)).toEqual([["requirements.unreadable", 5]]);
    // After a table of another width: its own table, refused; not a row of the other.
    expect(
      codes(`## Notes\n\n| Repo | Owner |\n|---|---|\n| forge-ledger | pat |\n\n${OPEN}\n`),
    ).toEqual([["requirements.unreadable", 7]]);
    // Prose with a bar or two is prose.
    expect(codes(`## QA\n\nUse a | b, or c | d.\n`)).toEqual([]);
  });

  it("reads a long file in time that grows with its length", () => {
    const blanks = Array.from({ length: 60000 }, () => "").join("\n");
    const text = `## QA\n\n${HEADER}\n${answered}\n${blanks}\n${OPEN}\n`;
    const started = Date.now();
    const r = checkRequirements(parseRequirements(text), has);
    expect(r.reasons.map((x) => x.code)).toEqual(["requirements.open-question"]);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("decodes UTF-16 by its mark, and refuses a file that isn't text (the third review)", () => {
    const text = `## QA\n\n${HEADER}\n| Who owns it? | nope | qa-naysayer | | | open |\n`;
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    const be = Buffer.from(le);
    be.swap16();
    for (const bytes of [
      le,
      be,
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]),
      Buffer.from(text, "utf8"),
    ]) {
      expect(decodeRequirements(bytes)).toBe(text);
      expect(codes(decodeRequirements(bytes))).toEqual([
        ["requirements.open-question", 5],
        ["requirements.unknown-id", 5],
      ]);
    }
    // UTF-16 with no mark, read as UTF-8, is full of NULs: not text.
    const unmarked = decodeRequirements(Buffer.from(text, "utf16le"));
    expect(reasons(unmarked)).toEqual([
      ["requirements.unreadable", 1, "r.md:1: the file isn't text: save it as UTF-8."],
    ]);
  });

  it("refuses a question row the parser didn't take as one: the crude count is the net", () => {
    // The reviewer's case: a six-column header with no delimiter row, directly under another table.
    const swallowed = [
      "## Arch",
      "",
      "| Repo | Owner |",
      "|---|---|",
      "| forge-ledger | pat |",
      "| Question | Evidence | Asked by | Answered by | Answer | State |",
      "| Who owns it? | nope | arch-naysayer | | | open |",
    ].join("\n");
    expect(reasons(swallowed)).toEqual([
      [
        "requirements.unreadable",
        7,
        "r.md:7: this looks like a question row that isn't in a questions table.",
      ],
    ]);
    // A row in a list item or indented prose, its state in emphasis.
    expect(codes("## QA\n\n- Who owns it? | nope | qa | | | **Open**\n")).toEqual([
      ["requirements.unreadable", 3],
    ]);
    // Only the first is named; rows the parser read, and rows in a fence or a comment, don't count.
    const fine = `## QA\n\n${HEADER}\n${answered}\n\n\`\`\`\n${OPEN}\n\`\`\`\n\n<!--\n${OPEN}\n-->\n`;
    expect(codes(fine)).toEqual([]);
    // A table already refused is said once, not once more for each of its rows.
    expect(codes(`# Title\n\n${HEADER}\n${OPEN}\n`)).toEqual([["requirements.unreadable", 3]]);
  });

  it("refuses an HTML table and an escaped bar, and says to use a Markdown table", () => {
    expect(
      reasons("## QA\n\n<table>\n<tr><td>Who owns it?</td><td>open</td></tr>\n</table>\n"),
    ).toEqual([
      [
        "requirements.unreadable",
        3,
        "r.md:3: QA has an HTML table, which isn't read: write its questions as a Markdown table.",
      ],
    ]);
    expect(reasons(`## QA\n\n${HEADER}\n| a &#124; b? | - | qa | pat | A | answered |\n`)).toEqual([
      [
        "requirements.unreadable",
        5,
        "r.md:5: this line writes a bar as &#124;, which isn't read: write the row as a Markdown table's, with \\| for a bar inside a cell.",
      ],
    ]);
    // In a fence, both are only text.
    expect(codes("## QA\n\n```html\n<table>&#124;</table>\n```\n")).toEqual([]);
  });

  it("splits evidence on <br> too, and takes a later word in backticks as a file only by its ending or line", () => {
    const row = (evidence: string) =>
      `## QA\n\n${HEADER}\n| Q? | ${evidence} | nay | pat | a | answered |\n`;
    const unknown = (evidence: string) =>
      checkRequirements(parseRequirements(row(evidence)), has)
        .reasons.map((x) => /names (\S+),/.exec(x.message)?.[1])
        .sort();
    expect(unknown("forge-ledger<br>nope-one<br/>`nope-two`<BR />forge-billing")).toEqual([
      "nope-one",
      "nope-two",
    ]);
    expect(unknown("`forge-ledger` `team/nope`")).toEqual(["team/nope"]);
    expect(unknown("`forge-ledger` `src/a.java` `deploy/values.yaml:3` `Makefile:9`")).toEqual([]);
  });

  it("leaves out what an HTML comment holds, in Planned and everywhere, and refuses one never closed", () => {
    const text = [
      "## Planned",
      "",
      "- `forge-portal`: new <!-- - `nope`: not yet -->",
      "<!--",
      "- `nope-two`: an example",
      "-->",
      "- forge.orders.shipped",
    ].join("\n");
    expect(parseRequirements(text).planned).toEqual(["forge-portal", "forge.orders.shipped"]);
    expect(reasons(`## QA\n\n<!-- to do\n\n${HEADER}\n${OPEN}\n`)).toEqual([
      [
        "requirements.unreadable",
        3,
        "r.md:3: an HTML comment opens here and is never closed, so the rest of the file isn't read: close it (-->).",
      ],
    ]);
  });

  it("takes a line indented four spaces or by a tab as indented code, never as a fence's opener", () => {
    // CommonMark: a fence may be indented up to three spaces. Deeper, the backticks are code,
    // and taking them as an opener would hide the table after them.
    for (const indent of ["    ", "     ", "\t"]) {
      const text = ["## QA", "", `${indent}\`\`\``, "", HEADER, OPEN].join("\n");
      expect(codes(text), JSON.stringify(indent)).toEqual([["requirements.open-question", 7]]);
    }
    // Up to three spaces it is a fence: closed, it hides what it holds; never closed, it is refused.
    for (const indent of [" ", "  ", "   "]) {
      const closed = ["## QA", "", `${indent}~~~`, HEADER, OPEN, `${indent}~~~`, "", HEADER, OPEN];
      expect(codes(closed.join("\n")), JSON.stringify(indent)).toEqual([
        ["requirements.open-question", 11],
      ]);
      const open = ["## QA", "", `${indent}\`\`\``, "", HEADER, OPEN].join("\n");
      expect(codes(open), JSON.stringify(indent)).toEqual([["requirements.unreadable", 3]]);
    }
  });

  it("hides what a fence inside a blockquote holds, as any fence does, until the quote ends", () => {
    // A quoted example of a questions table, in a fence: not a question, and not counted as one.
    const quoted = [
      "## QA",
      "",
      "> Write each question like this:",
      "> ```",
      ...HEADER.split("\n").map((l) => `> ${l}`),
      `> ${OPEN}`,
      "> ```",
      "",
      HEADER,
      answered,
    ].join("\n");
    expect(reasons(quoted)).toEqual([]);
    expect(parseRequirements(quoted).roles.map((r) => r.rows.length)).toEqual([1]);
    // The same without the fence is a quoted table, which is read.
    const bare = quoted.split("\n").filter((l) => l !== "> ```");
    expect(codes(bare.join("\n"))).toEqual([["requirements.open-question", 6]]);
    // A quoted fence ends with its quote, closed or not: what follows the quote is read.
    const ended = ["## QA", "", "> ```", "> make", "", HEADER, OPEN].join("\n");
    expect(codes(ended)).toEqual([["requirements.open-question", 8]]);
    // A quoted line doesn't close a fence that isn't quoted: it is the fence's text.
    const inside = ["## QA", "", "```", "> ```", HEADER, OPEN, "```", "", HEADER, OPEN];
    expect(codes(inside.join("\n"))).toEqual([["requirements.open-question", 12]]);
    // Still open where the file ends inside the quote: refused where it opens.
    expect(codes(["## QA", "", HEADER, answered, "", "> ~~~", "> make"].join("\n"))).toEqual([
      ["requirements.unreadable", 7],
    ]);
  });

  it("ends a fence opened in a nested quote where the quote gets shallower, not only where it ends", () => {
    const rows = (marks: string) => [
      `${marks}| Question | Evidence | Asked by | Answered by | Answer | State |`,
      `${marks}|---|---|---|---|---|---|`,
      `${marks}| Q? | \`forge-ledger\` | arch | | | open |`,
    ];
    // The fence is in the inner quote; the table is in the outer one, so it is read.
    const outer = ["# T", "## Arch", "> > ```", ...rows("> ")].join("\n");
    expect(codes(outer)).toEqual([["requirements.open-question", 6]]);
    expect(parseRequirements(outer).roles.map((r) => [r.role, r.rows.length])).toEqual([
      ["Arch", 1],
    ]);
    // Three deep to two, and two to none, the same.
    expect(codes(["# T", "## Arch", "> > > ~~~", ...rows("> > ")].join("\n"))).toEqual([
      ["requirements.open-question", 6],
    ]);
    expect(codes(["# T", "## Arch", ">> ```", ...rows("")].join("\n"))).toEqual([
      ["requirements.open-question", 6],
    ]);
    // The mirror: at the fence's own depth, or deeper, the rows are the fence's text. Never
    // closed, the fence is refused where it opens; closed, the rows are hidden and nothing more.
    for (const marks of ["> > ", ">> ", "> > > "]) {
      const same = ["# T", "## Arch", "> > ```", ...rows(marks)];
      expect(codes(same.join("\n")), marks).toEqual([["requirements.unreadable", 3]]);
      expect(reasons([...same, "> > ```", "", "After the quote."].join("\n")), marks).toEqual([]);
    }
  });

  it("still refuses a fence in a list item that only the list's end closes", () => {
    const text = [
      "## QA",
      "",
      "- Build it first:",
      "  ```sh",
      "  make",
      "",
      "After the list.",
      "",
      HEADER,
      OPEN,
    ].join("\n");
    expect(reasons(text)).toEqual([
      [
        "requirements.unreadable",
        4,
        "r.md:4: a code fence opens here and is never closed, so the rest of the file isn't read: close it (```).",
      ],
    ]);
    // Closed in the item, however far its closing line is indented, the table after it is read.
    const closed = text.replace("  make\n", "  make\n      ```\n");
    expect(codes(closed)).toEqual([["requirements.open-question", 12]]);
  });

  it("refuses a code fence never closed, at the line it opens on: it would hide every table after it", () => {
    const words = (fence: string) =>
      `a code fence opens here and is never closed, so the rest of the file isn't read: close it (${fence}).`;
    expect(reasons(`# T\n## Arch\n\`\`\`\nx\n\n${HEADER}\n${OPEN}\n`)).toEqual([
      ["requirements.unreadable", 3, `r.md:3: ${words("```")}`],
    ]);
    // A tilde fence isn't closed by a line with words after the tildes, nor by a shorter run.
    expect(reasons(`# T\n## Arch\n\n~~~~ text\nx\n~~~~ end\n~~~\n\n${HEADER}\n${OPEN}\n`)).toEqual([
      ["requirements.unreadable", 4, `r.md:4: ${words("~~~~")}`],
    ]);
    // At the file's end with nothing after it, it is still refused: the next edit would be hidden.
    expect(reasons("# T\n\nWhat is wanted.\n\n```sh\nmake\n")).toEqual([
      ["requirements.unreadable", 5, `r.md:5: ${words("```")}`],
    ]);
    // Closed, the fence hides only what it holds, and the open row after it is read.
    expect(
      reasons(`# T\n## Arch\n\`\`\`\n${HEADER}\n${OPEN}\n\`\`\`\n\n${HEADER}\n${OPEN}\n`).map(
        (r) => [r[0], r[1]],
      ),
    ).toEqual([["requirements.open-question", 11]]);
  });

  it("reads a very long heading in time that grows with its length", () => {
    const long = `## ${"a ".repeat(40000)}${"#".repeat(40000)} x ${" #".repeat(20000)}`;
    const started = Date.now();
    parseRequirements(`${long}\n# ${"# ".repeat(60000)}\n`);
    expect(Date.now() - started).toBeLessThan(500);
    expect(parseRequirements("# Title ##  \n## QA #\n").title).toBe("Title");
  });

  it("reads a long Planned list once each, in order", () => {
    const ids = Array.from({ length: 5000 }, (_, i) => `forge-new-${i % 2500}`);
    const p = parseRequirements(`## Planned\n\n${ids.map((i) => `- \`${i}\`: new`).join("\n")}\n`);
    expect(p.planned).toHaveLength(2500);
    expect(p.planned.slice(0, 2)).toEqual(["forge-new-0", "forge-new-1"]);
  });
});

describe("checkRequirements", () => {
  it("passes a file whose questions are closed and whose ids the map has or the file plans", () => {
    const r = checkRequirements(parseRequirements(file([answered])), has);
    expect(r).toEqual({
      ok: true,
      reasons: [],
      roles: 1,
      questions: 1,
      answered: 1,
      accepted: 0,
      inMap: 1,
      planned: 2,
    });
  });

  it("counts a manifest repo nobody read as in the map", () => {
    const row =
      "| Does billing take the event? | forge-billing | developer-naysayer | sam | Not in this change | accepted |";
    const r = checkRequirements(parseRequirements(file([answered, row])), has);
    expect(r.ok).toBe(true);
    expect(r).toMatchObject({ questions: 2, answered: 1, accepted: 1, inMap: 2 });
    // Without the manifests, the same row names an id the map doesn't hold.
    const noManifest = checkRequirements(parseRequirements(file([answered, row])), (id) =>
      records.has(id),
    );
    expect(noManifest.reasons.map((x) => x.code)).toEqual(["requirements.unknown-id"]);
  });

  it("refuses an open question, with its line, its role and what to do", () => {
    const open = "| Who owns the topic? | - | application-architect-naysayer | | | open |";
    const r = checkRequirements(parseRequirements(file([answered, open])), has, "docs/req.md");
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual([
      {
        code: "requirements.open-question",
        line: 17,
        role: "Application architect",
        message:
          'docs/req.md:17: Application architect has an open question: "Who owns the topic?". Answer it (State answered) or accept it (State accepted, with who and why), then run this again.',
      },
    ]);
  });

  it("refuses an evidence id that is neither in the map nor planned, once for each", () => {
    const row =
      "| Who else listens? | `forge-ledger`; `forge-audit` src/Listen.java:9; forge.orders.shipped; forge-reports | qa-naysayer | pat | Nobody | answered |";
    const r = checkRequirements(parseRequirements(file([row])), has, "requirements.md");
    expect(r.reasons).toEqual([
      {
        code: "requirements.unknown-id",
        line: 16,
        role: "Application architect",
        message:
          'requirements.md:16: the evidence names forge-audit, which is not in the map and not listed under "## Planned". Name an id the map has (atticus query forge-audit), or list it under Planned.',
      },
      {
        code: "requirements.unknown-id",
        line: 16,
        role: "Application architect",
        message:
          'requirements.md:16: the evidence names forge-reports, which is not in the map and not listed under "## Planned". Name an id the map has (atticus query forge-reports), or list it under Planned.',
      },
    ]);
  });

  it("refuses a row that doesn't read: five cells, an unknown state, closed with no name", () => {
    const rows = [
      "| Who reads it? | - | qa-naysayer | pat | answered |",
      "| Is it retried? | - | qa-naysayer | pat | Yes | done |",
      "| Is it ordered? | - | qa-naysayer | | By key | answered |",
      "| Is it encrypted? | - | security-naysayer | - | We go on without | accepted |",
    ];
    const r = checkRequirements(parseRequirements(file(rows)), has, "requirements.md");
    expect(r.ok).toBe(false);
    expect(r.reasons.map((x) => [x.code, x.line, x.message])).toEqual([
      [
        "requirements.unreadable",
        16,
        "requirements.md:16: this row of Application architect's questions doesn't read: it has 5 cells, not the six of its header.",
      ],
      [
        "requirements.unreadable",
        17,
        "requirements.md:17: this row of Application architect's questions doesn't read: its State is \"done\", not open, answered or accepted.",
      ],
      [
        "requirements.unreadable",
        18,
        "requirements.md:18: this row of Application architect's questions doesn't read: it is answered and names nobody under Answered by.",
      ],
      [
        "requirements.unreadable",
        19,
        "requirements.md:19: this row of Application architect's questions doesn't read: it is accepted and names nobody under Answered by.",
      ],
    ]);
  });

  it("gives every problem of a file in line order, across roles", () => {
    const text = file(
      ["| Who owns the topic? | forge-audit | application-architect-naysayer | | | open |"],
      ["", "## Security", "", HEADER, "| Is it signed? | - | security-naysayer | | | OPEN |"].join(
        "\n",
      ),
    );
    const r = checkRequirements(parseRequirements(text), has);
    expect(r.reasons.map((x) => [x.code, x.line, x.role])).toEqual([
      ["requirements.open-question", 16, "Application architect"],
      ["requirements.unknown-id", 16, "Application architect"],
      ["requirements.open-question", 22, "Security"],
    ]);
    expect(r.questions).toBe(2);
  });

  it("passes a file no persona asked a question in", () => {
    const r = checkRequirements(
      parseRequirements("# A new portal\n\nWhat is wanted.\n\n## Planned\n\n- forge-portal\n"),
      has,
    );
    expect(r).toMatchObject({ ok: true, roles: 0, questions: 0, inMap: 0, planned: 1 });
  });
});
