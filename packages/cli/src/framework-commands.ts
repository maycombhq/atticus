import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parse } from "yaml";
import { FrameworkModel, orgPackDirOf, RecordId, toCanonicalYaml } from "@maycombhq/core";
import { learnFramework } from "@maycombhq/extractors";
import { fsRepo } from "@maycombhq/sdk";
import type { Output } from "./commands.js";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Merge what was learned into what is there: a learned entry replaces one of the same name
 * (code beats a document or a person); everything else already there is kept.
 */
function merge(
  existing: FrameworkModel | undefined,
  learned: FrameworkModel,
): { model: FrameworkModel; keptServices: number; keptOther: number } {
  if (!existing) return { model: learned, keptServices: 0, keptOther: 0 };
  const byName = <T extends { name: string }>(a: T[], b: T[]) => [
    ...b,
    ...a.filter((x) => !b.some((y) => y.name === x.name)),
  ];
  const clientKey = (c: FrameworkModel["clients"][number]) => `${c.type}.${c.method}`;
  const clients = [
    ...learned.clients,
    ...existing.clients.filter((c) => !learned.clients.some((l) => clientKey(l) === clientKey(c))),
  ];
  const keptServices = Object.keys(existing.services).filter((k) => !(k in learned.services));
  const keptOther =
    existing.annotations.filter((a) => !learned.annotations.some((l) => l.name === a.name)).length +
    (clients.length - learned.clients.length) +
    Object.keys(existing.constants).filter((k) => !(k in learned.constants)).length;
  return {
    model: FrameworkModel.parse({
      ...learned,
      packages: [...new Set([...learned.packages, ...existing.packages])],
      artifacts: [...new Set([...learned.artifacts, ...existing.artifacts])],
      annotations: byName(existing.annotations, learned.annotations).sort((a, b) =>
        a.name < b.name ? -1 : 1,
      ),
      clients,
      services: { ...existing.services, ...learned.services },
      constants: { ...existing.constants, ...learned.constants },
    }),
    keptServices: keptServices.length,
    keptOther,
  };
}

/**
 * atticus frameworks learn <name> --from <repo> [--package p] [--dry-run]: read a house
 * starter's source and write what it means to org-pack/frameworks/<name>.yaml (ADR 0054).
 */
export async function frameworksLearn(
  root: string,
  name: string,
  from: string,
  o: { packages?: string[]; dryRun?: boolean },
  io: Output,
): Promise<number> {
  if (!RecordId.safeParse(name).success) {
    io.err(
      `"${name}" isn't a framework name: use lower case, digits and dashes, e.g. tide-platform`,
    );
    return 2;
  }
  const dir = resolve(from);
  if (!(await stat(dir).catch(() => undefined))?.isDirectory()) {
    io.err(
      `${from} isn't a folder: give the starter's source, e.g. --from workspace/tide-platform`,
    );
    return 2;
  }
  const learned = await learnFramework(fsRepo(basename(dir), dir, "0".repeat(40)), {
    name,
    ...(o.packages?.length ? { packages: o.packages } : {}),
  });
  const rel = `org-pack/frameworks/${name}.yaml`;
  const file = join(orgPackDirOf(root), "frameworks", `${name}.yaml`);
  let existing: FrameworkModel | undefined;
  try {
    existing = FrameworkModel.parse(parse(await readFile(file, "utf8")));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      io.err(
        `${rel} isn't a valid framework model (${(e as Error).message.split("\n")[0]}); fix or remove it first.`,
      );
      return 1;
    }
  }
  const { model, keptServices, keptOther } = merge(existing, learned.model);
  const m = learned.model;
  const what = `${plural(m.annotations.length, "annotation")}, ${plural(m.clients.length, "wrapper method")}, ${plural(Object.keys(m.constants).length, "constant")} (all from code)`;
  const keptParts = [
    ...(keptServices ? [plural(keptServices, "service")] : []),
    ...(keptOther ? [plural(keptOther, "other entry", "other entries")] : []),
  ];
  const keptText = keptParts.length ? `; kept ${keptParts.join(" and ")} a person added` : "";
  if (o.dryRun) {
    io.out(`Dry run: would write ${rel} from ${basename(dir)}: ${what}${keptText}.`);
  } else {
    await mkdir(join(orgPackDirOf(root), "frameworks"), { recursive: true });
    await writeFile(file, toCanonicalYaml(model, ["schemaVersion", "name"]), "utf8");
    io.out(`Wrote ${rel} from ${basename(dir)}: ${what}${keptText}.`);
  }
  for (const n of learned.notes) io.out(`note: ${n}`);
  if (m.annotations.length + m.clients.length === 0)
    io.out(
      "note: nothing in it reads as an annotation or a client the scanner knows; check --from is the starter's source.",
    );
  return 0;
}
