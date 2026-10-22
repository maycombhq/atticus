import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import { reviewItem, writeReview, readKnowledge } from "@maycombhq/knowledge";
import { findNeeds, markNeed, mergeStoryRequests, NeedsFile, readNeeds } from "../src/index.js";

/**
 * ADR 0101: what a change needs from the organisation. The assistant reads the change (its
 * brief, feature, stories and tasks) and the knowledge items, and says which apply, to what,
 * and why, quoting the change's own words; Atticus checks each one and keeps the list a
 * developer works through, with each item's how-to, lead time and who handles it.
 */

const CHANGE = "add-chat-export";
const quote = (page: string, section: string, text: string) => ({
  source: "platform",
  page,
  section,
  text,
  snapshot: "2026-10-20",
});
const item = (r: Record<string, unknown>) => {
  const p = parseRecord({
    schemaVersion: 2,
    status: "current",
    confidence: "inferred",
    evidence: [{ source: "document", path: "knowledge/snapshots/platform/2026-10-20/x.md" }],
    tags: [],
    alsoOn: [],
    ...r,
  });
  if (!p.ok) throw new Error(JSON.stringify(p.issues));
  return p.record;
};
const KAFKA = item({
  kind: "ProcessDefinition",
  id: "kafka-topic-request",
  title: "Kafka topic",
  processKind: "request",
  appliesWhen: "A service will publish to or consume from a topic that does not exist yet.",
  leadTime: "5 working days",
  handledBy: "Messaging team",
  catalogueItem: "CTASK: Kafka topic",
  steps: ["Open the platform catalogue", "Pick Kafka topic"],
  urls: [{ label: "service desk catalogue", url: "https://servicedesk.example.com/kafka-topic" }],
  quote: quote(
    "how-to/kafka.md",
    "The request",
    "Handled by: Messaging team. Lead time: 5 working days.",
  ),
});
const SSO = item({
  kind: "ProcessDefinition",
  id: "sso-intake",
  title: "SSO intake",
  processKind: "request",
  appliesWhen: "A new web application needs single sign-on.",
  leadTime: "10 working days",
  handledBy: "Identity team",
  quote: quote("how-to/sso.md", "Intake", "Handled by: Identity team. Lead time: 10 working days."),
});
const LOGGING = item({
  kind: "Pattern",
  id: "json-logging",
  code: "json-logging",
  name: "Log as JSON",
  patternKind: "standard",
  patternStatus: "to-review",
  appliesWhen: "Any backend service.",
  rules: ["Log as JSON"],
  quote: quote("standards/logging.md", "Logging", "Log as JSON."),
});

