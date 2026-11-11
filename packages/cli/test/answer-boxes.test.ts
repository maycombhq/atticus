import { appendFile, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  answerQuestion,
  HOSTS_OUTSIDE_VENDOR,
  HOSTS_STEP,
  IGNORE_REASON_MAX,
  ignoredAnswer,
  raiseQuestions,
  readQuestion,
  TARGETS_STEP_ID,
  writeQuestion,
  type Question,
} from "@maycombhq/core";

/**
 * Beta.25 (review of beta.24): a box on Map › Trust is only what a person's own words made, never
 * a system judged by the shape of its id; a fix writes all or none, only over the files its
 * preview was made from; a rename names something real. On the invented bank-shaped estate
 * (fixtures/link-estate); files only, no network.
 */

// The write a test makes fail: the profile's, after the answers are written. `race` is another
// writer (an answer in the CLI, which takes no lock) changing files just before it: the profile
// (so the fix's write of it fails), or a question file the fix has written already.
// `afterAnswer` runs once just after an answer is written (its question file on disk): it can
// throw, as answerQuestion does when its skill file's write fails (EPERM, EBUSY, ENOSPC), or be a
// person's change to the file before the fix reads anything back.
const failing = vi.hoisted(() => ({
  profile: false,
  race: undefined as undefined | { file: string; add: string }[],
  afterAnswer: undefined as undefined | ((root: string, id: string) => Promise<void>),
}));
vi.mock("@maycombhq/core", async (orig) => {
  const m = await orig<typeof import("@maycombhq/core")>();
  const { appendFile } = await import("node:fs/promises");
  return {
    ...m,
    answerQuestion: async (...args: Parameters<typeof m.answerQuestion>) => {
      const r = await m.answerQuestion(...args);
      const after = failing.afterAnswer;
      failing.afterAnswer = undefined;
      if (after) await after(args[0], args[1]);
      return r;
    },
    writeFileIfUnchanged: async (path: string, before: string | undefined, data: string) => {
      if (failing.race && path.endsWith("profile.yaml")) {
        const race = failing.race;
        failing.race = undefined;
        for (const r of race) await appendFile(r.file, r.add);
      }
      if (failing.profile && path.endsWith("profile.yaml")) throw new m.FileChangedError(path);
      return m.writeFileIfUnchanged(path, before, data);
    },
  };
});
const { answerBoxesOf, AnswerBoxError, ignoreAnswerBox, renameAnswerBox } =
  await import("../src/answer-boxes.js");

const ESTATE = join(__dirname, "..", "..", "..", "fixtures", "link-estate");
const AT = "2026-11-10T12:00:00.000Z";
const PROFILE = ["org-pack", "profiles", "forge", "profile.yaml"];
const CICD = "ignore-this-its-cicd-related";
const CICD_WORDS = "ignore this, its cicd related";

const temps: string[] = [];
afterAll(async () => {
  for (const d of temps) await rm(d, { recursive: true, force: true });
});

async function metarepo(systems: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), "atticus-boxes-"));
  temps.push(root);
  await cp(join(ESTATE, "org-pack"), join(root, "org-pack"), { recursive: true });
  const f = join(root, ...PROFILE);
  await writeFile(
    f,
    (await readFile(f, "utf8")).replace(
      "environments:",
      `${systems.map((s) => `  - ${s}\n`).join("")}environments:`,
    ),
  );
  return root;
}

const by = (step: string) => ({
  step,
  repo: "forge-payments",
  command: "atticus verify forge-payments --write",
  rerun: "atticus verify forge-payments --write",
  at: AT,
});

const targets = (path: string, line: number) => ({
  question: `Which repo or system answers POST ${path}, which payments-api calls?`,
  options: [
    { label: "forge-cards", means: "it serves it", changes: "joins it" },
    { label: "None of these", means: "nothing", changes: "a loose end" },
  ],
  evidence: [`src/main/java/forge/payments/HooksClient.java:${line}`],
  scope: "repo" as const,
});

/** As the app wrote an answer before beta.24: the words, on file. */
async function answeredWith(root: string, d: ReturnType<typeof targets>, text: string) {
  const q = (await raiseQuestions(root, [d], by(TARGETS_STEP_ID))).raised[0]!;
  const a: Question = {
    ...q,
    state: "answered",
    answer: { text, by: "pat", at: AT, scope: { level: "repo", id: q.repo } },
  };
  await writeQuestion(root, a);
  return a;
}

const CICD_SYSTEM = `{ id: ${CICD}, name: "${CICD_WORDS}", boundary: vendor, aliases: [] }`;

