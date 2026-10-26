import { writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { workItemsCsv, type WorkItemFormat } from "@maycombhq/adapters";
import { draftedStories, PlannerError, workItemsOf } from "@maycombhq/planner";
import type { Output } from "./commands.js";

/**
 * `atticus change export <change> [ado|jira] [--out file.csv] [--area path] [--iteration path]`
 * (ADR 0124 addendum B-short): the change's stories and tasks as a work-item import file, for a
 * tracker Atticus has no API for. From the files only (the stories stage's answer and the target
 * flows), no model and no network; a person imports the file. With no --out it prints the CSV.
 */
export async function changeExportCommand(
  root: string,
  change: string | undefined,
  o: { format?: string; out?: string; areaPath?: string; iterationPath?: string },
  io: Output,
): Promise<number> {
  if (!change) {
    io.err(
      "change export needs a change id, for example: atticus change export add-transfer-limit ado --out stories.csv",
    );
    return 2;
  }
  const format = (o.format ?? "ado").toLowerCase();
  if (format !== "ado" && format !== "jira") {
    io.err(`change export writes ado or jira, not ${o.format}. Nothing was written.`);
    return 2;
  }
  let text: string;
  try {
    // The planner's work items, in the tracker's format the adapters know (ADR 0035).
    text = workItemsCsv(workItemsOf(await draftedStories(root, change)), {
      format: format as WorkItemFormat,
      ...(o.areaPath ? { areaPath: o.areaPath } : {}),
      ...(o.iterationPath ? { iterationPath: o.iterationPath } : {}),
    });
  } catch (e) {
    io.err((e as Error).message);
    return e instanceof PlannerError && e.code === "not-found" ? 3 : 1;
  }
  if (!o.out) {
    for (const l of text.replace(/\r\n$/, "").split("\r\n")) io.out(l);
    return 0;
  }
  const path = isAbsolute(o.out) ? o.out : join(process.cwd(), o.out);
  await writeFile(path, text, "utf8");
  const rows = text.split("\r\n").length - 2;
  io.out(
    `Wrote ${rows} work item${rows === 1 ? "" : "s"} of ${change} to ${o.out} (${format === "ado" ? "Azure DevOps: Boards, Import Work Items" : "Jira: CSV import"}).`,
  );
  return 0;
}
