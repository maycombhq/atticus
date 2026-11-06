import { Fact, type FactCorrection } from "@maycombhq/core";

/**
 * A person's corrections of a repo's facts (ADR 0124 addendum D-app, F3), applied before the
 * facts are checked. A fact marked wrong is left out; an edited fact takes the person's claim
 * and becomes a person's fact (`by: person`, `verified: person`), which the line check still
 * checks: a correction says what the code does, so it must rest on a line of the code too.
 * Pure: the caller reads `<repo>.corrections.jsonl`.
 */

export interface AppliedCorrection {
  fact: string;
  action: FactCorrection["action"];
  by: string;
}

export interface StaleCorrection {
  correction: FactCorrection;
  /** none: no fact is the one it names; invalid: the corrected fact isn't one. */
  why: "none" | "invalid";
  message: string;
}

export interface CorrectionsResult {
  facts: Fact[];
  applied: AppliedCorrection[];
  stale: StaleCorrection[];
}

/** The correction a fact meets, by its id and cite first, else by what it cites. Newest wins. */
export function correctionFor(f: Fact, all: readonly FactCorrection[]): FactCorrection | undefined {
  // G1 (ADR 0174): a pairing leaves the fact's claim as read; one to a repo the join reads
  // (pairsFromCorrections), one to an outside system is applied on top (outsidePairingFor).
  const corrections = all.filter((c) => c.action !== "link");
  const at = (c: FactCorrection) =>
    c.target.kind === f.kind && c.target.file === f.cite.file && c.target.line === f.cite.line;
  const byId = corrections.filter((c) => c.fact === f.id && at(c));
  const byCite = corrections.filter((c) => at(c) && c.target.value === f.cite.value);
  const edited = corrections.filter((c) => c.fact === f.id && c.action === "edit");
  // An edit that moved the line or the value is met again by its id on the line it moved to.
  const moved = edited.filter((c) => (c.line ?? c.target.line) === f.cite.line);
  return [...byId, ...byCite, ...moved].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))[0];
}

/**
 * G1: the newest pairing of a call with an outside system, met as any correction meets its fact.
 * It is applied on top of the fact's own correction (never instead of it), so an edit stays and a
 * call marked wrong stays left out.
 */
export function outsidePairingFor(
  f: Fact,
  all: readonly FactCorrection[],
): FactCorrection | undefined {
  if (f.kind !== "call") return undefined;
  return all
    .filter(
      (c) =>
        c.action === "link" &&
        !!c.link?.system &&
        c.target.kind === "call" &&
        c.target.file === f.cite.file &&
        c.target.line === f.cite.line &&
        (c.fact === f.id || c.target.value === f.cite.value),
    )
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))[0];
}

/** The fact as the person corrected it, or why it isn't one. */
export function correctedFact(f: Fact, c: FactCorrection): Fact | string {
  const raw = JSON.parse(JSON.stringify(f)) as Record<string, unknown> & {
    cite: Record<string, unknown>;
  };
  for (const [k, v] of Object.entries(c.set ?? {})) {
    if (k === "value") raw.cite.value = v;
    else if (v === "") delete raw[k];
    else raw[k] = v;
  }
  if (c.line !== undefined && c.line !== f.cite.line) {
    raw.cite.line = c.line;
    // The quote was of the old line; the claim is checked on the new one.
    delete raw.cite.quote;
  }
  raw.by = "person";
  raw.verified = "person";
  const r = Fact.safeParse(raw);
  if (!r.success)
    return r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
  return r.data;
}

/** Apply every correction that meets a fact; one that meets none is stale. */
export function applyCorrections(
  facts: readonly Fact[],
  corrections: readonly FactCorrection[],
): CorrectionsResult {
  const out: Fact[] = [];
  const applied: AppliedCorrection[] = [];
  const used = new Set<FactCorrection>();
  const stale: StaleCorrection[] = [];
  // A pairing with an outside system, on top of whatever else the person said of the call.
  const withPairing = (f: Fact, as: Fact = f): Fact => {
    const p = outsidePairingFor(as, corrections);
    if (!p) return f;
    used.add(p);
    const fixed = correctedFact(f, { ...p, action: "edit", set: { to: p.link!.system! } });
    return typeof fixed === "string" ? f : fixed;
  };
  for (const f0 of facts) {
    const c = correctionFor(f0, corrections);
    if (c?.action === "wrong") {
      used.add(c);
      applied.push({ fact: f0.id, action: "wrong", by: c.by });
      continue;
    }
    const f = c ? f0 : withPairing(f0);
    if (!c) {
      out.push(f);
      continue;
    }
    used.add(c);
    const fixed = correctedFact(f, c);
    if (typeof fixed === "string") {
      stale.push({
        correction: c,
        why: "invalid",
        message: `${c.by}'s correction of ${f.kind} ${f.id} doesn't make a fact (${fixed}); the fact is kept as it was`,
      });
      out.push(withPairing(f));
      continue;
    }
    applied.push({ fact: f.id, action: "edit", by: c.by });
    out.push(withPairing(fixed, f0));
  }
  // Only the newest correction of a fact counts; an older one it replaced isn't stale.
  for (const c of corrections) {
    if (used.has(c)) continue;
    if (c.action === "link") {
      // G1: a pairing is stale only when no call is the one it names.
      const met = out.some(
        (f) =>
          f.kind === "call" &&
          f.cite.file === c.target.file &&
          f.cite.line === c.target.line &&
          (f.id === c.fact || f.cite.value === c.target.value),
      );
      if (!met)
        stale.push({
          correction: c,
          why: "none",
          message: `${c.by}'s pairing of call ${c.fact} (${c.target.file}:${c.target.line}) with ${[c.link?.method, c.link?.path].filter(Boolean).join(" ")} on ${c.link?.repo ?? c.link?.system} meets no call in this read; it is kept in the file and applied when the call is read again`,
        });
      continue;
    }
    const replaced = [...used].some(
      (u) =>
        (u.fact === c.fact || u.target.value === c.target.value) &&
        u.target.kind === c.target.kind &&
        u.target.file === c.target.file &&
        u.target.line === c.target.line,
    );
    // A fact marked wrong that the read doesn't have is as the person wanted: nothing to say.
    if (replaced || c.action === "wrong") continue;
    stale.push({
      correction: c,
      why: "none",
      message: `${c.by}'s correction of ${c.target.kind} ${c.fact} (${c.target.file}:${c.target.line}) meets no fact in this read; it is kept in the file and applied when the fact is read again`,
    });
  }
  return { facts: out, applied, stale };
}