describe("what is a box (beta.25)", () => {
  it("never offers a vendor a hosts answer added, however long its host", async () => {
    const root = await metarepo();
    const host = "api.payments.northwind.example.com";
    const d = {
      question: `Which repo answers on ${host}?`,
      options: [
        { label: "forge-cards", means: "m", changes: "c" },
        { label: HOSTS_OUTSIDE_VENDOR, means: "m", changes: "c" },
        { label: "None of these", means: "m", changes: "c" },
      ],
      evidence: ["src/main/java/forge/payments/VendorClient.java:12"],
      scope: "repo" as const,
    };
    const q = (await raiseQuestions(root, [d], by(HOSTS_STEP))).raised[0]!;
    await answerQuestion(root, q.id, { option: 2, by: "pat", at: AT });
    expect(await readFile(join(root, ...PROFILE), "utf8")).toContain(host);
    expect(await answerBoxesOf(root)).toEqual([]);
    await expect(
      ignoreAnswerBox(root, "api-payments-northwind-example-com", { by: "pat", at: AT }),
    ).rejects.toMatchObject({ code: "not-found" });
    expect(await readFile(join(root, ...PROFILE), "utf8")).toContain(host);
  });

  it("never offers a named system, whatever its id looks like", async () => {
    const root = await metarepo([
      "{ id: forge-it-service-desk, name: Forge IT Service Desk, boundary: internal, aliases: [] }",
      "{ id: plan-a, name: Plan A, boundary: internal, aliases: [] }",
      "{ id: to-do, name: To Do, boundary: internal, aliases: [] }",
      "{ id: payments-api-gateway-north-east, name: Payments API Gateway North East, boundary: internal, aliases: [] }",
    ]);
    let n = 10;
    for (const t of ["forge-it-service-desk", "plan-a", "To Do", "payments-api-gateway-north-east"])
      await answeredWith(root, targets(`/p${n}`, n++), t);
    expect(await answerBoxesOf(root)).toEqual([]);
  });

  it("offers what a person's words made: the picker's system named by them, or words alone", async () => {
    const root = await metarepo([CICD_SYSTEM]);
    const a = await answeredWith(root, targets("/build/hooks", 12), CICD);
    const b = await answeredWith(root, targets("/hooks", 20), "this is a proxy to merchants");
    const boxes = await answerBoxesOf(root);
    expect(boxes.map((x) => [x.id, x.profile, x.questions.map((q) => q.id)])).toEqual([
      [CICD, "org-pack/profiles/forge/profile.yaml", [a.id]],
      ["this-is-a-proxy-to-merchants", undefined, [b.id]],
    ]);
  });

  it("never offers a real system whose name has a mark in it (beta.25)", async () => {
    const root = await metarepo([
      '{ id: northwind-inc, name: "Northwind, Inc.", boundary: vendor, aliases: [] }',
      '{ id: harbor-co, name: "Harbor Co.", boundary: vendor, aliases: [] }',
      '{ id: lantern-bang, name: "Lantern!", boundary: vendor, aliases: [] }',
    ]);
    // The picker's answers (the ids), and the names typed.
    let n = 30;
    for (const t of ["northwind-inc", "lantern-bang", "Harbor Co.", "Northwind, Inc."])
      await answeredWith(root, targets(`/m${n}`, n++), t);
    expect(await answerBoxesOf(root)).toEqual([]);
    const f = join(root, ...PROFILE);
    const before = await readFile(f, "utf8");
    await expect(
      ignoreAnswerBox(root, "northwind-inc", { by: "pat", at: AT, preview: true }),
    ).rejects.toMatchObject({ code: "not-found" });
    expect(await readFile(f, "utf8")).toBe(before);
  });

  it("offers a system a topics answer made from a sentence (beta.25)", async () => {
    // A topics answer writes the system it names with the topic under its topics.
    const root = await metarepo();
    const f = join(root, ...PROFILE);
    await writeFile(
      f,
      (await readFile(f, "utf8"))
        .replace("schemaVersion: 1", "schemaVersion: 2")
        .replace(
          "environments:",
          `  - { id: ${CICD}, name: "${CICD_WORDS}", boundary: vendor, aliases: [], topics: [forge.cicd.events] }\nenvironments:`,
        ),
    );
    const a = await answeredWith(root, targets("/topic", 40), CICD);
    expect((await answerBoxesOf(root)).map((b) => [b.id, b.profile, b.questions[0]?.id])).toEqual([
      [CICD, "org-pack/profiles/forge/profile.yaml", a.id],
    ]);
  });

  it("keeps an Ignore's reason within the longest the API takes", async () => {
    const long = `this is ${"a very long reason ".repeat(30)}`.trim();
    const root = await metarepo();
    const a = await answeredWith(root, targets("/long", 50), long);
    const id = (await answerBoxesOf(root))[0]!.id;
    await ignoreAnswerBox(root, id, { by: "pat", at: AT });
    const reason = ignoredAnswer((await readQuestion(root, a.id))!)?.reason ?? "";
    expect(reason.length).toBeLessThanOrEqual(IGNORE_REASON_MAX);
    expect(reason).toMatch(/^It was 'ignore this'/);
  });
});

