import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ReplayRuntime } from "@maycombhq/ai";
import { fileStepStore, MockWorkTracker } from "@maycombhq/adapters";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import {
  adoSync,
  planStories,
  snowDraft,
  snowSubmit,
  storyBarCommand,
  templatesDraft,
} from "../src/plan-commands.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const FORGE_CHANGE = join(HERE, "../../../fixtures/forge-change");
const CHANGE = "add-transfer-limit";
const NOW = "2026-10-20T09:00:00Z";

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

/** The M3 exit fixture without its hand-written plan, with every outside system manual. */
async function root(o: { manual?: boolean } = {}) {
  const r = await mkdtemp(join(tmpdir(), "atticus-plan-cli-"));
  await cp(join(FORGE, "metarepo/org-pack"), join(r, "org-pack"), { recursive: true });
  await cp(join(FORGE_CHANGE, "org-pack"), join(r, "org-pack"), { recursive: true });
  for (const row of parse(readFileSync(join(FORGE, "expected/scan.yaml"), "utf8")) as Record<
    string,
    unknown
  >[]) {
    const p = parseRecord({ schemaVersion: 1, status: "current", ...row });
    if (!p.ok) throw new Error("bad record");
    const f = join(r, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  const dir = join(r, "openspec/changes", CHANGE);
  await cp(join(FORGE_CHANGE, "openspec/changes", CHANGE), dir, { recursive: true });
  for (const f of ["stories.md", "tasks.md", "snow.md", "stories"])
    await rm(join(dir, f), { recursive: true, force: true });
  await cp(join(FORGE, "inputs"), join(r, "inputs"), { recursive: true });
  await writeFile(
    join(r, "org-pack/sources.yaml"),
    "schemaVersion: 1\nwikis:\n  - { id: forge-wiki, type: markdown-folder, location: ../inputs/wiki }\n",
  );
  if (o.manual)
    await writeFile(
      join(r, "org-pack/runtime.yaml"),
      "schemaVersion: 1\nassistants: { allowed: [copilot, claude-code], default: copilot }\nadapters:\n  workTracker: { type: manual }\n  serviceDesk: { type: manual }\n  gitHost: { type: manual }\n",
    );
  return r;
}

const deps = async () => ({
  runtime: await ReplayRuntime.fromDir(join(FORGE_CHANGE, "recordings"), {
    now: () => new Date(NOW),
  }),
  now: () => new Date(NOW),
});

describe("atticus plan and ado sync", () => {
  it("plans stories, drafts service-desk requests and measures the story bar", async () => {
    const r = await root();
    const a = io();
    expect(await planStories(r, CHANGE, {}, a.io, await deps())).toBe(0);
    expect(a.out[0]).toBe("Planned 5 stories and 9 tasks for add-transfer-limit in 3 repos.");
    expect(a.out).toContain(
      "Not planned: POST /risk/assess (ledger-api → risk-engine): risk-engine is not in the catalog; the critic raises it, and the hop is planned once the catalog knows it.",
    );
    const b = io();
    expect(await snowDraft(r, CHANGE, {}, b.io)).toBe(1);
    expect(b.out).toEqual([
      "Wrote 2 service-desk drafts to openspec/changes/add-transfer-limit/snow.md.",
      "  Gateway proxy deployment for gw-northwind-v2 (5 days): gw-northwind-v2 is planned-new (GatewayRoute)",
      "    To fill: Target: not in the catalog or the change; fill it in before submitting",
      "  Network firewall rule for gw-northwind-v2 (10 days): the new gateway proxy for gw-northwind-v2 also needs a network firewall rule",
      "    To fill: Destination host: not in the catalog or the change; fill it in before submitting",
      "    Assumed: Port 443, the HTTPS port, because POST /v2/velocity-checks is an HTTP call",
      "    Assumed: Protocol HTTPS, because POST /v2/velocity-checks is an HTTP call",
    ]);
    const c = io();
    expect(await storyBarCommand(r, CHANGE, {}, c.io)).toBe(0);
    expect(c.out.at(-1)).toBe("The story bar is met.");
    expect(c.out[0]).toBe(
      "5 of 5 stories are ready (100%, the bar is 90%); 2 of 2 gaps covered; 0 invented names.",
    );
    const d = io();
    expect(await planStories(r, undefined, {}, d.io)).toBe(2);
  });

  it("shows a dry run first, then syncs with one approval per write", async () => {
    const r = await root();
    await planStories(r, CHANGE, {}, io().io, await deps());
    const wt = new MockWorkTracker();
    const dry = io();
    expect(
      await adoSync(r, CHANGE, {}, dry.io, { workTracker: wt, now: () => new Date(NOW) }),
    ).toBe(0);
    expect(dry.out[0]).toBe(
      "Dry run: 15 work-item writes for add-transfer-limit. Nothing was sent.",
    );
    expect(dry.out.at(-1)).toBe(
      "Approve every write listed with --approve (you approve as your Git user).",
    );
    expect(wt.journal).toEqual([]);
    const live = io();
    expect(
      await adoSync(r, CHANGE, { approve: "bao" }, live.io, {
        workTracker: wt,
        now: () => new Date(NOW),
      }),
    ).toBe(0);
    expect(live.out[0]).toBe("Sent 15 work-item writes for add-transfer-limit.");
    expect(new Set(wt.journal.map((j) => j.approval?.ref)).size).toBe(15);
  });

  it("writes steps through the manual work tracker and service desk runtime.yaml configures", async () => {
    const r = await root({ manual: true });
    await planStories(r, CHANGE, {}, io().io, await deps());
    await snowDraft(r, CHANGE, {}, io().io);
    const a = io();
    expect(await adoSync(r, CHANGE, { approve: "bao" }, a.io, { now: () => new Date(NOW) })).toBe(
      0,
    );
    expect(a.out[1]).toBe(
      "  create feature: a step for a person (create-feature-add-a-daily-transfer-limit); see atticus todo.",
    );
    const snow = join(r, "openspec/changes", CHANGE, "snow.md");
    const b = io();
    expect(
      await snowSubmit(r, CHANGE, { approve: "dana" }, b.io, { now: () => new Date(NOW) }),
    ).toBe(1);
    expect(b.err).toEqual([
      "  Failed gateway-route|gw-northwind-v2: fill Target in snow.md first.",
      "  Failed firewall-rule|gw-northwind-v2: fill Destination host in snow.md first.",
    ]);
    await writeFile(
      snow,
      (await readFile(snow, "utf8"))
        .replace("| Target |  |", "| Target | https://api.northwind.example |")
        .replace("| Destination host |  |", "| Destination host | api.northwind.example |"),
    );
    const c = io();
    expect(
      await snowSubmit(r, CHANGE, { approve: "dana" }, c.io, { now: () => new Date(NOW) }),
    ).toBe(0);
    expect(c.out).toEqual([
      "Sent 2 service-desk writes for add-transfer-limit.",
      "  create gateway-route|gw-northwind-v2: a step for a person (request-gateway-route); see atticus todo.",
      "  create firewall-rule|gw-northwind-v2: a step for a person (request-firewall-rule); see atticus todo.",
    ]);
  });

  it("still needs --approve for every write now that the person is the Git user (ADR 0073)", async () => {
    const { main } = await import("../src/main.js");
    const r = await root({ manual: true });
    await planStories(r, CHANGE, {}, io().io, await deps());
    execFileSync("git", ["init", "-q", r]);
    execFileSync("git", ["-C", r, "config", "user.name", "Bao Tran"]);
    execFileSync("git", ["-C", r, "config", "user.email", "bao.tran@forge.example"]);
    // No --approve: a dry run, whoever you are; nothing is written for a person to do.
    const dry = io();
    expect(await main(["ado", "sync", CHANGE, "--root", r], dry.io)).toBe(0);
    expect(dry.out[0]).toMatch(
      /^Dry run: \d+ work-item writes for add-transfer-limit\. Nothing was sent\.$/,
    );
    expect(await fileStepStore(r).list()).toEqual([]);
    // --approve alone: the Git user approves each write.
    const live = io();
    expect(await main(["ado", "sync", CHANGE, "--approve", "--root", r], live.io)).toBe(0);
    expect(live.out[0]).toMatch(/^Sent \d+ work-item writes for add-transfer-limit\.$/);
    expect((await fileStepStore(r).list()).length).toBeGreaterThan(0);
  });

  it("drafts templates from knowledge as a proposal", async () => {
    const r = await root();
    const a = io();
    expect(await templatesDraft(r, { noAi: true }, a.io, { now: () => new Date(NOW) })).toBe(0);
    expect(a.out).toEqual([
      "Read 1 how-to source, 1 ticket export and 1 work-item export.",
      "  firewall-rule: the org pack's template agrees",
      "  gateway-route: the org pack's template agrees",
      "Wrote the proposal to proposals/templates/ (3 files); read SUMMARY.md, then copy what you accept into org-pack/ in a pull request.",
    ]);
  });
});
