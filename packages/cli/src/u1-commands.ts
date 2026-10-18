import { resolve } from "node:path";
import {
  CONFORMANCE_KINDS,
  conformanceRun,
  type ConformanceKind,
  type ConformanceReport,
} from "@maycombhq/conformance";
import type { Output } from "./commands.js";

/**
 * atticus conformance <target> --kind <catalog|org-pack|dialect|plugin|executor>
 *   [--executor <name>] [--fixture <repo folder>] [--json]
 *
 * Checks a catalog folder, an org pack, a dialect, a plugin module or a step executor against
 * the published specification (docs/spec). Exit 0 when every check passes (warnings allowed),
 * 1 when a check fails, 2 for a missing or unknown kind.
 */
export async function conformanceCommand(
  target: string,
  o: { kind?: string; json?: boolean; executor?: string; fixture?: string },
  io: Output,
): Promise<number> {
  if (!o.kind || !(CONFORMANCE_KINDS as string[]).includes(o.kind)) {
    io.err(
      `Say what to check with --kind: ${CONFORMANCE_KINDS.join(", ")}.${o.kind ? ` "${o.kind}" isn't one of them.` : ""}`,
    );
    return 2;
  }
  const report = await conformanceRun(resolve(target), {
    kind: o.kind as ConformanceKind,
    ...(o.executor ? { executor: o.executor } : {}),
    ...(o.fixture ? { fixture: resolve(o.fixture) } : {}),
  });
  if (o.json) io.out(JSON.stringify(report, null, 2));
  else for (const l of lines(report)) io.out(l);
  return report.passed ? 0 : 1;
}

const MARK = { pass: "ok  ", fail: "FAIL", warn: "warn" } as const;

function lines(r: ConformanceReport): string[] {
  const out = [`Conformance of ${r.target} (${r.kind}) to specification ${r.specVersion}:`];
  for (const x of r.results)
    out.push(`  ${MARK[x.status]}  ${x.check}  ${x.file ? `${x.file}: ` : ""}${x.message}`);
  const { pass, fail, warn } = r.summary;
  const n = (k: number, word: string) => `${k} ${word}${k === 1 ? "" : "s"}`;
  const warnings = warn ? `, ${n(warn, "warning")}` : "";
  out.push(
    r.passed
      ? `Passed: ${n(pass, "check")}${warnings}.`
      : `Failed: ${n(fail, "problem")}, ${n(pass, "check")} passed${warnings}.`,
  );
  return out;
}
