import { join } from "node:path";
import {
  arrowEndKey,
  catalogDirOf,
  declaredArrows,
  orgPackRelOf,
  type Api,
  type ArrowEnd,
  type DeclaredArrow,
  type OrgPack,
} from "@maycombhq/core";
import { declaredArrowRecords, estateRepos, readCatalog } from "@maycombhq/scanner";
import { badRequest, notFound } from "@maycombhq/server";

/**
 * ADR 0204: the declared arrows as the local API speaks of them (a box, `repo:` or `system:`),
 * where one is written (the caller's platform's profile, else the callee's), and whether the code
 * shows the call already (a declared arrow over a real call is refused: 409). Files only.
 */

export const endOf = (b: Api.LinkBoxT): ArrowEnd =>
  b.repo ? { repo: b.repo } : { system: b.system! };
export const boxOfEnd = (e: ArrowEnd): Api.LinkBoxT =>
  "repo" in e ? { repo: e.repo } : { system: e.system };
export const boxWords = (b: Api.LinkBoxT) => b.repo ?? b.system!;
const sameBox = (a: Api.LinkBoxT, b: Api.LinkBoxT) =>
  arrowEndKey(endOf(a)) === arrowEndKey(endOf(b));

/** `repo:<id>` or `system:<id>` (a query's box), or 400. */
export function parseBox(v: string | null, what: string): Api.LinkBoxT {
  const m = /^(repo|system):([A-Za-z0-9._-]{1,200})$/.exec(v ?? "");
  if (!m) throw badRequest(`Say ${what} as repo:<id> or system:<id>.`);
  return m[1] === "repo" ? { repo: m[2]! } : { system: m[2]! };
}

/** The profile's arrow from `from` to `to`, as the API shows it, if one is declared. */
export function arrowOf(
  root: string,
  op: OrgPack,
  from: Api.LinkBoxT,
  to: Api.LinkBoxT,
): Api.DeclaredArrowViewT | undefined {
  const d = declaredArrows(op).find(
    (x) => sameBox(boxOfEnd(x.from), from) && sameBox(boxOfEnd(x.to), to),
  );
  return d ? arrowView(root, d) : undefined;
}

export const arrowView = (root: string, d: DeclaredArrow): Api.DeclaredArrowViewT => ({
  from: boxOfEnd(d.from),
  to: boxOfEnd(d.to),
  why: d.why,
  by: d.by,
  at: d.at,
  ...(d.planned ? { planned: true } : {}),
  file: `${orgPackRelOf(root)}/${d.file}`,
});

/**
 * The platform whose profile an arrow is written to (1.4): the caller's (the manifest that lists
 * the repo, or the profile that has the system), else the callee's. 404 when neither end is a
 * repo of the manifests or a system of the profiles.
 */
export function arrowPlatform(op: OrgPack, from: Api.LinkBoxT, to: Api.LinkBoxT): string {
  const of = (b: Api.LinkBoxT) =>
    b.repo
      ? estateRepos(op).find((r) => r.id === b.repo)?.platform
      : (op.profiles.find((p) => (p.profile?.systems ?? []).some((s) => s.id === b.system))
          ?.platform ?? estateRepos(op).find((r) => r.system === b.system)?.platform);
  const p = of(from) ?? of(to);
  if (!p)
    throw notFound(
      `Neither ${boxWords(from)} nor ${boxWords(to)} is a repo of the manifests or a system of the profiles.`,
    );
  return p;
}

/** Whether an end is a repo of the manifests or a system of the profiles (or a repo's system). */
export function knownEnd(op: OrgPack, b: Api.LinkBoxT): boolean {
  return b.repo
    ? estateRepos(op).some((r) => r.id === b.repo)
    : op.profiles.some((p) => (p.profile?.systems ?? []).some((s) => s.id === b.system)) ||
        estateRepos(op).some((r) => r.system === b.system);
}

/**
 * How many real calls the built catalog has from `from` to `to`, by the build's own rule for an
 * arrow the code shows (1.7): the catalog as it is on disk; 0 before any build.
 */
export async function realCalls(
  root: string,
  op: OrgPack,
  from: Api.LinkBoxT,
  to: Api.LinkBoxT,
): Promise<number> {
  const records = await readCatalog(join(catalogDirOf(root), "generated"), { fresh: true }).then(
    (c) => c.records,
    () => [],
  );
  const asked: DeclaredArrow = {
    from: endOf(from),
    to: endOf(to),
    why: "asked",
    by: "asked",
    at: new Date(0).toISOString(),
    platform: "",
    file: "",
  };
  return declaredArrowRecords(op, records, [asked]).superseded[0]?.calls ?? 0;
}

/** The words a declared arrow over a real call is refused with (1.7: the `connected` words). */
export const connectedWords = (from: Api.LinkBoxT, to: Api.LinkBoxT, n: number) =>
  `${boxWords(from)} already calls ${boxWords(to)}: ${n} call${n === 1 ? "" : "s"} read from code. There is nothing to add.`;
