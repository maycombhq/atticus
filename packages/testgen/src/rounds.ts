import { join } from "node:path";
import { changeFolder, writeFileAtomic } from "@maycombhq/changes";
import { Finding, toCanonicalYaml } from "@maycombhq/core";
import {
  fingerprint,
  readRound,
  roundsOf,
  writeFinding,
  type StoredFinding,
} from "@maycombhq/naysayer";

/**
 * Rounds for a check that runs again and again (traceability after each generation or
 * build): the newest round always holds the whole picture, so the lifecycle's and the
 * critic's reading of a gate works unchanged. A new round is written only when something
 * changed; a finding seen before keeps its state and resolution (dismissed stays dismissed).
 * The same rules as the Spec Kit layer's drift rounds.
 */
export interface RoundWrite {
  gate: string;
  round?: number;
  unchanged: boolean;
  findings: StoredFinding[];
}

const sig = (fs: Finding[]) =>
  fs
    .map((f) => `${fingerprint(f)}|${f.state}|${f.severity}`)
    .sort()
    .join("\n");

export async function writeGateRound(
  root: string,
  change: string,
  gate: string,
  fresh: Finding[],
  now: string,
): Promise<RoundWrite> {
  const rounds = await roundsOf(root, change, gate);
  const last = rounds.at(-1);
  const prev = last
    ? (await readRound(root, change, gate, last)).findings.map((s) => s.finding)
    : [];
  const byPrint = new Map(prev.map((f) => [fingerprint(f), f]));
  const taken = new Set<string>();
  const next: Finding[] = [];
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
        createdAt: now,
        findings: findings.map((f) => ({
          id: f.finding.id,
          rule: f.finding.rule,
          severity: f.finding.severity,
        })),
      },
      ["schemaVersion", "change", "gate", "round", "createdAt"],
    ),
  );
  return { gate, round, unchanged: false, findings };
}
