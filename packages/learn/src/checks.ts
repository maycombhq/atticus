import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parse } from "yaml";
import { fileStepStore } from "@maycombhq/adapters";
import { screenText, formatOf } from "@maycombhq/ai";
import { changeStore } from "@maycombhq/changes";
import {
  catalogDirOf,
  LIFECYCLE_STATES,
  stateDirOf,
  type CatalogRecord,
  type LifecycleState,
} from "@maycombhq/core";
import { readCatalog } from "@maycombhq/scanner";
import type { Check, Truth } from "./lessons.js";

/**
 * Checking a lesson step. Every check reads the sandbox's files: the catalog (generated and
 * curated), the index file, change folders, finding files and manual steps. An answer check
 * compares the learner's answer with what the sandbox itself says (its catalog, its inputs, its
 * changes), as a set of words: order, case and separators don't matter. Deterministic.
 */

export interface CheckResult {
  pass: boolean;
  /** One sentence for the learner. */
  message: string;
}

const ok = (message: string): CheckResult => ({ pass: true, message });
const no = (message: string): CheckResult => ({ pass: false, message });

async function catalog(root: string): Promise<CatalogRecord[]> {
  const dir = catalogDirOf(root);
  const g = await readCatalog(join(dir, "generated"));
  const c = await readCatalog(join(dir, "curated"));
  return [...g.records, ...c.records];
}

/** An answer as a set of lower-case words (ids keep their dots and dashes). */
export function answerSet(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[\s,;]+|\band\b/)
        .map((w) => w.replace(/^["'`([{<]+|["'`)\]}>.:!?]+$/g, ""))
        .filter(Boolean),
    ),
  ].sort();
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  const go = async (d: string) => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(d, e.name);
      if (e.isDirectory()) await go(full);
      else out.push(full);
    }
  };
  await go(dir);
  return out;
}

/** The right answer for a question, from the sandbox. */
export async function truthOf(root: string, t: Truth): Promise<string[]> {
  switch (t.from) {
    case "fixed":
      return answerSet(t.values.join(" "));
    case "table-readers": {
      const r = (await catalog(root)).find((x) => x.kind === "Table" && x.id === t.id);
      return r && r.kind === "Table" ? [...r.readers].sort() : [];
    }
    case "interface-callers": {
      const rs = (await catalog(root)).filter(
        (x): x is Extract<CatalogRecord, { kind: "Interface" }> =>
          x.kind === "Interface" && x.to === t.to && (!t.via || x.via === t.via),
      );
      return [...new Set(rs.map((r) => r.from))].sort();
    }
    case "system-owner": {
      const r = (await catalog(root)).find((x) => x.kind === "System" && x.id === t.id);
      return r && r.kind === "System" && r.owner ? [r.owner] : [];
    }
    case "systems-without-owner":
      return (await catalog(root))
        .filter((x) => x.kind === "System" && !x.owner)
        .map((x) => x.id)
        .sort();
    case "flagged-files": {
      const base = join(root, t.path);
      const out: string[] = [];
      for (const f of await walk(base)) {
        const text = await readFile(f, "utf8").catch(() => "");
        const rel = relative(root, f).split(sep).join("/");
        const s = screenText(text, { format: formatOf("document", rel) });
        if (s.risk === "medium" || s.risk === "high")
          out.push(
            rel
              .split("/")
              .pop()!
              .replace(/\.[a-z0-9]+$/i, "")
              .toLowerCase(),
          );
      }
      return out.sort();
    }
    case "change-state": {
      const c = await changeStore(root).tryRead(t.change);
      return c ? [c.state] : [];
    }
    case "feature-of": {
      const f = (await catalog(root)).find(
        (x) => x.kind === "Capability" && x.entryPoints.includes(t.entryPoint),
      );
      return f ? [f.id] : [];
    }
    case "unknown-pattern": {
      const text = await readFile(
        join(root, "openspec/changes", t.change, "interfaces.md"),
        "utf8",
      ).catch(() => "");
      const known = new Set(
        (await readdir(join(root, "org-pack", "patterns")).catch(() => [] as string[])).map((f) =>
          f.replace(/\.ya?ml$/, "").toLowerCase(),
        ),
      );
      const codes = [...text.matchAll(/\b([A-Z]\.[A-Z]{2,5}(?:\.[A-Z]{2,5})*)\b/g)].map((m) =>
        m[1]!.toLowerCase(),
      );
      return [...new Set(codes.filter((c) => !known.has(c)))].sort();
    }
    case "stories-without-criteria": {
      const dir = join(root, "openspec/changes", t.change, "stories");
      const out: string[] = [];
      for (const f of (await readdir(dir).catch(() => [] as string[]))
        .filter((n) => n.endsWith(".md"))
        .sort()) {
        const text = await readFile(join(dir, f), "utf8");
        const section = /## Acceptance criteria\s*\n([\s\S]*?)(\n## |$)/.exec(text)?.[1] ?? "";
        if (!/^\s*-\s*Given\b/im.test(section)) out.push(f.replace(/\.md$/, ""));
      }
      return out;
    }
  }
}

