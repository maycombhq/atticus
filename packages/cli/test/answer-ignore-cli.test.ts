import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  JOIN_IGNORE_LABEL,
  listQuestions,
  readQuestion,
  writeQuestion,
  type Question,
} from "@maycombhq/core";
import { questionsFiles } from "../src/question-commands.js";
import { verifyCommand } from "../src/verify-commands.js";
import { confirmed } from "./seed-slots.js";

/**
 * Beta.24 review, end to end: a person answered a join question with words meaning "ignore this",
 * and the words became a box on the map with arrows to it. Now the words are refused, Ignore is
 * the answer, and after Apply (verify --write) the calls leave the map: no box, no arrow. On the
 * invented Forge estate of fixtures/link-estate/gateway-questions; files only, no network.
 */

const FIX = join(__dirname, "..", "..", "..", "fixtures", "link-estate", "gateway-questions");
const COMMIT: Record<string, string> = {
  "forge-ledger-core": "e5e0001",
  "forge-card-vault": "f6f0001",
  "forge-proxy-core-v1": "d4d0001",
  "forge-teller-app": "a7a0001",
};
const TELLER = "forge-teller-app";
const AT = new Date("2026-11-10T10:00:00.000Z");
const GROUP =
  "Which repo or system answers the calls forge-teller-app makes under /forge through core-gateway?";
const WORDS = "ignore this, its cicd related";

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

function metarepo(): string {
  const root = mkdtempSync(join(tmpdir(), "atticus-answer-ignore-"));
  temps.push(root);
  cpSync(join(FIX, "org-pack"), join(root, "org-pack"), { recursive: true });
  cpSync(join(FIX, "questions"), join(root, "questions"), { recursive: true });
  mkdirSync(join(root, "facts"), { recursive: true });
  for (const r of Object.keys(COMMIT)) {
    cpSync(join(FIX, "repos", r), join(root, "workspace", r), { recursive: true });
    writeFileSync(
      join(root, "facts", `${r}.jsonl`),
      readFileSync(join(FIX, "facts", `${r}.jsonl`), "utf8"),
    );
  }
  return root;
}

async function verify(root: string, repo: string): Promise<void> {
  const out: string[] = [];
  // ADR 0195 point 4 and the owner's third answer: an answer that moves a call off the
  // Unresolved list explains the records it removes, and a removal of more than 10% of a repo's
  // records waits for its count: confirmed here as a person would, with the count listed.
  const code = await confirmed(
    (io, allowRemovals) =>
      verifyCommand(
        root,
        repo,
        {
          commit: COMMIT[repo]!,
          dir: join(root, "workspace", repo),
          write: true,
          now: () => AT,
          ...(allowRemovals !== undefined ? { allowRemovals } : {}),
        },
        io,
      ),
    { out: (l) => out.push(l), err: (l) => out.push(`ERR ${l}`) },
  );
  expect(code, out.join("\n")).toBe(0);
}

async function questions(root: string, args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await questionsFiles(
    root,
    ["questions", ...args],
    { out: (l) => out.push(l), err: (l) => err.push(l) },
    { now: AT },
  );
  return { code, out, err };
}

/** Every generated catalog file's text, and the map's, so a box or arrow by any name is seen. */
function generated(root: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    let es;
    try {
      es = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of es)
      if (e.isDirectory()) walk(join(d, e.name));
      else out.push(readFileSync(join(d, e.name), "utf8"));
  };
  walk(join(root, "catalog", "generated"));
  walk(join(root, "map"));
  return out.join("\n");
}

async function asked(): Promise<{ root: string; q: Question }> {
  const root = metarepo();
  for (const r of ["forge-ledger-core", "forge-card-vault", "forge-proxy-core-v1", TELLER])
    await verify(root, r);
  const q = (await listQuestions(root)).questions.find((x) => x.question === GROUP)!;
  expect(q.state).toBe("open");
  return { root, q };
}

describe("an answer's words never become a box (beta.24 review)", () => {
  it("made a box from the words before: the damage this fixes", async () => {
    const { root, q } = await asked();
    // As the app wrote it before the fix: the words as the answer, on file.
    await writeQuestion(root, {
      ...q,
      state: "answered",
      answer: {
        text: WORDS,
        by: "pat",
        at: AT.toISOString(),
        scope: { level: "repo", id: TELLER },
      },
    });
    await verify(root, TELLER);
    expect(generated(root)).toMatch(/ignore-this/);
  });

  it("refuses the words, takes Ignore, and the calls leave the map after Apply", async () => {
    const { root, q } = await asked();
    const refused = await questions(root, ["answer", q.id, "--text", WORDS, "--by", "pat"]);
    expect(refused.code).toBe(2);
    expect(refused.err.join("\n")).toMatch(/names no repo, component or system/);
    expect((await readQuestion(root, q.id))!.state).toBe("open");

    const ignored = await questions(root, [
      "answer",
      q.id,
      "--ignore",
      "--reason",
      "its cicd related",
      "--by",
      "pat",
    ]);
    expect(ignored.code, ignored.err.join("\n")).toBe(0);
    const now = (await readQuestion(root, q.id))!;
    expect(now.answer?.text).toBe("Ignore: its cicd related");

    await verify(root, TELLER);
    const text = generated(root);
    expect(text).not.toMatch(/ignore|cicd/i);
    // Not asked again.
    expect((await readQuestion(root, q.id))!.state).toBe("answered");
  });

  it("takes the Ignore option with no reason, and adds it to a question asked before it", async () => {
    const { root, q: asNow } = await asked();
    // As asked before Ignore was offered (new questions offer it from the start).
    const q = { ...asNow, options: asNow.options.filter((o) => o.label !== JOIN_IGNORE_LABEL) };
    await writeQuestion(root, q);
    expect(q.options.some((o) => o.label === JOIN_IGNORE_LABEL)).toBe(false);
    const r = await questions(root, ["answer", q.id, "--ignore", "--by", "pat"]);
    expect(r.code, r.err.join("\n")).toBe(0);
    const now = (await readQuestion(root, q.id))!;
    expect(now.options.at(-1)!.label).toBe(JOIN_IGNORE_LABEL);
    expect(now.answer?.option).toBe(now.options.length);
    expect((await questions(root, ["answer", q.id, "--reason", "x"])).code).toBe(2);
  });
});
