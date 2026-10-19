import { cp, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { atticus, Clock, fingerprint, json, sandbox } from "./helpers.js";

/**
 * The knowledge-source bar: every file a team drops into inputs/ has an outcome a person can see
 * (facts taken with the file cited, a reader elsewhere, or a person or AI step to read it), none
 * is dropped silently, and a document never overrides a fact verified from code.
 *
 * The drafted-org-pack bar: from a new metarepo's wiki pages and ticket exports, Atticus drafts
 * request and work-item templates in which every value cites where it came from, leaves the org
 * pack untouched until a person accepts the proposal by pull request, and names what only a
 * person can add. Accepting it is the person's part (docs/m4-exit.md).
 */

interface Doc {
  path: string;
  status: string;
  classification: string;
  records: string[];
  reader?: string;
}

describe("the knowledge-source bar", () => {
  it("gives every file in inputs/ an outcome, cites it on every fact, and lets code win", async () => {
    const clock = new Clock();
    const { root } = await sandbox();
    expect((await atticus(root, "scan")).code).toBe(0);
    clock.lap("scan with inputs");

    const files = Object.keys(await fingerprint(join(root, "inputs"))).map((p) => `inputs/${p}`);
    const list = await atticus(root, "intake", "list", "--json");
    expect(list.code, list.text).toBe(0);
    const intake = json<{ documents: Doc[]; problems: unknown[] }>(list);
    clock.lap("intake list");
    expect(intake.problems).toEqual([]);
    // Every file is accounted for, and nothing failed.
    expect(intake.documents.map((d) => d.path).sort()).toEqual(files.sort());
    expect(intake.documents.filter((d) => d.status === "failed")).toEqual([]);

    const by = (s: string) => intake.documents.filter((d) => d.status === s).map((d) => d.path);
    // Read: the diagram and the partner spec.
    expect(by("read")).toEqual([
      "inputs/diagrams/forge-context.drawio",
      "inputs/partner-specs/northwind-pay-openapi.yaml",
    ]);
    // Ticket exports have their own readers: templates draft and the service desk read them.
    expect(by("no-reader").every((p) => p.startsWith("inputs/tickets/"))).toBe(true);
    const drafted = await atticus(root, "templates", "draft", "--no-ai");
    expect(drafted.text).toMatch(/1 ticket export and 1 work-item export/);
    // Free text waits for the reading agent; with AI off each becomes an item for a person.
    const prose = by("needs-reading");
    expect(prose.length).toBe(3);
    const runtime = join(root, "org-pack/runtime.yaml");
    await writeFile(runtime, `${await readFile(runtime, "utf8")}ai: off\n`);
    const triage = json<{ items: { id: string; kind: string; source?: { path: string } }[] }>(
      await atticus(root, "triage", "--json"),
    );
    const reading = triage.items.filter((t) => t.kind === "needs-reading");
    expect(reading.map((t) => t.source?.path).sort()).toEqual(prose.sort());
    clock.lap("route every file");

    // Every fact taken from a document cites it, and only a published spec is verified.
    const facts: { kind: string; id: string; confidence: string; paths: string[] }[] = [];
    const dir = join(root, "catalog/generated");
    for (const kind of await readdir(dir))
      for (const f of await readdir(join(dir, kind))) {
        const r = parse(await readFile(join(dir, kind, f), "utf8")) as {
          kind: string;
          id: string;
          confidence: string;
          evidence: { path?: string; repo?: string }[];
        };
        const paths = r.evidence.map((e) => e.path ?? "");
        if (paths.some((p) => p.startsWith("inputs/")))
          facts.push({ kind: r.kind, id: r.id, confidence: r.confidence, paths });
      }
    const fromDocs = facts.filter((f) => f.kind !== "SourceDocument");
    expect(fromDocs.length).toBeGreaterThan(0);
    for (const f of fromDocs) {
      const spec = f.paths.some((p) => p.startsWith("inputs/partner-specs/"));
      if (!spec) expect(f.confidence, `${f.kind} ${f.id}`).not.toBe("verified");
    }
    // Where the diagram and the code disagree, the disagreement is an item for the architect.
    const conflicts = triage.items.filter((t) => t.kind === "conflict" || t.kind === "diagram-gap");
    expect(conflicts.length).toBeGreaterThanOrEqual(4);
    clock.lap("check provenance and conflicts");
    clock.report("Knowledge sources, machine time");
    expect(clock.total).toBeLessThan(60_000);
  });
});

describe("the drafted-org-pack bar", () => {
  it("drafts cited templates from a new metarepo's knowledge and leaves the org pack alone", async () => {
    const clock = new Clock();
    const { top } = await sandbox();
    const root = join(await mkdtemp(join(tmpdir(), "atticus-m4-new-")), "meta");
    const init = await atticus(undefined, "init", root, "--platform", "forge");
    expect(init.code, init.text).toBe(0);
    await cp(join(top, "inputs"), join(root, "inputs"), { recursive: true });
    const before = await fingerprint(join(root, "org-pack"));
    clock.lap("new metarepo with the team's wiki pages and exports");

    const r = await atticus(root, "templates", "draft", "--no-ai");
    expect(r.code, r.text).toBe(0);
    expect(r.text).toMatch(/firewall-rule: new draft/);
    clock.lap("templates draft");
    expect(await fingerprint(join(root, "org-pack"))).toEqual(before);

    const proposals = join(root, "proposals/templates/process");
    const drafted = Object.keys(await fingerprint(proposals));
    expect(drafted.sort()).toEqual([
      "snow/firewall-rule.yaml",
      "snow/gateway-route-review.yaml",
      "work-items/story.yaml",
    ]);
    // Every drafted value says where it came from.
    for (const f of drafted.filter((p) => p.startsWith("snow/"))) {
      const lines = (await readFile(join(proposals, f), "utf8"))
        .split("\n")
        .filter((l) => /^(name|requestType|approvers|leadTimeDays):|^\s+- \{ name:/.test(l));
      expect(lines.length).toBeGreaterThan(2);
      for (const l of lines) expect(l, `${f}: ${l}`).toMatch(/# inputs\//);
    }
    // What only a person can add is named, and once added the pack validates.
    const summary = await readFile(join(root, "proposals/templates/SUMMARY.md"), "utf8");
    expect(summary).toMatch(/add one by hand/);
    const pack = join(await mkdtemp(join(tmpdir(), "atticus-m4-pack-")), "org-pack");
    await cp(join(root, "org-pack"), pack, { recursive: true });
    await cp(proposals, join(pack, "process"), { recursive: true });
    const raw = await atticus(undefined, "orgpack", "validate", pack);
    expect(raw.code).toBe(1);
    expect(raw.text.match(/\(triggers\)/g)).toHaveLength(2);
    for (const f of ["firewall-rule", "gateway-route-review"]) {
      const p = join(pack, "process/snow", `${f}.yaml`);
      await writeFile(
        p,
        (await readFile(p, "utf8")).replace(
          /^triggers: \[\].*$/m,
          "triggers: [{ kind: Interface, change: planned-new }]",
        ),
      );
    }
    const ok = await atticus(undefined, "orgpack", "validate", pack);
    expect(ok.code, ok.text).toBe(0);
    clock.lap("accept with a trigger each, then validate");
    clock.report("Drafted org pack, machine time");
  });
});
