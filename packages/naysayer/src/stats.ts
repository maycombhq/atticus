import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { CHANGES_DIR } from "@maycombhq/changes";
import type { Finding } from "@maycombhq/core";
import { fingerprint, readRound, reviewedGates, roundsOf } from "./findings.js";
import { linePatch } from "./patch.js";

/**
 * Override rates per rule across every change (open and archived): how often people dismiss
 * or waive what a rule finds. A rule dismissed again and again for the same reason is probably
 * wrong for this organisation, so the critic suggests a change to its checklist file: a patch
 * a person reviews in a PR, never applied automatically. Constitution rules are never relaxed;
 * for them the suggestion is a conversation with the pack owner.
 */

export interface RuleStats {
  rule: string;
  total: number;
  open: number;
  applied: number;
  dismissed: number;
  waived: number;
  asked: number;
  /** (dismissed + waived) / total. */
  overrideRate: number;
  /** Dismissal and waiver reasons, most common first. */
  reasons: { reason: string; count: number }[];
}

export interface ChecklistSuggestion {
  rule: string;
  reason: string;
  count: number;
  /** The checklist file holding the rule, relative to the metarepo root (absent for the constitution). */
  file?: string;
  /** A patch to that file for a person to review; never applied by Atticus. */
  patch?: string;
  message: string;
}

export interface OverrideStats {
  changes: number;
  rules: RuleStats[];
  suggestions: ChecklistSuggestion[];
}

const normReason = (r: string) =>
  r
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!]+$/, "");

async function dirs(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/** Every finding of a change, newest state per problem (a problem carried across rounds counts once). */
async function changeFindings(root: string, changeRoot: string, id: string): Promise<Finding[]> {
  const out = new Map<string, Finding>();
  const base = relative(join(root, CHANGES_DIR), changeRoot).split(sep).join("/");
  const rel = base ? `${base}/${id}` : id;
  for (const gate of await reviewedGates(root, rel)) {
    for (const round of await roundsOf(root, rel, gate)) {
      const { findings } = await readRound(root, rel, gate, round);
      for (const s of findings) out.set(`${gate}|${fingerprint(s.finding)}`, s.finding);
    }
  }
  return [...out.values()];
}

/** Find the checklist file that defines a rule, and the line of its `- id:`. */
async function ruleFile(
  root: string,
  rule: string,
): Promise<{ file: string; text: string; line: number } | undefined> {
  const files: string[] = [];
  async function walk(d: string) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (/\.ya?ml$/.test(e.name)) files.push(full);
    }
  }
  await walk(join(root, "org-pack", "checklists"));
  await walk(join(root, "org-pack", "teams"));
  for (const f of files) {
    const text = await readFile(f, "utf8");
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    const i = lines.findIndex((l) =>
      new RegExp(`^\\s*-\\s+id:\\s*["']?${rule.replace(/[.]/g, "\\.")}["']?\\s*$`).test(l),
    );
    if (i >= 0) return { file: relative(root, f).split(sep).join("/"), text, line: i + 1 };
  }
  return undefined;
}

export async function overrideStats(
  root: string,
  o: { threshold?: number } = {},
): Promise<OverrideStats> {
  const threshold = o.threshold ?? 3;
  const open = join(root, CHANGES_DIR);
  const archive = join(open, "archive");
  const all: Finding[] = [];
  let changes = 0;
  for (const [parent, ids] of [
    [open, (await dirs(open)).filter((d) => d !== "archive")],
    [archive, await dirs(archive)],
  ] as const) {
    for (const id of ids) {
      const fs = await changeFindings(root, parent, id);
      if (fs.length) changes++;
      all.push(...fs);
    }
  }
  const byRule = new Map<string, Finding[]>();
  for (const f of all) byRule.set(f.rule, [...(byRule.get(f.rule) ?? []), f]);
  const rules: RuleStats[] = [];
  const suggestions: ChecklistSuggestion[] = [];
  for (const [rule, fs] of [...byRule].sort(([a], [b]) => a.localeCompare(b))) {
    const n = (s: Finding["state"]) => fs.filter((f) => f.state === s).length;
    const reasons = new Map<string, { reason: string; count: number }>();
    for (const f of fs) {
      if ((f.state !== "dismissed" && f.state !== "waived") || !f.resolution?.reason) continue;
      const k = normReason(f.resolution.reason);
      const r = reasons.get(k) ?? { reason: f.resolution.reason.trim(), count: 0 };
      r.count++;
      reasons.set(k, r);
    }
    const sortedReasons = [...reasons.values()].sort(
      (a, b) => b.count - a.count || a.reason.localeCompare(b.reason),
    );
    const stats: RuleStats = {
      rule,
      total: fs.length,
      open: n("open"),
      applied: n("applied"),
      dismissed: n("dismissed"),
      waived: n("waived"),
      asked: n("asked"),
      overrideRate: fs.length ? (n("dismissed") + n("waived")) / fs.length : 0,
      reasons: sortedReasons,
    };
    rules.push(stats);
    const constitution = fs.some((f) => f.layer === "constitution");
    for (const r of sortedReasons.filter((x) => x.count >= threshold)) {
      if (constitution) {
        suggestions.push({
          rule,
          reason: r.reason,
          count: r.count,
          message: `${rule} is a constitution rule; it was overridden ${r.count} times for "${r.reason}". Constitution rules can't be relaxed: raise it with the pack owner.`,
        });
        continue;
      }
      const where = await ruleFile(root, rule);
      if (!where) {
        suggestions.push({
          rule,
          reason: r.reason,
          count: r.count,
          message: `${rule} was dismissed ${r.count} times for "${r.reason}", but no checklist file defines it.`,
        });
        continue;
      }
      const lines = where.text.replace(/\r\n/g, "\n").split("\n");
      const indent = /^(\s*)-/.exec(lines[where.line - 1]!)?.[1] ?? "";
      const note = `${indent}  # Review: dismissed ${r.count} times as "${r.reason.replace(/"/g, "'")}". Narrow appliesTo, lower the severity or retire the rule.`;
      // Draft until someone reviews it: a draft rule doesn't run, so the PR is the decision.
      const statusLine = lines
        .slice(where.line, where.line + 40)
        .findIndex((l) => /^\s*status:/.test(l));
      const replacement =
        statusLine >= 0 && lines[where.line + statusLine]!.startsWith(`${indent}  status:`)
          ? undefined
          : [lines[where.line - 1]!, note, `${indent}  status: draft`];
      const patch = replacement
        ? linePatch(where.file, where.text, where.line, where.line, replacement, 2)
        : linePatch(
            where.file,
            where.text,
            where.line,
            where.line,
            [lines[where.line - 1]!, note],
            2,
          );
      suggestions.push({
        rule,
        reason: r.reason,
        count: r.count,
        file: where.file,
        patch,
        message: `${rule} was dismissed ${r.count} times as "${r.reason}". Suggested change to ${where.file} (review it in a PR; Atticus never applies it).`,
      });
    }
  }
  return { changes, rules, suggestions };
}
