import { join } from "node:path";
import { loadOrgPack, type ExecutorConfig, type Procedure, orgPackDirOf } from "@maycombhq/core";
import { clientFor, isLocalUrl, TransportError, type ExecutorClient } from "./transports.js";
import { loadExecutors } from "./run.js";

/**
 * `atticus executors check`: every executor the person configured, whether it answers, what
 * it says it can run, and which procedures the org pack allows it for. Pinging is a read;
 * nothing runs.
 */

export interface ExecutorStatus {
  name: string;
  transport: ExecutorConfig["transport"];
  where: string;
  reachable: boolean;
  version?: string;
  fillOnly: boolean;
  /** What it says it can run (its ping, else its config). */
  covers: string[];
  /** Procedures that allowlist it (executors.allowed). */
  allowedFor: string[];
  problem?: string;
}

export interface ExecutorsCheckResult {
  executors: ExecutorStatus[];
  /** Procedures that allow an executor nobody configured. */
  missing: { procedure: string; executor: string }[];
  problems: string[];
}

export async function executorsCheck(
  root: string,
  o: {
    executors?: ExecutorConfig[];
    procedures?: Procedure[];
    client?: (cfg: ExecutorConfig) => ExecutorClient;
  } = {},
): Promise<ExecutorsCheckResult> {
  const loaded = o.executors ? { executors: o.executors, problems: [] } : await loadExecutors(root);
  const procedures = o.procedures ?? (await loadOrgPack(join(orgPackDirOf(root)))).procedures;
  const out: ExecutorStatus[] = [];
  for (const cfg of loaded.executors) {
    const allowedFor = procedures
      .filter((p) => p.executors.allowed.includes(cfg.name))
      .map((p) => p.id);
    const where = cfg.transport === "http" ? cfg.url! : [cfg.command, ...cfg.args].join(" ");
    const base = {
      name: cfg.name,
      transport: cfg.transport,
      where,
      fillOnly: cfg.fillOnly,
      allowedFor,
    };
    if (cfg.transport === "http" && !isLocalUrl(cfg.url!)) {
      const host = new URL(cfg.url!).hostname;
      const ok = procedures.some((p) => p.executors.remoteHosts.includes(host));
      if (!ok) {
        out.push({
          ...base,
          reachable: false,
          covers: cfg.procedures,
          problem: `${host} isn't this machine and no procedure allows it; it isn't pinged.`,
        });
        continue;
      }
    }
    try {
      const pong = await (o.client ?? clientFor)(cfg).ping();
      out.push({
        ...base,
        reachable: true,
        version: pong.version,
        fillOnly: cfg.fillOnly || pong.fillOnly,
        covers: [
          ...new Set([...pong.procedures, ...pong.stepKinds, ...cfg.procedures, ...cfg.stepKinds]),
        ].sort(),
      });
    } catch (e) {
      out.push({
        ...base,
        reachable: false,
        covers: [...cfg.procedures, ...cfg.stepKinds],
        problem: e instanceof TransportError ? e.message : `${cfg.name}: ${(e as Error).message}`,
      });
    }
  }
  const names = new Set(loaded.executors.map((e) => e.name));
  const missing = procedures.flatMap((p) =>
    p.executors.allowed.filter((n) => !names.has(n)).map((n) => ({ procedure: p.id, executor: n })),
  );
  return { executors: out, missing, problems: loaded.problems };
}
