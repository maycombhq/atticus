import { writeFileSync } from "node:fs";
import * as realFs from "node:fs/promises";
import { cp, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { describe, expect, it, vi } from "vitest";
import { Question, questionsDirOf, readQuestion, writeQuestion } from "@maycombhq/core";
import { decideAnswers } from "../src/ai-decide.js";

/**
 * Review round 46 (storage): a person answers a question in the app while the AI's batch is
 * answering it from the file as it read it. The person's answer stands; the batch skips that
 * question ("a person changed it") and goes on with the rest, never a crash. On the invented
 * Forge estate of fixtures/prototype-compare; nothing leaves the machine.
 */

// answerQuestion's read of `armed` returns the file as it was, then `edit` lands on disk.
const hook = vi.hoisted(() => ({ armed: undefined as string | undefined, edit: "" }));

vi.mock("node:fs/promises", async (orig) => {
  const m = await orig<typeof import("node:fs/promises")>();
  return {
    ...m,
    readFile: async (...a: Parameters<typeof m.readFile>) => {
      const by = new Error().stack ?? "";
      const text = await m.readFile(...a);
      if (hook.armed && String(a[0]) === hook.armed && by.includes("answerQuestion")) {
        hook.armed = undefined;
        writeFileSync(String(a[0]), hook.edit);
      }
      return text;
    },
  };
});

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const FX = join(HERE, "../../../fixtures/prototype-compare");
const GW = "forge-partner-gateway";
const FILE = "src/main/java/forge/billing/PartnerClient.java";
const AT = new Date("2026-11-08T10:15:00.000Z");
const SOURCE = Array.from({ length: 45 }, (_, i) => {
  const n = i + 1;
  if (n === 40) return '    post("/charges/" + id + "/capture", body);';
  if (n === 41) return '    post("/charges/" + id + "/refunds", body);';
  return n === 1 ? "package forge.billing;" : `    // line ${n}`;
}).join("\n");

const call = (id: string, path: string, line: number) =>
  JSON.stringify({
    kind: "call",
    id,
    repo: "forge-billing",
    commit: "aaa1111",
    callType: "rest",
    method: "POST",
    path,
    cite: { file: FILE, line, value: path },
    verified: "line",
    by: "assistant",
    conf: "declared",
  });

const targetsQuestion = (id: string, line: number) =>
  Question.parse({
    schemaVersion: 5,
    id,
    askedBy: {
      step: "facts-targets",
      command: "atticus verify forge-billing --write",
      at: "2026-11-08T08:00:00Z",
    },
    repo: "forge-billing",
    question: `Where does forge-billing's call on line ${line} go?`,
    options: [
      { label: "forge-shop-bff", means: "forge-shop-bff: a path like it", changes: "joins it" },
      { label: GW, means: `${GW}: the same path under /partners/northwind`, changes: "joins it" },
      { label: "Another repo…", means: "A repo not listed", changes: "Nothing until you name one" },
      { label: "None of these", means: "Nothing answers it", changes: "The call stays loose" },
    ],
    evidence: [`${FILE}:${line}`],
    scope: { level: "repo", id: "forge-billing" },
    state: "open",
    rerun: "atticus verify forge-billing --write",
  });

const QA = "q-aaaaaaaaaaa1";
const QB = "q-bbbbbbbbbbb2";

async function estate(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-decide-race-"));
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  await realFs.writeFile(join(root, "org-pack/sources.yaml"), "schemaVersion: 1\nwikis: []\n");
  await realFs.writeFile(
    join(root, "org-pack/runtime.yaml"),
    [
      "schemaVersion: 4",
      "assistants: { allowed: [copilot], default: copilot }",
      "modes: { allowed: [hand-off, copilot-acp], default: hand-off }",
      "decide: { links: auto, questions: auto }",
      "",
    ].join("\n"),
  );
  await cp(join(FX, "org-pack/profiles/forge"), join(root, "org-pack/profiles/forge"), {
    recursive: true,
  });
  for (const d of ["inputs", "facts"]) await cp(join(FX, d), join(root, d), { recursive: true });
  await realFs.appendFile(
    join(root, "facts/forge-billing.jsonl"),
    [
      call("call.post.charges-capture", "/charges/{id}/capture", 40),
      call("call.post.charges-refunds", "/charges/{id}/refunds", 41),
      "",
    ].join("\n"),
  );
  await mkdir(join(root, "workspace/forge-billing", dirname(FILE)), { recursive: true });
  await realFs.writeFile(join(root, "workspace/forge-billing", FILE), SOURCE);
  await mkdir(join(root, "proposals/questions"), { recursive: true });
  for (const [id, line] of [
    [QA, 40],
    [QB, 41],
  ] as const) {
    await writeQuestion(root, targetsQuestion(id, line));
    await realFs.writeFile(
      join(root, `proposals/questions/${id}.yaml`),
      stringify({
        schemaVersion: 1,
        answer: { option: 1 },
        why: "The client posts to it.",
        cites: [{ file: FILE, line, quote: SOURCE.split("\n")[line - 1]!.trim() }],
        by: "copilot",
        at: "2026-11-08T10:00:00.000Z",
      }),
    );
  }
  return root;
}

describe("the AI's batch meets a person's answer given meanwhile", () => {
  it("leaves the person's answer, skips that question, and answers the rest", async () => {
    const root = await estate();
    const person = Question.parse({
      ...targetsQuestion(QA, 40),
      state: "answered",
      answer: {
        option: 2,
        by: "pat",
        at: "2026-11-08T10:14:00.000Z",
        scope: { level: "repo", id: "forge-billing" },
      },
    });
    // answerQuestion reads the question, and the person's answer lands before it writes.
    hook.armed = join(questionsDirOf(root), `${QA}.yaml`);
    hook.edit = stringify(person);
    const d = await decideAnswers(root, { run: "r2", now: AT });
    expect(hook.armed).toBeUndefined();
    expect(d?.applied.map((a) => a.id)).toEqual([QB]);
    expect(d?.kept).toEqual([{ id: QA, why: expect.stringMatching(/a person changed it/) }]);
    const q = (await readQuestion(root, QA))!;
    expect(q.answer).toMatchObject({ option: 2, by: "pat" });
    expect((await readQuestion(root, QB))!.state).toBe("answered");
  });
});
