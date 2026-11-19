import { describe, expect, it } from "vitest";
import { checkRequirements, parseRequirements } from "../src/index.js";

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
