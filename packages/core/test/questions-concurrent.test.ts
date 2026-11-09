import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import * as realFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  answerQuestion,
  FileChangedError,
  questionsDirOf,
  raiseQuestions,
  reopenQuestion,
  retireQuestion,
} from "../src/index.js";

/**
 * Review round 46 (storage): a question's file changed between being read and being written back
 * (a person answered it in the app while the AI's batch, or another command, worked from the old
 * text) is never overwritten: the write is refused, and the person's edit stands.
 */

// The next read of `armed` returns the file as it was, then a person's edit lands on disk.
const hook = vi.hoisted(() => ({ armed: undefined as string | undefined }));
const EDIT = "\n# a person's edit, saved meanwhile\n";

vi.mock("node:fs/promises", async (orig) => {
  const m = await orig<typeof import("node:fs/promises")>();
  return {
    ...m,
    readFile: async (...a: Parameters<typeof m.readFile>) => {
      const text = await m.readFile(...a);
      if (hook.armed && String(a[0]) === hook.armed) {
        hook.armed = undefined;
        writeFileSync(String(a[0]), `${String(text)}${EDIT}`);
      }
      return text;
    },
  };
});

const AT = "2026-11-08T12:00:00.000Z";
const draft = {
  question: "Is /notes-api the path every entry point is served under?",
  options: [
    { label: "Yes, every entry point", means: "the whole service", changes: "prefix all" },
    { label: "No, only the public ones", means: "internal at root", changes: "leave internal" },
  ],
  evidence: ["src/main/resources/application.properties:3"],
  scope: "repo" as const,
};
const asked = {
  step: "scan-survey",
  repo: "forge-notes",
  command: "atticus scan survey forge-notes",
  rerun: "atticus scan survey forge-notes --force",
  at: AT,
};

async function withQuestion() {
  const root = await mkdtemp(join(tmpdir(), "atticus-q-race-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  const q = (await raiseQuestions(root, [draft], asked)).raised[0]!;
  const file = join(questionsDirOf(root), `${q.id}.yaml`);
  return { root, q, file };
}

const text = (f: string) => realFs.readFile(f, "utf8");

describe("a question changed meanwhile is never overwritten", () => {
  it("answer: refused with FileChangedError, the person's edit stands", async () => {
    const { root, q, file } = await withQuestion();
    hook.armed = file;
    await expect(
      answerQuestion(root, q.id, { option: 1, by: "sam", at: AT }),
    ).rejects.toBeInstanceOf(FileChangedError);
    expect(await text(file)).toContain(EDIT.trim());
    expect(await text(file)).not.toContain("by: sam");
  });

  it("retire and reopen: refused the same way", async () => {
    const { root, q, file } = await withQuestion();
    hook.armed = file;
    await expect(retireQuestion(root, q.id, { why: "asked again", at: AT })).rejects.toBeInstanceOf(
      FileChangedError,
    );
    expect(await text(file)).toContain(EDIT.trim());
    expect(await text(file)).not.toContain("state: retired");

    await answerQuestion(root, q.id, { option: 1, by: "pat", at: AT });
    hook.armed = file;
    await expect(
      reopenQuestion(root, q.id, { why: "the code disagrees", at: AT }),
    ).rejects.toBeInstanceOf(FileChangedError);
    expect(await text(file)).toContain("state: answered");
  });

  // Review round 48: another step asking the same question adds itself to alsoAskedBy from the
  // file as it is when it writes, never from the list it read at the start.
  const again = {
    ...draft,
    question: "Is every entry point served under /notes-api, or only some?",
  };
  const other = { ...asked, step: "scan-routes", command: "atticus scan routes forge-notes" };
  const same: NonNullable<Parameters<typeof raiseQuestions>[3]>["judge"] = async (pairs) =>
    new Map(pairs.map((p) => [p.key, "same" as const]));

  it("alsoAskedBy: added to the question as answered meanwhile, the answer kept", async () => {
    const { root, q, file } = await withQuestion();
    const r = await raiseQuestions(root, [again], other, {
      judge: async (pairs) => {
        // A person answers it in the app while the judge weighs the pair.
        await answerQuestion(root, q.id, { option: 1, by: "sam", at: AT });
        return same(pairs);
      },
    });
    expect(r.reused.map((x) => x.id)).toEqual([q.id]);
    const now = await text(file);
    expect(now).toContain("state: answered");
    expect(now).toContain("by: sam");
    expect(now).toContain("step: scan-routes");
  });

  it("alsoAskedBy: skipped when the file changes between its read and its write", async () => {
    const { root, q, file } = await withQuestion();
    const r = await raiseQuestions(root, [again], other, {
      judge: async (pairs) => {
        hook.armed = file;
        return same(pairs);
      },
    });
    expect(r.of[0]?.id).toBe(q.id);
    expect(await text(file)).toContain(EDIT.trim());
    expect(await text(file)).not.toContain("step: scan-routes");
  });

  it("a refresh: skipped, the question as it is on file now", async () => {
    const { root, q, file } = await withQuestion();
    const newer = {
      ...draft,
      options: [{ label: "Yes", means: "the config says so", changes: "All" }, draft.options[1]!],
    };
    hook.armed = file;
    const r = await raiseQuestions(
      root,
      [newer],
      { ...asked, at: "2026-11-08T13:00:00.000Z" },
      {
        refresh: true,
      },
    );
    expect(r.refreshed).toEqual([]);
    expect(r.of[0]?.id).toBe(q.id);
    expect(await text(file)).toContain(EDIT.trim());
    expect(await text(file)).toContain("Yes, every entry point");
  });
});
