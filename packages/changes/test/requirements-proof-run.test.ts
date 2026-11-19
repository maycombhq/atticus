import { describe, expect, it } from "vitest";
import { checkRequirements, parseRequirements, type RequirementsMap } from "../src/index.js";

/**
 * The door check, after the real-model run of the personas (2.0.0-beta.30; ADR 0201 addendum,
 * 2026-11-19): what it let through. Each is refused here with its reason and line.
 */

const HEADER =
  "| Question | Evidence | Asked by | Answered by | Answer | State |\n| --- | --- | --- | --- | --- | --- |";

const file = (planned: string[], rows: string[]) =>
  ["# Rate-updated event", "", "## Planned", "", ...planned, "", "## QA", "", HEADER, ...rows].join(
    "\n",
  );

/** The map of these tests: records with the lines they cite, a manifest repo, an open change. */
const cites: Record<string, { path: string; repo?: string; line?: number }[]> = {
  "forge-svc-06": [
    { repo: "forge-svc-06", path: "src/main/java/forge/client/Client0.java", line: 1 },
  ],
  "forge-svc-06.put-rate-2": [
    { repo: "forge-svc-06", path: "src/main/java/forge/web/RateController.java", line: 40 },
    { repo: "forge-svc-06", path: "api/openapi.yaml" },
  ],
};
const manifest = new Set(["forge-svc-06", "forge-audit"]);
const open: Record<string, string[]> = { "approvals-portal": ["forge-approvals-api"] };
const has = (id: string) => id in cites || manifest.has(id) || id in open;
const map: RequirementsMap = {
  exists: (id) => id in cites || manifest.has(id),
  plans: (change, id) =>
    !(change in open) ? "not-open" : open[change]!.includes(id) ? "plans" : "not-planned",
  cites: (id) => cites[id],
};
const check = (planned: string[], rows: string[]) =>
  checkRequirements(parseRequirements(file(planned, rows)), has, "req.md", map);
const row = (evidence: string, by: string, answer: string, state: string) =>
  `| Is the old rate kept? | ${evidence} | qa-naysayer | ${by} | ${answer} | ${state} |`;
/** The first question row's line when nothing is under Planned. */
const FIRST_ROW = 10;

describe("a closed row says what closed it", () => {
  it("refuses answered with nothing under Answer", () => {
    const r = check([], [row("`forge-svc-06`", "noor", "", "answered")]);
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual([
      {
        code: "requirements.open-question",
        line: FIRST_ROW,
        role: "QA",
        message: `req.md:${FIRST_ROW}: QA has a question answered with no answer: "Is the old rate kept?". Write the answer under Answer, then run this again.`,
      },
    ]);
    // A dash is no answer either.
    expect(check([], [row("-", "noor", "-", "answered")]).reasons[0]!.code).toBe(
      "requirements.open-question",
    );
  });

  it("refuses accepted with no reason under Answer", () => {
    const r = check([], [row("-", "noor", "", "accepted")]);
    expect(r.reasons).toEqual([
      {
        code: "requirements.open-question",
        line: FIRST_ROW,
        role: "QA",
        message: `req.md:${FIRST_ROW}: QA has a question accepted with no reason: "Is the old rate kept?". Under Answer, say why noor goes on without an answer, then run this again.`,
      },
    ]);
    // With nobody named it doesn't read, as before.
    expect(check([], [row("-", "", "we go on", "accepted")]).reasons[0]).toMatchObject({
      code: "requirements.unreadable",
    });
    expect(check([], [row("-", "noor", "Decided next quarter", "accepted")]).ok).toBe(true);
  });
});

