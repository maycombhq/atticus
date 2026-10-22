import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadOrgPack } from "@maycombhq/core";
import { MockRuntime } from "@maycombhq/ai";
import { linksIn, readSnapshot, scanKnowledge, syncSources, writeSnapshots } from "../src/index.js";

/** ADR 0101: the links a page gives for an item (a request's form), kept with the item. */

const PAGE = `# Requests

## Kafka topic

When: a service will publish to or consume from a topic that does not exist yet.

Raise it in the [service desk catalogue](https://servicedesk.example.com/sp?id=sc_cat_item&sys_id=kafka-topic). Handled by: Messaging team. Lead time: 5 working days.

See also <https://wiki.example.com/messaging/topics> for naming.

## DNS entry

Handled by: Network team. Lead time: 2 working days. Form: https://servicedesk.example.com/sp?id=sc_cat_item&sys_id=dns-entry
`;

describe("the links on a page", () => {
  it("finds Markdown links, links in angle brackets and bare addresses, with their labels", () => {
    expect(linksIn(PAGE)).toEqual([
      {
        label: "service desk catalogue",
        url: "https://servicedesk.example.com/sp?id=sc_cat_item&sys_id=kafka-topic",
      },
      { url: "https://wiki.example.com/messaging/topics" },
      { url: "https://servicedesk.example.com/sp?id=sc_cat_item&sys_id=dns-entry" },
    ]);
  });
});

async function snapshot() {
  const base = await mkdtemp(join(tmpdir(), "atticus-links-"));
  await mkdir(join(base, "wiki"), { recursive: true });
  await writeFile(join(base, "wiki", "requests.md"), PAGE);
  const root = join(base, "meta");
  await mkdir(join(root, "org-pack"), { recursive: true });
  await writeFile(
    join(root, "org-pack", "sources.yaml"),
    `schemaVersion: 1\nwikis:\n  - { id: desk, type: markdown-folder, location: ${JSON.stringify(join(base, "wiki").split("\\").join("/"))} }\n`,
  );
  const op = await loadOrgPack(join(root, "org-pack"));
  const now = "2026-10-20T09:00:00Z";
  const s = await syncSources({ root, orgPack: op, orgPackDir: join(root, "org-pack"), now });
  await writeSnapshots({ root, orgPack: op, sync: s, takenAt: now });
  return (await readSnapshot(root, "desk"))!;
}

const item = (extra = "") => `items:
  - kind: request
    id: kafka-topic-request
    title: Kafka topic
    applies_when: A service will publish to or consume from a topic that does not exist yet.
    lead_time: 5 working days
    handled_by: Messaging team
${extra}    source: { page: requests.md, section: Kafka topic, quote: "Handled by: Messaging team. Lead time: 5 working days." }
`;

describe("a scanned item's links", () => {
  it("are the links under the heading it quotes, kept with it", async () => {
    const snap = await snapshot();
    const r = await scanKnowledge([snap], {
      runtime: new MockRuntime(() => item()),
      now: new Date("2026-10-20T09:00:00Z"),
    });
    expect(r.failed).toEqual([]);
    expect(r.items[0]).toMatchObject({
      urls: [
        {
          label: "service desk catalogue",
          url: "https://servicedesk.example.com/sp?id=sc_cat_item&sys_id=kafka-topic",
        },
        { url: "https://wiki.example.com/messaging/topics" },
      ],
    });
  });

  it("refuses a link the AI gives that isn't on the page", async () => {
    const snap = await snapshot();
    const answers = [
      item('    links: [{ url: "https://servicedesk.example.com/made-up" }]\n'),
      item(),
    ];
    let n = 0;
    const r = await scanKnowledge([snap], {
      runtime: new MockRuntime(() => answers[Math.min(n++, 1)]!),
      now: new Date("2026-10-20T09:00:00Z"),
    });
    expect(r.attempts[0]!.problems.join("\n")).toContain(
      "link https://servicedesk.example.com/made-up isn't on requests.md",
    );
    expect(r.items).toHaveLength(1);
  });
});

describe("correcting an item's links", () => {
  it("takes label=address or just the address, and refuses what isn't one", async () => {
    const { reviewItem } = await import("../src/index.js");
    const snap = await snapshot();
    const r = await scanKnowledge([snap], {
      runtime: new MockRuntime(() => item()),
      now: new Date("2026-10-20T09:00:00Z"),
    });
    const at = "2026-10-21T09:00:00Z";
    const ok = reviewItem(r.items[0]!, {
      verdict: "corrected",
      by: "tom",
      at,
      set: {
        urls: [
          "Kafka form=https://servicedesk.example.com/new-form",
          "https://wiki.example.com/topics",
        ],
      },
    });
    if ("error" in ok) throw new Error(ok.error);
    expect(ok.item).toMatchObject({
      urls: [
        { label: "Kafka form", url: "https://servicedesk.example.com/new-form" },
        { url: "https://wiki.example.com/topics" },
      ],
    });
    expect(
      reviewItem(r.items[0]!, {
        verdict: "corrected",
        by: "tom",
        at,
        set: { urls: ["not a link"] },
      }),
    ).toMatchObject({
      error: expect.stringContaining("isn't an http(s) address"),
    });
  });
});
