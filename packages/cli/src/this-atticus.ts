import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atticusVersionOf, newerThan } from "@maycombhq/core";
import { atticusHooks } from "@maycombhq/scanner";
import { EXTENSION_NEEDS } from "./standing.js";
import { VERSION } from "./version.js";

/**
 * ADR 0202 point 7: the build is told this Atticus's version, so the Atticus a newer build.json
 * names is used only when it is newer than this one; and (the review) the other Atticus this
 * metarepo needs, the stamp's and the editor extension's, so the refusal's install command is
 * the newest of them, the one `atticus status` names. `main` calls it once a command's root is
 * known. Read only when a refusal needs it.
 */
export function tellScanner(root: string): void {
  atticusHooks.version = VERSION;
  atticusHooks.alsoNeeded = () => {
    const needs = atticusVersionOf(process.env[EXTENSION_NEEDS]);
    const file = join(root, ".atticus", "metarepo.yaml");
    let stamp: string | undefined;
    try {
      if (existsSync(file))
        stamp = atticusVersionOf(
          /^atticus:\s*["']?([^"'\s#]+)/m.exec(readFileSync(file, "utf8"))?.[1],
        );
    } catch {
      stamp = undefined;
    }
    const newer = [needs, stamp].filter((v): v is string => !!v && newerThan(v, VERSION));
    return newer.reduce<string | undefined>((a, v) => (!a || newerThan(v, a) ? v : a), undefined);
  };
}