const rank = (s: string) =>
  s === "post-release-review"
    ? LIFECYCLE_STATES.indexOf("released") + 0.5
    : (LIFECYCLE_STATES as readonly string[]).indexOf(s);

async function findingFiles(root: string, change: string): Promise<Record<string, unknown>[]> {
  const dir = join(root, "openspec/changes", change, "review");
  const out: Record<string, unknown>[] = [];
  for (const f of await walk(dir)) {
    if (!f.endsWith(".yaml") || f.endsWith("round.yaml")) continue;
    const rel = relative(dir, f).split(sep);
    try {
      const v = parse(await readFile(f, "utf8")) as Record<string, unknown>;
      if (v && typeof v === "object" && "rule" in v)
        out.push({ ...v, _gate: rel[0], _round: rel[1] });
    } catch {
      // not a finding file
    }
  }
  return out;
}

/** Evaluate a check. `answer` is what the learner typed, for answer checks. */
export async function runCheck(root: string, check: Check, answer?: string): Promise<CheckResult> {
  switch (check.type) {
    case "all": {
      for (const c of check.checks) {
        const r = await runCheck(root, c, answer);
        if (!r.pass) return r;
      }
      return ok("Done.");
    }
    case "catalog-has": {
      const rs = (await catalog(root)).filter(
        (r) => r.kind === check.kind && (!check.id || r.id === check.id),
      );
      const min = check.min ?? 1;
      return rs.length >= min
        ? ok(
            `The catalog has ${rs.length} ${check.kind} record${rs.length === 1 ? "" : "s"}${check.id ? ` (${check.id})` : ""}.`,
          )
        : no(
            `The catalog has ${rs.length} ${check.kind} record${rs.length === 1 ? "" : "s"}${check.id ? ` named ${check.id}` : ""}; it needs ${min}.`,
          );
    }
    case "index-built":
      return existsSync(join(stateDirOf(root), ".index", "catalog.sqlite"))
        ? ok("The index is built.")
        : no("There is no index yet.");
    case "file": {
      const p = join(root, ...check.path.split("/"));
      let text: string;
      try {
        if (!(await stat(p)).isFile()) return no(`${check.path} isn't a file.`);
        text = await readFile(p, "utf8");
      } catch {
        return no(`${check.path} doesn't exist yet.`);
      }
      for (const c of check.contains ?? [])
        if (!text.includes(c)) return no(`${check.path} doesn't say "${c}" yet.`);
      for (const c of check.notContains ?? [])
        if (text.includes(c)) return no(`${check.path} still says "${c}".`);
      return ok(`${check.path} is there.`);
    }
    case "files": {
      const fs = (await walk(join(root, ...check.dir.split("/")))).filter(
        (f) => !check.suffix || f.endsWith(check.suffix),
      );
      const min = check.min ?? 1;
      return fs.length >= min
        ? ok(`${check.dir} has ${fs.length} file${fs.length === 1 ? "" : "s"}.`)
        : no(
            `${check.dir} has ${fs.length} file${fs.length === 1 ? "" : "s"}${check.suffix ? ` ending ${check.suffix}` : ""}; it needs ${min}.`,
          );
    }
    case "curated-decision": {
      const d = (await catalog(root)).find(
        (r) =>
          r.kind === "CuratedDecision" &&
          r.action === check.action &&
          r.target === check.target &&
          (!check.includes ||
            JSON.stringify(r.value ?? null)
              .toLowerCase()
              .includes(check.includes.toLowerCase())),
      );
      return d
        ? ok(`A ${check.action} decision on ${check.target} is recorded (${d.id}).`)
        : no(
            `No ${check.action} decision on ${check.target}${check.includes ? ` naming "${check.includes}"` : ""} is recorded yet.`,
          );
    }
    case "record": {
      const r = (await catalog(root)).find((x) => x.kind === check.kind && x.id === check.id) as
        Record<string, unknown> | undefined;
      if (!r) return no(`There is no ${check.kind} ${check.id} yet.`);
      for (const [k, v] of Object.entries(check.where ?? {}))
        if (String(r[k] ?? "") !== v)
          return no(`${check.kind} ${check.id} has ${k} ${String(r[k] ?? "unset")}, not ${v}.`);
      return ok(`${check.kind} ${check.id} is there.`);
    }
    case "change-state": {
      const c = await changeStore(root)
        .tryRead(check.change)
        .catch(() => undefined);
      if (!c) return no(`There is no change ${check.change} yet.`);
      return c.state !== "returned" && rank(c.state) >= rank(check.atLeast)
        ? ok(`${check.change} is in ${c.state}.`)
        : no(
            `${check.change} is in ${c.state}; it needs to reach ${check.atLeast as LifecycleState}.`,
          );
    }
    case "findings": {
      const all = await findingFiles(root, check.change);
      const newest = new Map<string, number>();
      for (const f of all)
        newest.set(String(f._gate), Math.max(newest.get(String(f._gate)) ?? 0, Number(f._round)));
      const fs = all.filter(
        (f) =>
          (!check.latest || Number(f._round) === newest.get(String(f._gate))) &&
          (!check.gate || f._gate === check.gate) &&
          (!check.rule || f.rule === check.rule) &&
          (!check.artifact || f.artifact === check.artifact) &&
          (!check.state || f.state === check.state),
      );
      const min = check.min ?? 1;
      const what = `finding${fs.length === 1 ? "" : "s"}${check.rule ? ` for ${check.rule}` : ""}${check.gate ? ` at ${check.gate}` : ""}`;
      if (fs.length < min)
        return no(`${check.change} has ${fs.length} ${what}; run the critic first.`);
      if (check.max !== undefined && fs.length > check.max)
        return no(`${check.change} still has ${fs.length} ${what}.`);
      return ok(`${check.change} has ${fs.length} ${what}.`);
    }
    case "answer": {
      if (answer === undefined || !answer.trim())
        return no(`Answer the question: ${check.question}`);
      const want = await truthOf(root, check.truth);
      if (!want.length)
        return no("The sandbox can't answer this yet: do the steps before it first.");
      const got = answerSet(answer);
      const missing = want.filter((w) => !got.includes(w));
      const extra = got.filter((g) => !want.includes(g));
      if (!missing.length && !extra.length) return ok("Right.");
      return no(
        missing.length && extra.length
          ? "Not quite: some of that is wrong and something is missing."
          : missing.length
            ? `Not quite: there is more (${missing.length} missing).`
            : "Not quite: some of that isn't right.",
      );
    }
    case "steps": {
      const steps = await fileStepStore(root).list({
        ...(check.action ? { action: check.action } : {}),
        ...(check.state ? { state: check.state } : {}),
      });
      const min = check.min ?? 1;
      return steps.length >= min
        ? ok(`${steps.length} manual step${steps.length === 1 ? "" : "s"} recorded.`)
        : no(
            `No manual step${check.action ? ` (${check.action})` : ""}${check.state ? ` ${check.state}` : ""} yet.`,
          );
    }
  }
}
