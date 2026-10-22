import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { needsCli } from "../src/needs-commands.js";

/** ADR 0101: atticus needs, needs done and needs skip, over a change's needs.yaml. */

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

const NEEDS = `schemaVersion: 1
change: add-chat-export
updatedAt: 2026-10-22T09:00:00Z
needs:
  - item: kafka-topic-request
    kind: request
    title: Kafka topic
    for: story:s1-export-chat
    why: The story publishes on a new topic.
    from: assistant
    leadTime: 5 working days
    handledBy: Messaging team
    status: open
  - item: sso-intake
    kind: request
    title: SSO intake
    for: change
    why: A new web app.
    from: stories
    leadTime: 10 working days
    handledBy: Identity team
    status: open
`;

async function metarepo() {
  const root = await mkdtemp(join(tmpdir(), "atticus-needs-cli-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  await writeFile(join(root, "org-pack", "sources.yaml"), "schemaVersion: 1\n");
  const dir = join(root, "openspec", "changes", "add-chat-export");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "needs.yaml"), NEEDS);
  return { root, dir };
}

const run = (root: string, args: string[], values: Record<string, unknown> = {}) => {
  const c = capture();
  return needsCli(root, args, values, c.io, () => "tom", {
    now: new Date("2026-10-23T09:00:00Z"),
  }).then((code) => ({ code, ...c }));
};

describe("atticus needs", () => {
  it("lists the open needs across changes, with lead time and who handles each", async () => {
    const { root } = await metarepo();
    const r = await run(root, ["needs"]);
    expect(r.code).toBe(0);
    expect(r.out[0]).toMatch(/^CHANGE\s+NEED\s+KIND\s+FOR\s+LEAD TIME\s+HANDLED BY\s+STATE$/);
    expect(r.out.join("\n")).toMatch(
      /kafka-topic-request\s+request\s+story s1-export-chat\s+5 working days\s+Messaging team\s+open/,
    );
  });

  it("records a need done with its ticket, and one not needed with why", async () => {
    const { root, dir } = await metarepo();
    const done = await run(root, ["needs", "done", "add-chat-export", "kafka-topic-request"], {
      note: "CTASK0012345",
    });
    expect(done.code).toBe(0);
    expect(done.out[0]).toBe(
      "Kafka topic (story s1-export-chat) is done for add-chat-export, by tom. Commit openspec/changes/add-chat-export/needs.yaml with the change.",
    );
    const noWhy = await run(root, ["needs", "skip", "add-chat-export", "sso-intake"]);
    expect(noWhy.code).toBe(2);
    expect(noWhy.err[0]).toMatch(/Say why/);
    const skip = await run(root, ["needs", "skip", "add-chat-export", "sso-intake"], {
      note: "The platform sets SSO up now.",
    });
    expect(skip.code).toBe(0);
    expect(readFileSync(join(dir, "needs.md"), "utf8")).toContain("~~SSO intake~~");
    const open = await run(root, ["needs"]);
    expect(open.out).toEqual(["No change has an open need."]);
    const all = await run(root, ["needs"], { all: true, json: true });
    expect((JSON.parse(all.out.join("\n")) as { status: string }[]).map((n) => n.status)).toEqual([
      "done",
      "not-needed",
    ]);
  });
});