async function metarepo() {
  const root = await mkdtemp(join(tmpdir(), "atticus-needs-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  await writeFile(join(root, "org-pack", "sources.yaml"), "schemaVersion: 1\n");
  for (const r of [KAFKA, SSO, LOGGING]) {
    const f = join(root, "knowledge", "items", ...recordPath(r).split("/"));
    await mkdir(join(f, ".."), { recursive: true });
    await writeFile(f, serializeRecord(r));
  }
  const dir = join(root, "openspec", "changes", CHANGE);
  await mkdir(join(dir, "stories"), { recursive: true });
  await writeFile(
    join(dir, "change.yaml"),
    `schemaVersion: 1\nid: ${CHANGE}\ntitle: Let a member export a chat\ntype: feature\ntemplate: feature\nstate: plan\nauthors: {}\ncreatedAt: 2026-10-20T09:00:00Z\n`,
  );
  await writeFile(
    join(dir, "brief.md"),
    "# Let a member export a chat\n\nA member downloads the chat as a file. Each export is announced on a new chat-exports topic for the audit service.\n",
  );
  await writeFile(
    join(dir, "feature.yaml"),
    `schemaVersion: 1\nchange: ${CHANGE}\nentry: brief\nsummary: Export a chat.\nfeatures:\n  - { id: feature.chats, why: x }\nflows:\n  - { id: chat-api.open-chat, why: x, how: read }\n`,
  );
  await writeFile(
    join(dir, "stories", "s1-export-chat.md"),
    "# s1-export-chat: Export a chat\n\nPublish an export event on the chat-exports topic.\n",
  );
  await writeFile(
    join(dir, "tasks.md"),
    "# Tasks\n\n- [ ] 1.1 Add the publish step: an event on chat-exports (story s1-export-chat)\n",
  );
  return { root, dir };
}

const GOOD = `needs:
  - item: kafka-topic-request
    for: story:s1-export-chat
    why: The story publishes on a topic that doesn't exist yet.
    because: { file: stories/s1-export-chat.md, quote: "Publish an export event on the chat-exports topic." }
    when: before-build
  - item: json-logging
    for: change
    why: The export is a backend service change.
    because: { file: brief.md, quote: "A member downloads the chat as a file." }
not_needed:
  - { item: sso-intake, why: The change adds no new web application. }
`;

const run = (answer: string | ((r: AiRequest) => string)) =>
  new MockRuntime(typeof answer === "string" ? () => answer : answer);
const NOW = new Date("2026-10-22T09:00:00Z");

describe("what a change needs", () => {
  it("is what the assistant finds, each need checked, with the item's how-to beside it", async () => {
    const { root, dir } = await metarepo();
    let prompt = "";
    const r = await findNeeds(root, CHANGE, {
      runtime: run((q) => {
        prompt = q.pack.prompt;
        return GOOD;
      }),
      now: NOW,
    });
    expect(r.status).toBe("done");
    expect(prompt).toContain("kafka-topic-request");
    expect(prompt).toContain("Each export is announced on a new chat-exports topic");
    expect(prompt).toContain("story:s1-export-chat");
    expect(prompt).toContain("task:1.1");
    const f = NeedsFile.parse(parse(readFileSync(join(dir, "needs.yaml"), "utf8")));
    expect(f.needs.map((n) => [n.item, n.for, n.status, n.from])).toEqual([
      ["json-logging", "change", "open", "assistant"],
      ["kafka-topic-request", "story:s1-export-chat", "open", "assistant"],
    ]);
    expect(f.needs[1]).toMatchObject({
      kind: "request",
      title: "Kafka topic",
      leadTime: "5 working days",
      handledBy: "Messaging team",
      catalogueItem: "CTASK: Kafka topic",
      steps: ["Open the platform catalogue", "Pick Kafka topic"],
      when: "before-build",
      because: { file: "stories/s1-export-chat.md", line: 3 },
    });
    expect(f.considered).toEqual([
      { item: "sso-intake", why: "The change adds no new web application." },
    ]);
    const md = readFileSync(join(dir, "needs.md"), "utf8");
    expect(md).toContain("## Requests and processes to raise");
    expect(md).toContain(
      "- [ ] **Kafka topic** (story s1-export-chat): raise CTASK: Kafka topic with the Messaging team, 5 working days",
    );
    expect(md).toContain("1. Open the platform catalogue");
    expect(md).toContain(
      "Links: [service desk catalogue](https://servicedesk.example.com/kafka-topic)",
    );
    expect(f.needs[1]!.urls).toEqual([
      { label: "service desk catalogue", url: "https://servicedesk.example.com/kafka-topic" },
    ]);
    expect(md).toContain("## Standards and patterns to follow");
  });

  it("hands back a need that cites no item, a target the change hasn't, or words the file hasn't", async () => {
    const { root } = await metarepo();
    const prompts: string[] = [];
    const BAD = `needs:
  - { item: firewall-rule, for: change, why: x, because: { file: brief.md, quote: "A member downloads the chat as a file." } }
  - { item: kafka-topic-request, for: story:s9-nope, why: x, because: { file: brief.md, quote: "A member downloads the chat as a file." } }
  - { item: sso-intake, for: change, why: x, because: { file: brief.md, quote: "The member signs in with SSO." } }
`;
    const r = await findNeeds(root, CHANGE, {
      runtime: run((q) => {
        prompts.push(q.pack.prompt);
        return prompts.length === 1 ? BAD : GOOD;
      }),
      now: NOW,
    });
    expect(r.status).toBe("done");
    expect(r.attempts[0]!.problems).toEqual([
      "firewall-rule isn't a knowledge item (or a person rejected it)",
      "kafka-topic-request is for story:s9-nope, which isn't in the change; it has change, feature:feature.chats, flow:chat-api.open-chat, story:s1-export-chat, task:1.1",
      'sso-intake quotes brief.md, but "The member signs in with SSO." isn\'t in it',
    ]);
    expect(prompts[1]).toContain("failed these checks");
  });

  it("keeps what a person did with a need when it runs again", async () => {
    const { root } = await metarepo();
    await findNeeds(root, CHANGE, { runtime: run(GOOD), now: NOW });
    const m = await markNeed(root, CHANGE, "kafka-topic-request", {
      status: "done",
      by: "Tom George",
      at: "2026-10-23T09:00:00Z",
      note: "CTASK0012345",
    });
    expect("error" in m).toBe(false);
    // Asked again, the assistant no longer lists json-logging and still lists the Kafka topic.
    await findNeeds(root, CHANGE, {
      runtime: run(GOOD.replace(/ {2}- item: json-logging[\s\S]*?(?=not_needed)/, "")),
      now: NOW,
    });
    const f = (await readNeeds(root, CHANGE))!;
    expect(f.needs.map((n) => [n.item, n.status, n.note])).toEqual([
      ["kafka-topic-request", "done", "CTASK0012345"],
    ]);
    expect(f.needs[0]).toMatchObject({ by: "Tom George", at: "2026-10-23T09:00:00Z" });
  });

  it("asks why a need isn't needed, and says which need there is none of", async () => {
    const { root } = await metarepo();
    await findNeeds(root, CHANGE, { runtime: run(GOOD), now: NOW });
    const at = "2026-10-23T09:00:00Z";
    expect(
      await markNeed(root, CHANGE, "json-logging", { status: "not-needed", by: "T", at }),
    ).toMatchObject({
      error: expect.stringContaining("Say why"),
    });
    expect(await markNeed(root, CHANGE, "nope", { status: "done", by: "T", at })).toMatchObject({
      error: expect.stringContaining("no need nope"),
    });
  });

  it("takes in the requests the stories stage suggested, beside the assistant's", async () => {
    const { root } = await metarepo();
    await findNeeds(root, CHANGE, { runtime: run(GOOD), now: NOW });
    await mergeStoryRequests(
      root,
      CHANGE,
      [
        {
          id: "R1",
          item: "sso-intake",
          title: "SSO intake",
          processKind: "request",
          flow: "chat-api.open-chat",
          step: 2,
          stepWhat: "sign in",
          why: 'The step meets "A new web application needs single sign-on."',
          by: "match",
          quote: SSO.kind === "ProcessDefinition" ? SSO.quote : (undefined as never),
          leadTime: "10 working days",
          handledBy: "Identity team",
        },
      ],
      NOW,
    );
    const f = (await readNeeds(root, CHANGE))!;
    expect(f.needs.find((n) => n.item === "sso-intake")).toMatchObject({
      for: "flow:chat-api.open-chat",
      from: "stories",
      status: "open",
      leadTime: "10 working days",
    });
    expect(f.needs.filter((n) => n.from === "assistant")).toHaveLength(2);
  });

  it("marks a need whose item a person verified with a green tick", async () => {
    const { root, dir } = await metarepo();
    const k = (await readKnowledge(root)).items.find((i) => i.id === "kafka-topic-request")!;
    const v = reviewItem(k, { verdict: "verified", by: "Tom George", at: "2026-10-21T09:00:00Z" });
    if ("error" in v) throw new Error(v.error);
    await writeReview(root, v.review);
    await findNeeds(root, CHANGE, { runtime: run(GOOD), now: NOW });
    expect(readFileSync(join(dir, "needs.md"), "utf8")).toMatch(
      /Kafka topic.*✓ verified by Tom George/,
    );
  });
});
