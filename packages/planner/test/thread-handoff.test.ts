import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { HandoffRuntime, HeadlessClaudeCodeRuntime } from "@maycombhq/ai";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import {
  PlannerError,
  droppedQuestion,
  featureStage,
  keepDroppedQuestion,
  readStageLoop,
  replyInStage,
  threadReplies,
  writeStageLoop,
} from "../src/index.js";

/**
 * ADR 0189, review of beta.23: a stage's thread while its hand-off waits or its run is under way,
 * on the invented Forge estate ("pin an order note"). A reply sent while the prompt waits isn't
 * in that prompt, so it is read by the next round, never marked read unseen; a run's own writes of
 * its loop file keep what the thread added meanwhile; and a run already read in isn't read in
 * again.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "../../../fixtures/stages");
const PIN = join(FIX, "pin-note");
const NOW = new Date("2026-10-24T09:00:00Z");
const CHANGE = "pin-order-note";
const LATER = "2026-10-24T12:00:00Z";
const REPLY = "Pin only the newest note a shopper typed.";

const NO_EXPANSION = `schemaVersion: 1
assistants: { allowed: [copilot], default: copilot }
retrieval: { expansion: false }
`;

async function estateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-thread-handoff-"));
  await mkdir(join(root, "org-pack/checklists"), { recursive: true });
  await writeFile(join(root, "org-pack/runtime.yaml"), NO_EXPANSION);
  await cp(
    join(PIN, "checklists/pin-review.yaml"),
    join(root, "org-pack/checklists/pin-review.yaml"),
  );
  const rows = [
    ...(parse(readFileSync(join(FIX, "../specs/catalog.yaml"), "utf8")) as unknown[]),
    ...(parse(readFileSync(join(FIX, "catalog-extra.yaml"), "utf8")) as unknown[]),
  ];
  for (const r of rows) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(`bad fixture record: ${JSON.stringify(p.issues)}`);
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(join(FIX, "specs"), join(root, "specs"), { recursive: true });
  await cp(join(PIN, CHANGE), join(root, "openspec/changes", CHANGE), { recursive: true });
  return root;
}

const SETTLED = `summary: A shopper pins one note to the top of an order's notes, and can unpin it.
features:
  - id: cap-ordering
    why: An order's notes belong to ordering.
flows:
  - id: forge-orders.place-order
    how: read
    why: A note is pinned on an order that was placed.
newFlows:
  - name: pin an order note
    repo: forge-orders
    why: Nothing pins a note today.
gaps:
  - what: Orders keep no notes today.
    why: A pinned note needs notes on the order.
questions: []
`;

/** The drafter settles; every lens and other prompt finds nothing. */
const respond = (prompt: string) =>
  prompt.includes("# Feature placer") ? SETTLED : "findings: []\n";

const dir = (root: string) => join(root, "openspec/changes", CHANGE);

function handoff(root: string) {
  let t = NOW.getTime();
  const tick = () => new Date((t += 5000));
  const rt = () => new HandoffRuntime({ root, validate: async () => [], now: tick });
  const step = (resume?: string) =>
    featureStage(root, CHANGE, { runtime: rt(), now: tick(), ...(resume ? { resume } : {}) });
  const prompt = (run: string) => readFile(join(root, ".runs", CHANGE, run, "prompt.md"), "utf8");
  /** Answer the run as the assistant would, check it and read it in. */
  const answer = async (run: string) => {
    const p = await prompt(run);
    const file = /Write the result to (\S+?\.yaml)\./.exec(p)![1]!;
    await writeFile(join(root, ...file.split("/")), respond(p));
    await rt().done(run);
    return step(run);
  };
  return { step, prompt, answer };
}

describe("a reply sent while a stage's hand-off prompt waits", () => {
  it("isn't marked read when that prompt is read in, and goes into the next round's prompt", async () => {
    const root = await estateRoot();
    const h = handoff(root);
    let r = await h.step();
    expect(r.state).toBe("waiting");
    const first = r.waiting!.runId;
    expect(await h.prompt(first)).not.toContain(REPLY);
    const reply = await replyInStage(root, {
      change: CHANGE,
      stage: "feature",
      text: REPLY,
      by: "priya.nair",
      at: LATER,
    });
    r = await h.answer(first);
    while (r.state === "waiting") r = await h.answer(r.waiting!.runId);
    // The prompt read in never carried the reply: it is still unread.
    expect(await threadReplies(root, CHANGE, "feature")).toMatchObject([
      { question: reply.question.id, read: false },
    ]);
    const { loop } = await readStageLoop(dir(root), CHANGE, "feature");
    expect(loop.read).not.toContain(reply.question.id);
    // The next round drafts again with it.
    r = await h.step();
    expect(r.state).toBe("waiting");
    expect(await h.prompt(r.waiting!.runId)).toContain(REPLY);
    r = await h.answer(r.waiting!.runId);
    while (r.state === "waiting") r = await h.answer(r.waiting!.runId);
    expect((await threadReplies(root, CHANGE, "feature"))[0]!.read).toBe(true);
  });
});

