import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { MockRuntime } from "@maycombhq/ai";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { stageCli } from "../src/stage-commands.js";

/**
 * ADR 0201 decision 8, from the command line: the staged path says where to go. On the small
 * Forge estate with a manifest that lists forge-infra, a repo nobody read. `atticus change
 * feature` passes a new flow put there, notes a repo the answer marks as new, and stops on the
 * first draft that places nothing, naming the quick path and its command. A mock model.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const NOW = new Date("2026-11-18T09:00:00Z");
const CHANGE = "add-fraud-check";

async function estate(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-stage-quick-"));
  await mkdir(join(root, "org-pack/profiles/forge"), { recursive: true });
  await writeFile(
    join(root, "org-pack/profiles/forge/repos.manifest.yaml"),
    "schemaVersion: 1\nplatform: forge\nrepos:\n  - id: forge-infra\n    url: https://git.example.com/forge/forge-infra.git\n    type: infra\n    owner: team-platform\n",
  );
  const rows = [
    ...(parse(readFileSync(join(FIXTURES, "specs/catalog.yaml"), "utf8")) as unknown[]),
    ...(parse(readFileSync(join(FIXTURES, "stages/catalog-extra.yaml"), "utf8")) as unknown[]),
  ];
  for (const r of rows) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error("bad fixture record");
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(join(FIXTURES, "stages/specs"), join(root, "specs"), { recursive: true });
  await cp(join(FIXTURES, "stages/changes"), join(root, "openspec/changes"), { recursive: true });
  return root;
}

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};

const run = async (answer: string) => {
  const root = await estate();
  const o = io();
  let drafts = 0;
  const runtime = new MockRuntime(
    (req) => {
      if (req.agent.id.endsWith("-critic")) return "findings: []";
      if (req.agent.id === "context-expander") return "terms: []\nnames: []\n";
      drafts++;
      return answer;
    },
    { now: () => NOW },
  );
  const code = await stageCli(root, ["change", "feature", CHANGE], {}, o.io, { runtime, now: NOW });
  return { code, drafts, ...o };
};

describe("atticus change feature, where the staged path can't express the change", () => {
  it("places a new flow in a manifest repo nobody read, and in a repo marked newRepo: true", async () => {
    const r = await run(`summary: The screen's queue and the storefront that uses it.
flows:
  - { id: forge-orders.place-order, how: changed, why: The screen runs before stock is reserved. }
newFlows:
  - { name: Screening queue, repo: forge-infra, why: The screen needs a queue. }
  - { name: Storefront checkout, repo: forge-storefront, newRepo: true, why: The new product's own flow. }
`);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.drafts).toBe(1);
    expect(r.out.join("\n")).toContain("The feature stage is done after 1 draft");
    expect(r.out.join("\n")).toContain(
      'New flow "Storefront checkout" is put in forge-storefront, a new repo this change plans. Once it is created on your Git host, add it: atticus repo add <its clone URL> --id forge-storefront.',
    );
  });

  it("stops once, on the first draft that places nothing, and names the quick path and its command", async () => {
    const r = await run("summary: The order services move to another platform.\n");
    expect(r.code).toBe(1);
    expect(r.drafts).toBe(1);
    expect(r.err.join("\n").split("\n")).toEqual([
      "The feature stage stopped after 1 draft: it found nothing for the staged path to plan.",
      "  - The feature touches nothing: name the features and flows it touches, the new flows it needs, or its operations. (rule feature.nothing-placed; in openspec/changes/add-fraud-check/feature.yaml)",
      "If this change alters no runtime step in a repo the map holds (a new product, a move to another platform, pipeline or configuration work), it belongs on the quick path: write its requirements file and run atticus change new --from <requirements.md>.",
    ]);
  });
});
