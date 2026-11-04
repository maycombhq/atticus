import type { ContractLink, ContractMismatch } from "@maycombhq/core";
import type { Output } from "./commands.js";
import { contractCheckOf } from "./contract-check-files.js";

/**
 * atticus join contracts [--json] (plan item F7, ADR 0164): the payload on both sides of every
 * link compared, from the field facts and the specs on file, estate-wide. Each mismatch with
 * both lines; a difference a mapping nobody traced touches is unconfirmed, said apart. Reads
 * files only and writes nothing.
 */

export const CONTRACTS_WORDS = {
  head: (links: number, compared: number) =>
    `${links} link${links === 1 ? "" : "s"} checked; ${compared} had a payload on both sides to compare.`,
  counts: (m: number, u: number) =>
    m === 0 && u === 0
      ? "No mismatches."
      : `${m} mismatch${m === 1 ? "" : "es"}, ${u} unconfirmed (a mapping on the way isn't traced).`,
  none: "No link has a payload on both sides yet: the field facts say what a call sends and an entry takes (atticus map <repo>), and a spec on file says what an API publishes (verify --write reads a repo's specs; atticus intake add takes a vendor's or a team's).",
  unlinked: (n: number) =>
    `${n} call${n === 1 ? " joins" : "s join"} nothing yet, so ${n === 1 ? "its" : "their"} payload isn't checked against the other side: answer their target questions or re-read them (atticus doctor --counts says why each is left).`,
  mismatches: "Mismatches:",
  unconfirmed: "Unconfirmed:",
  link: (l: ContractLink) =>
    `${l.call.repo} ${[l.method, l.path].filter(Boolean).join(" ")} → ${l.entry ? l.entry.repo : l.system}${l.through.length ? ` via ${l.through.join(", ")}` : ""}`,
  item: (f: ContractMismatch) => `    ${f.kind}: ${f.message}`,
  via: (via: readonly string[]) => `      through ${via.join(", ")}`,
  notes: "Left out:",
  readOnly: "Nothing was written.",
};

export async function joinContracts(
  root: string,
  o: { json?: boolean },
  io: Output,
): Promise<number> {
  const { result, notes, newBySystem } = await contractCheckOf(root);
  if (o.json) {
    io.out(
      JSON.stringify(
        {
          ...result,
          newBySystem: Object.fromEntries(
            [...newBySystem].map(([k, v]) => [k, v.map((f) => f.id)]),
          ),
          notes,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  const W = CONTRACTS_WORDS;
  if (!result.counts.compared) io.out(W.none);
  else {
    io.out(W.head(result.counts.links, result.counts.compared));
    io.out(W.counts(result.counts.mismatches, result.counts.unconfirmed));
    for (const [title, status] of [
      [W.mismatches, "mismatch"],
      [W.unconfirmed, "unconfirmed"],
    ] as const) {
      const list = result.findings.filter((f) => f.status === status);
      if (!list.length) continue;
      io.out(title);
      for (const l of result.links) {
        const mine = list.filter((f) => f.id.startsWith(`${l.key}#`));
        if (!mine.length) continue;
        io.out(`  ${W.link(l)}`);
        for (const f of mine) {
          io.out(W.item(f));
          if (f.via?.length) io.out(W.via(f.via));
        }
      }
    }
  }
  if (result.counts.unlinked) io.out(W.unlinked(result.counts.unlinked));
  if (notes.length) {
    io.out(W.notes);
    for (const n of notes) io.out(`  ${n}`);
  }
  io.out(W.readOnly);
  return 0;
}
