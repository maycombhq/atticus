import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { Dialect } from "@maycombhq/core";

/**
 * Dialects shipped with Atticus (C2 YAML in packages/extractors/dialects): jaxrs, micronaut
 * and quarkus-reactive-messaging. The folder sits two levels above this module both in src/
 * and in dist/, so the same path works when running from source and when built.
 */
export const SHIPPED_DIALECTS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../dialects",
);

/** Absolute paths of the shipped dialect files, in name order. */
export function listShippedDialects(): string[] {
  let names: string[];
  try {
    names = readdirSync(SHIPPED_DIALECTS_DIR);
  } catch {
    return [];
  }
  return names
    .filter((n) => /\.ya?ml$/.test(n))
    .sort()
    .map((n) => join(SHIPPED_DIALECTS_DIR, n));
}

/** The shipped dialects parsed against contract C2 (their own tests are not run here). */
export async function loadShippedDialects(): Promise<Dialect[]> {
  const out: Dialect[] = [];
  for (const p of listShippedDialects()) out.push(Dialect.parse(parse(await readFile(p, "utf8"))));
  return out;
}
