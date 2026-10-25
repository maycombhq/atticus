import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { orgPackDirOf } from "@maycombhq/core";
import { domainProfile } from "@maycombhq/knowledge";
import type { Output } from "./commands.js";
import { loadCatalog } from "./diagram-commands.js";

/** Where an organisation keeps its own domain profile layout (ADR 0071). */
export const DOMAIN_PROFILE_TEMPLATE = "templates/domain-profile.md";

/**
 * atticus domain profile <system> [--out <file>]: the system as a domain profile, filled from
 * the catalog with the org pack's template (or the default). Prints it, or writes --out.
 * Exit codes: 0 written, 1 nothing to show, 2 usage.
 */
export async function domainProfileCommand(
  root: string,
  system: string | undefined,
  o: { out?: string },
  io: Output,
): Promise<number> {
  if (!system) {
    io.err("Usage: atticus domain profile <system> [--out <file>]");
    return 2;
  }
  const { records, generated } = await loadCatalog(root, io);
  if (generated === 0) {
    io.err(
      "The catalog is empty: read the repos first (atticus map <repo>, then atticus verify <repo> --write).",
    );
    return 1;
  }
  const template = await readFile(join(orgPackDirOf(root), DOMAIN_PROFILE_TEMPLATE), "utf8").catch(
    () => undefined,
  );
  // The catalog's own date: the latest scan any of its facts came from.
  const scannedAt = records
    .flatMap((r) => r.evidence.map((e) => (e as { scannedAt?: string }).scannedAt ?? ""))
    .sort()
    .pop();
  let text: string;
  try {
    text = domainProfile(records, system, {
      ...(template ? { template } : {}),
      ...(scannedAt ? { scannedAt } : {}),
    });
  } catch (e) {
    io.err((e as Error).message);
    return 1;
  }
  if (!o.out) {
    for (const line of text.replace(/\n$/, "").split("\n")) io.out(line);
    return 0;
  }
  const path = resolve(root, o.out);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
  io.out(
    `Wrote the ${system} domain profile to ${relative(root, path).split("\\").join("/")}${template ? ` (from org-pack/${DOMAIN_PROFILE_TEMPLATE})` : ""}. What the code can't tell is marked Unknown and listed under Open Questions.`,
  );
  return 0;
}
