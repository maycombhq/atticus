import { parseRecord, type CatalogRecord } from "@maycombhq/core";

/**
 * Compare a scanned catalog with a hand-written expected one. Expected rows are parsed with
 * contract C1 first, so defaults the hand-written file leaves out are compared too; every
 * field on either side must agree. Evidence is compared as a set of (repo, path, line,
 * side), ignoring commit, scan time, extractor and dialect tags.
 */
export interface Comparison {
  missing: string[];
  extra: string[];
  fieldDiffs: string[];
  evidenceDiffs: string[];
}

type Row = Record<string, unknown> & { kind: string; id: string };

const evKey = (e: Record<string, unknown>) =>
  `${e.repo ?? ""}:${e.path ?? ""}:${e.line ?? ""}:${e.side ?? ""}`;

export function compareCatalog(
  actual: CatalogRecord[],
  expectedRows: Row[],
  kinds: string[],
  opts: { ignoreFields?: Record<string, string[]>; skip?: string[] } = {},
): Comparison {
  const out: Comparison = { missing: [], extra: [], fieldDiffs: [], evidenceDiffs: [] };
  const expected = expectedRows.map((r) => {
    const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
    if (!p.ok) throw new Error(`expected row ${r.id} is invalid: ${JSON.stringify(p.issues)}`);
    return p.record as unknown as Row;
  });
  const act = new Map(
    actual
      .filter((r) => kinds.includes(r.kind))
      .map((r) => [`${r.kind}/${r.id}`, r as unknown as Row]),
  );
  const exp = new Map(
    expected
      .filter((r) => kinds.includes(r.kind) && !(opts.skip ?? []).includes(r.id))
      .map((r) => [`${r.kind}/${r.id}`, r]),
  );
  for (const [k, e] of exp) {
    const a = act.get(k);
    if (!a) {
      out.missing.push(k);
      continue;
    }
    const ignore = new Set(["evidence", ...(opts.ignoreFields?.[e.kind] ?? [])]);
    for (const f of [...new Set([...Object.keys(e), ...Object.keys(a)])].sort()) {
      if (ignore.has(f)) continue;
      if (JSON.stringify(a[f]) !== JSON.stringify(e[f]))
        out.fieldDiffs.push(
          `${k}.${f}: expected ${JSON.stringify(e[f])}, got ${JSON.stringify(a[f])}`,
        );
    }
    const ea = new Set(((a.evidence as Record<string, unknown>[]) ?? []).map(evKey));
    const ee = new Set(((e.evidence as Record<string, unknown>[]) ?? []).map(evKey));
    const lacking = [...ee].filter((x) => !ea.has(x));
    const surplus = [...ea].filter((x) => !ee.has(x));
    if (lacking.length + surplus.length > 0)
      out.evidenceDiffs.push(`${k}: missing [${lacking.join(", ")}] extra [${surplus.join(", ")}]`);
  }
  for (const k of act.keys())
    if (!exp.has(k) && !(opts.skip ?? []).includes(k.split("/")[1]!)) out.extra.push(k);
  return out;
}