describe("a resume of a run the stage isn't waiting on", () => {
  it("is refused, and the run is never read in twice", async () => {
    const root = await estateRoot();
    const h = handoff(root);
    const r = await h.step();
    const first = r.waiting!.runId;
    let done = await h.answer(first);
    while (done.state === "waiting") done = await h.answer(done.waiting!.runId);
    const before = (await readStageLoop(dir(root), CHANGE, "feature")).loop;
    const e = await h.step(first).then(
      () => undefined,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(PlannerError);
    expect((e as PlannerError).code).toBe("refused");
    expect((e as Error).message).toContain(`isn't a draft or a lens of ${CHANGE}'s feature stage`);
    expect((e as Error).message).toContain("read in already");
    const after = (await readStageLoop(dir(root), CHANGE, "feature")).loop;
    expect(after.iteration).toBe(before.iteration);
    expect(after.state).toBe(before.state);
  });
});

describe("the thread, while a stage's run is under way", () => {
  it("keeps a reply posted and a dropped question kept during the run: the run's writes don't drop them", async () => {
    const root = await estateRoot();
    // The stage has run once and keeps a question it couldn't keep.
    const brief = `openspec/changes/${CHANGE}/brief.md`;
    const d = await droppedQuestion(
      root,
      "How long may a pinned note be?",
      [`${brief}:99`],
      1,
      LATER,
    );
    const { loop } = await readStageLoop(dir(root), CHANGE, "feature");
    await writeStageLoop(dir(root), { ...loop, updatedAt: LATER, dropped: [d] });
    let posted: string | undefined;
    let kept: string | undefined;
    const rt = new HeadlessClaudeCodeRuntime({
      root,
      now: () => NOW,
      runner: async (i) => {
        // While the drafter works, the person replies and keeps the dropped question.
        if (!posted) {
          posted = (
            await replyInStage(root, {
              change: CHANGE,
              stage: "feature",
              text: REPLY,
              by: "priya.nair",
              at: LATER,
            })
          ).question.id;
          kept = (
            await keepDroppedQuestion(root, {
              change: CHANGE,
              stage: "feature",
              key: d.key,
              by: "priya.nair",
              at: LATER,
            })
          ).question.id;
        }
        const file = /Write the result to (\S+?\.yaml)\./.exec(i.prompt)![1]!;
        await writeFile(join(i.cwd, ...file.split("/")), respond(i.prompt));
        return {
          exitCode: 0,
          stdout: JSON.stringify({ result: "Wrote it", is_error: false }),
          stderr: "",
        };
      },
      invocation: () => ({ cwd: root }),
    });
    await featureStage(root, CHANGE, { runtime: rt, now: NOW });
    expect(posted && kept).toBeTruthy();
    const after = (await readStageLoop(dir(root), CHANGE, "feature")).loop;
    expect(after.questions).toContain(posted);
    expect(after.questions).toContain(kept);
    // The kept question doesn't come back to the dropped list.
    expect((after.dropped ?? []).map((x) => x.key)).not.toContain(d.key);
    expect((await threadReplies(root, CHANGE, "feature")).map((x) => x.text)).toEqual([REPLY]);
  });
});

describe("a reply sent twice", () => {
  it("is kept once when the same person sends the same words within a few seconds", async () => {
    const root = await estateRoot();
    const { loop } = await readStageLoop(dir(root), CHANGE, "feature");
    await writeStageLoop(dir(root), { ...loop, iteration: 1, updatedAt: LATER });
    const send = (at: string, by = "priya.nair", text = REPLY) =>
      replyInStage(root, { change: CHANGE, stage: "feature", text, by, at });
    const a = await send("2026-10-24T12:00:00Z");
    const b = await send("2026-10-24T12:00:02Z");
    expect(b.question.id).toBe(a.question.id);
    expect(await threadReplies(root, CHANGE, "feature")).toHaveLength(1);
    // Later, or by someone else, or other words: a reply of its own.
    await send("2026-10-24T12:01:00Z");
    await send("2026-10-24T12:00:03Z", "sam.okafor");
    await send("2026-10-24T12:00:04Z", "priya.nair", "Pin two notes.");
    expect(await threadReplies(root, CHANGE, "feature")).toHaveLength(4);
  });

  it("for the proposal too", async () => {
    const root = await estateRoot();
    const send = (at: string) =>
      replyInStage(root, { change: CHANGE, stage: "proposal", text: REPLY, by: "priya.nair", at });
    const a = await send("2026-10-24T12:00:00Z");
    const b = await send("2026-10-24T12:00:01Z");
    expect(b.question.id).toBe(a.question.id);
    expect(await threadReplies(root, CHANGE, "proposal")).toHaveLength(1);
  });
});
