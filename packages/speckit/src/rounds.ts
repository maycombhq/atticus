import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parse } from "yaml";
import { changeFolder, writeFileAtomic } from "@maycombhq/changes";
import { ChecklistPack, Finding, toCanonicalYaml, type ChecklistRule } from "@maycombhq/core";
import {
  fingerprint,
  readRound,
  roundsOf,
  writeFinding,
  type StoredFinding,
} from "@maycombhq/naysayer";

/**
 * Rounds for checks that run again and again (the drift check on every scan, hand-up per
 * task): the newest round always holds the whole picture, so the lifecycle's and the critic's
 * reading of a gate ("the newest round has no open blocking finding") works unchanged.
 *
 * A new round is written only when something changed. A finding seen before keeps its state
 * and resolution (dismissed stays dismissed); findings `carry` says belong to work not checked
 * this time (another task's hand-up) are copied into the new round as they were.
 */
export interface RoundWrite {
  gate: string;
  /** The newest round after this call (undefined when there has never been a finding). */
  round?: number;
  /** True when nothing changed, so no round was written. */
  unchanged: boolean;
  findings: StoredFinding[];
}

const sig = (fs: Finding[]) =>
  fs
    .map((f) => `${fingerprint(f)}|${f.state}|${f.severity}`)
    .sort()
    .join("\n");

export async function writeFullRound(
  root: string,
  change: string,
  gate: string,
  fresh: Finding[],
  o: { now: string; carry?: (f: Finding) => boolean; meta?: Record<string, unknown> },
): Promise<RoundWrite> {
  const rounds = await roundsOf(root, change, gate);
  const last = rounds.at(-1);
  const prev = last
    ? (await readRound(root, change, gate, last)).findings.map((s) => s.finding)
    : [];
  const carried = prev.filter((f) => o.carry?.(f));
  const byPrint = new Map(prev.map((f) => [fingerprint(f), f]));
  const taken = new Set(carried.map((f) => f.id));
  const next: Finding[] = [...carried];
  for (const f of fresh) {
    const before = byPrint.get(fingerprint(f));
    let id = f.id;
    for (let i = 2; taken.has(id); i++) id = `${f.id}-${i}`;
    taken.add(id);
    const merged = Finding.safeParse({
      ...f,
      id,
      createdAt: before?.createdAt ?? f.createdAt,
      ...(before?.resolution ? { state: before.state, resolution: before.resolution } : {}),
    });
    next.push(merged.success ? merged.data : { ...f, id });
  }
  if (sig(next) === sig(prev) && (last !== undefined || next.length === 0)) {
    const findings = last ? (await readRound(root, change, gate, last)).findings : [];
    return { gate, ...(last ? { round: last } : {}), unchanged: true, findings };
  }
  const round = (last ?? 0) + 1;
  const findings: StoredFinding[] = [];
  for (const f of next.sort((a, b) => a.id.localeCompare(b.id))) {
    const g = Finding.parse({ ...f, round, gate, change });
    await writeFinding(root, g);
    findings.push({ finding: g, path: `review/${gate}/${round}/${g.id}.yaml` });
  }
  await writeFileAtomic(
    join(changeFolder(root, change), "review", gate, String(round), "meta", "round.yaml"),
    toCanonicalYaml(
      {
        schemaVersion: 1,
        change,
        gate,
        round,
        createdAt: o.now,
        findings: findings.map((f) => ({
          id: f.finding.id,
          rule: f.finding.rule,
          severity: f.finding.severity,
        })),
        ...o.meta,
      },
      ["schemaVersion", "change", "gate", "round", "createdAt"],
    ),
  );
  return { gate, round, unchanged: false, findings };
}

const DRIFT_RULES_FILE = fileURLToPath(new URL("../rules/drift.yaml", import.meta.url));

/** The drift check's built-in rules, validated against C3. */
export async function loadDriftRules(): Promise<Map<string, ChecklistRule>> {
  const pack = ChecklistPack.parse(parse(await readFile(DRIFT_RULES_FILE, "utf8")));
  return new Map(pack.rules.map((r) => [r.id, r]));
}