describe("what is under Planned is planned", () => {
  it("refuses an id under Planned that the map has", () => {
    const r = check(
      [
        "- `forge-svc-06`: the rates service",
        "- `forge-audit`: the audit trail",
        "- `forge.rates.updated`: the new topic",
      ],
      [row("`forge.rates.updated`", "noor", "Yes", "answered")],
    );
    expect(r.reasons).toEqual([
      {
        code: "requirements.planned-exists",
        line: 5,
        role: "",
        message:
          'req.md:5: forge-svc-06 is in the map: take it off Planned. "## Planned" lists only what the map doesn\'t have yet.',
      },
      {
        code: "requirements.planned-exists",
        line: 6,
        role: "",
        message:
          'req.md:6: forge-audit is in the map: take it off Planned. "## Planned" lists only what the map doesn\'t have yet.',
      },
    ]);
  });

  it("takes a thing another open change plans, said so", () => {
    const p = parseRequirements(
      file(["- `forge-approvals-api`: not created here, planned by `approvals-portal`"], []),
    );
    expect(p.plannedItems).toEqual([
      { id: "forge-approvals-api", line: 5, by: "approvals-portal" },
    ]);
    const ok = check(
      [
        "- `forge-approvals-api`: the backend; not created here, planned by the open change `approvals-portal`",
      ],
      [row("`forge-approvals-api`", "noor", "Yes", "answered")],
    );
    expect(ok).toMatchObject({ ok: true, planned: 1 });
  });

  it("refuses it when that change is not open, doesn't plan it, or isn't named", () => {
    const one = (item: string) => check([item], []).reasons;
    expect(one("- `forge-approvals-api`: not created here, planned by `old-portal`")).toEqual([
      {
        code: "requirements.unknown-id",
        line: 5,
        role: "",
        message:
          'req.md:5: "## Planned" says forge-approvals-api is planned by old-portal, which is not an open change (atticus change list). Name the open change that plans it, or plan it here.',
      },
    ]);
    expect(one("- `forge-approvals-web`: not created here, planned by `approvals-portal`")).toEqual(
      [
        {
          code: "requirements.unknown-id",
          line: 5,
          role: "",
          message:
            'req.md:5: "## Planned" says forge-approvals-web is planned by approvals-portal, which doesn\'t plan it: its requirements file doesn\'t list it under "## Planned" and its tasks.md has no "## forge-approvals-web". Name the open change that plans it, or plan it here.',
        },
      ],
    );
    expect(
      one("- `forge-approvals-web`: not created here, planned by the same open change"),
    ).toEqual([
      {
        code: "requirements.unknown-id",
        line: 5,
        role: "",
        message:
          'req.md:5: "## Planned" says forge-approvals-web is planned by another change and names none. Write it as: `forge-approvals-web`: not created here, planned by `<change id>`.',
      },
    ]);
  });
});

describe("a file and line beside a record is one the record cites", () => {
  it("takes the record's own file, at or near a line it cites, with or without the repo", () => {
    for (const evidence of [
      "`forge-svc-06.put-rate-2` src/main/java/forge/web/RateController.java:40",
      "`forge-svc-06.put-rate-2` src/main/java/forge/web/RateController.java:43",
      "`forge-svc-06.put-rate-2` `forge-svc-06/src/main/java/forge/web/RateController.java:38`",
      // A file the record cites with no line: any line of it.
      "`forge-svc-06.put-rate-2` api/openapi.yaml:212",
      // No file, and an id that is no record (a manifest repo, a planned id): nothing to check.
      "`forge-svc-06.put-rate-2`; `forge-audit` src/Audit.java:9",
    ])
      expect(check([], [row(evidence, "noor", "Yes", "answered")]).reasons, evidence).toEqual([]);
  });

  it("refuses a file the record doesn't cite, and a line far from the ones it cites", () => {
    const wrongFile = check(
      [],
      [
        row(
          "`forge-svc-06.put-rate-2` src/main/java/forge/web/Other.java:40",
          "noor",
          "Yes",
          "answered",
        ),
      ],
    );
    expect(wrongFile.reasons).toEqual([
      {
        code: "requirements.wrong-line",
        line: FIRST_ROW,
        role: "QA",
        message: `req.md:${FIRST_ROW}: the evidence cites src/main/java/forge/web/Other.java:40 for forge-svc-06.put-rate-2, which the map read from src/main/java/forge/web/RateController.java:40, api/openapi.yaml. Cite a file and line the map cites for it (atticus context show forge-svc-06.put-rate-2), or name the id alone.`,
      },
    ]);
    const wrongLine = check(
      [],
      [
        row(
          "`forge-svc-06.put-rate-2` src/main/java/forge/web/RateController.java:90",
          "noor",
          "Yes",
          "answered",
        ),
      ],
    );
    expect(wrongLine.reasons.map((x) => [x.code, x.message])).toEqual([
      [
        "requirements.wrong-line",
        `req.md:${FIRST_ROW}: the evidence cites src/main/java/forge/web/RateController.java:90 for forge-svc-06.put-rate-2, which the map read from line 40 of that file. Cite a file and line the map cites for it (atticus context show forge-svc-06.put-rate-2), or name the id alone.`,
      ],
    ]);
  });

  it("checks nothing of this when the caller gives no map to read the lines from", () => {
    const p = parseRequirements(
      file(
        ["- `forge-svc-06`: listed"],
        [row("`forge-svc-06.put-rate-2` src/Other.java:1", "noor", "Yes", "answered")],
      ),
    );
    expect(checkRequirements(p, has, "req.md").ok).toBe(true);
  });
});
