import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { Api } from "@maycombhq/core";

/** ADR 0204 A.6: the entries of a find report (`facts/<A>.find.yaml`); none when it doesn't read. */
export async function readFindReport(path: string): Promise<Api.FindEntryViewT[]> {
  const text = await readFile(path, "utf8").catch(() => "");
  if (!text.trim()) return [];
  try {
    const r = Api.FindEntryView.array().safeParse((parse(text) as { entries?: unknown })?.entries);
    return r.success ? r.data : [];
  } catch {
    return [];
  }
}