describe("a fix writes all or none (beta.25)", () => {
  it("puts the answers back when the profile can't be written", async () => {
    const root = await metarepo([CICD_SYSTEM]);
    const a = await answeredWith(root, targets("/build/hooks", 12), CICD);
    const qBefore = await readFile(join(root, "questions", `${a.id}.yaml`), "utf8");
    const pBefore = await readFile(join(root, ...PROFILE), "utf8");
    failing.profile = true;
    try {
      const err = await ignoreAnswerBox(root, CICD, { by: "pat", at: AT }).catch((e: Error) => e);
      expect(err).toBeInstanceOf(AnswerBoxError);
      expect(err).toMatchObject({ code: "changed" });
      expect((err as Error).message).toMatch(/nothing of the fix was written.*put back/);
      expect((err as Error).message).not.toMatch(/someone else/);
    } finally {
      failing.profile = false;
    }
    expect(await readFile(join(root, "questions", `${a.id}.yaml`), "utf8")).toBe(qBefore);
    expect(await readFile(join(root, ...PROFILE), "utf8")).toBe(pBefore);
    expect(ignoredAnswer((await readQuestion(root, a.id))!)).toBeUndefined();
  });

  it("never puts back over another writer's change to a file it didn't write (beta.25)", async () => {
    const root = await metarepo([CICD_SYSTEM]);
    const a = await answeredWith(root, targets("/build/hooks", 12), CICD);
    const qBefore = await readFile(join(root, "questions", `${a.id}.yaml`), "utf8");
    const f = join(root, ...PROFILE);
    // Another writer adds a line to the profile just before the fix writes it.
    failing.race = [{ file: f, add: "# another writer's line\n" }];
    const err = await ignoreAnswerBox(root, CICD, { by: "pat", at: AT }).catch((e: Error) => e);
    expect(err).toMatchObject({ code: "changed" });
    expect((err as Error).message).toMatch(/profile\.yaml.*someone else/);
    expect(await readFile(f, "utf8")).toContain("# another writer's line");
    // What the fix wrote (the answer) is put back.
    expect(await readFile(join(root, "questions", `${a.id}.yaml`), "utf8")).toBe(qBefore);
  });

  it("leaves a file it wrote that someone changed since, and names it (beta.25)", async () => {
    const root = await metarepo([CICD_SYSTEM]);
    const a = await answeredWith(root, targets("/build/hooks", 12), CICD);
    const qf = join(root, "questions", `${a.id}.yaml`);
    const pBefore = await readFile(join(root, ...PROFILE), "utf8");
    // The answer is written; someone adds to its file; then the profile's write fails.
    failing.race = [{ file: qf, add: "# a person's note\n" }];
    failing.profile = true;
    try {
      const err = await ignoreAnswerBox(root, CICD, { by: "pat", at: AT }).catch((e: Error) => e);
      expect(err).toMatchObject({ code: "partial", written: [`questions/${a.id}.yaml`] });
      expect((err as Error).message).toMatch(/someone else/);
      expect((err as Error).message).not.toMatch(/nothing was written/);
    } finally {
      failing.profile = false;
    }
    const q = await readFile(qf, "utf8");
    expect(q).toContain("# a person's note");
    expect(q).toContain("Ignore:");
    expect(await readFile(join(root, ...PROFILE), "utf8")).toBe(pBefore);
  });

  it("puts back the question file an answer wrote before it failed, and says so (pre-merge review)", async () => {
    const root = await metarepo([CICD_SYSTEM]);
    const a = await answeredWith(root, targets("/build/hooks", 12), CICD);
    const qf = join(root, "questions", `${a.id}.yaml`);
    const qBefore = await readFile(qf, "utf8");
    const pBefore = await readFile(join(root, ...PROFILE), "utf8");
    // The answer's question file is written, then its skill file's write fails.
    failing.afterAnswer = () =>
      Promise.reject(
        Object.assign(new Error("EPERM: operation not permitted, rename 'skills/forge.md'"), {
          code: "EPERM",
          syscall: "rename",
        }),
      );
    const err = await ignoreAnswerBox(root, CICD, { by: "pat", at: AT }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(AnswerBoxError);
    expect(err).toMatchObject({ code: "failed", written: [] });
    expect((err as Error).message).toMatch(/EPERM/);
    expect((err as Error).message).toMatch(/put back/);
    expect((err as Error).message).not.toMatch(/someone else/);
    expect(await readFile(qf, "utf8")).toBe(qBefore);
    expect(await readFile(join(root, ...PROFILE), "utf8")).toBe(pBefore);
  });

  it("keeps a person's change made just after the answer was written, when a later write fails (pre-merge review)", async () => {
    const root = await metarepo([CICD_SYSTEM]);
    const a = await answeredWith(root, targets("/build/hooks", 12), CICD);
    const qf = join(root, "questions", `${a.id}.yaml`);
    // A person adds a note right after the answer is written, before the fix reads anything.
    failing.afterAnswer = (r, id) =>
      appendFile(join(r, "questions", `${id}.yaml`), "# a person's note\n");
    failing.profile = true;
    try {
      const err = await ignoreAnswerBox(root, CICD, { by: "pat", at: AT }).catch((e: Error) => e);
      expect(err).toMatchObject({ code: "partial", written: [`questions/${a.id}.yaml`] });
      expect((err as Error).message).toMatch(/someone else after the fix wrote it/);
    } finally {
      failing.profile = false;
    }
    const q = await readFile(qf, "utf8");
    expect(q).toContain("# a person's note");
    expect(q).toContain("Ignore:");
  });

  it("refuses a write over files changed since its preview, writing nothing", async () => {
    const root = await metarepo([CICD_SYSTEM]);
    const a = await answeredWith(root, targets("/build/hooks", 12), CICD);
    const look = await ignoreAnswerBox(root, CICD, { by: "pat", at: AT, preview: true });
    expect(look.stamp).toMatch(/^[0-9a-f]{16}$/);
    // Someone edits the profile meanwhile (a comment of theirs).
    const f = join(root, ...PROFILE);
    const theirs = `${await readFile(f, "utf8")}# a person's note\n`;
    await writeFile(f, theirs);
    await expect(
      ignoreAnswerBox(root, CICD, { by: "pat", at: AT, stamp: look.stamp! }),
    ).rejects.toMatchObject({ code: "changed" });
    expect(await readFile(f, "utf8")).toBe(theirs);
    expect(ignoredAnswer((await readQuestion(root, a.id))!)).toBeUndefined();
    // Previewed again, it writes.
    const again = await ignoreAnswerBox(root, CICD, { by: "pat", at: AT, preview: true });
    const w = await ignoreAnswerBox(root, CICD, { by: "pat", at: AT, stamp: again.stamp! });
    expect(w.written).toBe(true);
    expect(ignoredAnswer((await readQuestion(root, a.id))!)).toBeDefined();
    expect(await readFile(f, "utf8")).toContain("# a person's note");
  });
});

describe("a rename names something real (beta.25)", () => {
  it("refuses the box's own name, in its words or as its id", async () => {
    const root = await metarepo([CICD_SYSTEM]);
    const a = await answeredWith(root, targets("/hooks", 20), CICD);
    for (const name of [CICD_WORDS, CICD, "Ignore This Its CICD Related"])
      await expect(renameAnswerBox(root, CICD, name, { by: "pat", at: AT })).rejects.toMatchObject({
        code: "bad",
      });
    expect((await readQuestion(root, a.id))!.answer?.text).toBe(CICD);
    expect((await answerBoxesOf(root)).map((b) => b.id)).toEqual([CICD]);
  });

  it("refuses another box, and takes a system the profile has", async () => {
    const root = await metarepo([CICD_SYSTEM]);
    await answeredWith(root, targets("/hooks", 20), CICD);
    const b = await answeredWith(root, targets("/hooks/out", 21), "this is a proxy to merchants");
    await expect(
      renameAnswerBox(root, "this-is-a-proxy-to-merchants", CICD, { by: "pat", at: AT }),
    ).rejects.toMatchObject({ code: "bad" });
    const r = await renameAnswerBox(root, "this-is-a-proxy-to-merchants", "northwind-pay", {
      by: "pat",
      at: AT,
    });
    expect(r.written).toBe(true);
    expect(r.profile).toBeUndefined();
    expect((await readQuestion(root, b.id))!.answer?.text).toBe("northwind-pay");
  });
});
