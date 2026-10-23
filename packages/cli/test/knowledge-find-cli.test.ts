import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockRuntime } from "@maycombhq/ai";
import { sourcesSync } from "../src/knowledge-commands.js";
import {
  knowledgeFind,
  knowledgeFinds,
  knowledgeKeep,
  knowledgeList,
} from "../src/knowledge-scan-commands.js";

/** ADR 0101: atticus knowledge find, keep and finds. */

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

const PAGE = `# Onboarding a new joiner

## Getting a laptop

Raise the new starter request in the [service desk](https://servicedesk.example.com/sp?id=new-starter). Allow two weeks before the start date. Handled by: Workplace team.
`;

const ANSWER = `items:
  - kind: request
    id: new-starter-request
    title: New starter request
    applies_when: A new joiner needs a laptop and accounts.
    handled_by: Workplace team
    lead_time: two weeks
    source: { page: joiners.md, section: Getting a laptop, quote: "Allow two weeks before the start date. Handled by: Workplace team." }
`;

async function metarepo() {
  const base = await mkdtemp(join(tmpdir(), "atticus-find-cli-"));
  await mkdir(join(base, "wiki"), { recursive: true });
  await writeFile(join(base, "wiki", "joiners.md"), PAGE);
  const root = join(base, "meta");
  await mkdir(join(root, "org-pack"), { recursive: true });
  await writeFile(
    join(root, "org-pack", "sources.yaml"),
    `schemaVersion: 1\nwikis:\n  - { id: people, type: markdown-folder, location: ${JSON.stringify(join(base, "wiki").split("\\").join("/"))} }\n`,
  );
  await sourcesSync(root, capture().io, { now: "2026-10-22T09:00:00Z" });
  return root;
}

const now = new Date("2026-10-22T10:00:00Z");

describe("atticus knowledge find, keep and finds", () => {
  it("searches the wikis, has the assistant read the pages that mention it, and saves what it found", async () => {
    const root = await metarepo();
    const c = capture();
    expect(
      await knowledgeFind(
        root,
        "new starter",
        {},
        { runtime: new MockRuntime(() => ANSWER), now },
        c.io,
      ),
    ).toBe(0);
    expect(c.out[0]).toBe('"new starter" is on 1 page: people/joiners.md.');
    expect(c.out.join("\n")).toMatch(
      /new\s+request new-starter-request: New starter request \(joiners\.md\)/,
    );
    expect(c.out.at(-1)).toMatch(/Saved in knowledge\/finds\/new-starter\.yaml/);

    const json = capture();
    await knowledgeFind(
      root,
      "new starter",
      { json: true },
      { runtime: new MockRuntime(() => ANSWER), now },
      json.io,
    );
    const r = JSON.parse(json.out.join("\n")) as {
      status: string;
      candidates: { id: string; urls?: { url: string }[] }[];
    };
    expect(r.status).toBe("found");
    expect(r.candidates[0]!.urls).toEqual([
      { label: "service desk", url: "https://servicedesk.example.com/sp?id=new-starter" },
    ]);

    const none = capture();
    expect(
      await knowledgeFind(
        root,
        "kubernetes",
        {},
        { runtime: new MockRuntime(() => ANSWER), now },
        none.io,
      ),
    ).toBe(0);
    expect(none.out).toEqual([
      'No page of the wikis mentions "kubernetes". Nothing was sent to the assistant.',
    ]);
  });

  it("keeps a found item as a knowledge item the person verified, and lists the searches", async () => {
    const root = await metarepo();
    await knowledgeFind(
      root,
      "new starter",
      {},
      { runtime: new MockRuntime(() => ANSWER), now },
      capture().io,
    );
    const k = capture();
    expect(await knowledgeKeep(root, "new-starter-request", { by: "tom", now }, k.io)).toBe(0);
    expect(k.out[0]).toBe(
      "Kept new-starter-request as a request, verified by tom: plans, answers and lists read it from now on.",
    );
    const list = capture();
    await knowledgeList(root, {}, list.io);
    expect(list.out.join("\n")).toMatch(/new-starter-request\s.*✓ tom/);
    const finds = capture();
    await knowledgeFinds(root, {}, finds.io);
    expect(finds.out.join("\n")).toMatch(/new-starter\s+new starter\s+2026-10-22\s+1\s+1/);
    const bad = capture();
    expect(await knowledgeKeep(root, "nope", { by: "tom", now }, bad.io)).toBe(2);
    expect(bad.err[0]).toMatch(/No saved search has a candidate nope/);
  });
});
