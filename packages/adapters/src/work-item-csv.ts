/**
 * Work items as a tracker's CSV import file (ADR 0124 addendum B-short): the work-tracker
 * knowledge for a team whose tracker Atticus has no API for. A person imports the file; nothing
 * is sent. The items are the planner's (`workItemsOf`), passed in this neutral shape.
 *
 * - Azure DevOps (Boards, Import Work Items): ID blank for new items, the hierarchy as Title 1 (a
 *   User Story) and Title 2 (its Tasks, on the rows under it), Description and Acceptance
 *   Criteria as HTML (escaped, criteria as a list), Tags, Area Path and Iteration Path (blank
 *   unless given: the project's defaults).
 * - Jira (CSV import): Issue Id, Issue Type (Story, Sub-task), Summary, Description, Acceptance
 *   Criteria as text, Parent by Issue Id, Labels.
 */

export interface CsvTask {
  label: string;
  title: string;
  steps: string[];
  places: string[];
  fields: string[];
  criteria: string[];
  prompt: string;
  run: string;
}

export interface CsvStory {
  title: string;
  statement: string;
  context?: string;
  change: string;
  repo: string;
  flow: string;
  file: string;
  criteria: string[];
  tasks: CsvTask[];
}

export type WorkItemFormat = "ado" | "jira";

export interface WorkItemCsvOptions {
  format?: WorkItemFormat;
  areaPath?: string;
  iterationPath?: string;
  /** Extra tags on every item, beside the change id and the repo. */
  tags?: string[];
}

/** Azure DevOps' import columns, in order. */
export const ADO_COLUMNS = [
  "ID",
  "Work Item Type",
  "Title 1",
  "Title 2",
  "Description",
  "Acceptance Criteria",
  "Tags",
  "Area Path",
  "Iteration Path",
] as const;

/** Jira's import columns, in order. */
export const JIRA_COLUMNS = [
  "Issue Id",
  "Issue Type",
  "Summary",
  "Description",
  "Acceptance Criteria",
  "Parent",
  "Labels",
] as const;

/** HTML-escaped, as Azure DevOps' HTML fields take text. */
export const html = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const ul = (xs: string[]) =>
  xs.length ? `<ul>${xs.map((x) => `<li>${html(x)}</li>`).join("")}</ul>` : "";
const p = (s: string) => `<p>${html(s)}</p>`;

/** One CSV cell (RFC 4180): quoted when it holds a comma, quote or line break. */
export const csvCell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const csvRow = (cells: string[]) => cells.map(csvCell).join(",");

const storyRef = (s: CsvStory) =>
  `Change ${s.change}, repo ${s.repo}, flow ${s.flow}. The story in full: ${s.file}.`;
const promptRef = (t: CsvTask) =>
  `Prompt for Copilot or Claude Code: ${t.prompt}; run it with ${t.run}.`;

/** The rows of the import file, as cells by column name. */
export function workItemRows(
  stories: CsvStory[],
  o: WorkItemCsvOptions = {},
): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  let issue = 0;
  for (const s of stories) {
    const tags = [s.change, s.repo, ...(o.tags ?? [])];
    const parent = ++issue;
    if ((o.format ?? "ado") === "ado") {
      const common = {
        ID: "",
        Tags: tags.join("; "),
        "Area Path": o.areaPath ?? "",
        "Iteration Path": o.iterationPath ?? "",
      };
      rows.push({
        ...common,
        "Work Item Type": "User Story",
        "Title 1": s.title,
        "Title 2": "",
        Description: [p(s.statement), ...(s.context ? [p(s.context)] : []), p(storyRef(s))].join(
          "",
        ),
        "Acceptance Criteria": ul(s.criteria),
      });
      for (const t of s.tasks)
        rows.push({
          ...common,
          "Work Item Type": "Task",
          "Title 1": "",
          "Title 2": `${t.label} ${t.title}`,
          Description: [
            ul(t.steps),
            ...(t.places.length ? [p(`Where: ${t.places.join(", ")}.`)] : []),
            ...(t.fields.length ? [p(`Fields: ${t.fields.join(", ")}.`)] : []),
            p(promptRef(t)),
          ].join(""),
          "Acceptance Criteria": ul(t.criteria),
        });
    } else {
      const labels = tags.map((x) => x.replace(/\s+/g, "-")).join(" ");
      rows.push({
        "Issue Id": String(parent),
        "Issue Type": "Story",
        Summary: s.title,
        Description: [s.statement, s.context, storyRef(s)].filter(Boolean).join("\n\n"),
        "Acceptance Criteria": s.criteria.map((c) => `* ${c}`).join("\n"),
        Parent: "",
        Labels: labels,
      });
      for (const t of s.tasks)
        rows.push({
          "Issue Id": String(++issue),
          "Issue Type": "Sub-task",
          Summary: `${t.label} ${t.title}`,
          Description: [
            t.steps.map((x) => `* ${x}`).join("\n"),
            t.places.length ? `Where: ${t.places.join(", ")}.` : "",
            t.fields.length ? `Fields: ${t.fields.join(", ")}.` : "",
            promptRef(t),
          ]
            .filter(Boolean)
            .join("\n\n"),
          "Acceptance Criteria": t.criteria.map((c) => `* ${c}`).join("\n"),
          Parent: String(parent),
          Labels: labels,
        });
    }
  }
  return rows;
}

/** The import file's text: a header row and a row per work item, CRLF line ends as Excel writes. */
export function workItemsCsv(stories: CsvStory[], o: WorkItemCsvOptions = {}): string {
  const columns: readonly string[] = (o.format ?? "ado") === "ado" ? ADO_COLUMNS : JIRA_COLUMNS;
  return [
    csvRow([...columns]),
    ...workItemRows(stories, o).map((r) => csvRow(columns.map((c) => r[c] ?? ""))),
  ]
    .map((l) => `${l}\r\n`)
    .join("");
}
