import { describe, expect, it, vi } from "vitest";
import { mount } from "./support/hooks.js";

/**
 * Beta.27 review: a count the shell shows from the last answer to a path (useKnownAnswer) is
 * read again when files change, unless a read on the page follows the path itself (then its
 * answer comes to the count, and the path is never asked twice); the Questions page reads the
 * estate's count again after an answer when its own list is another read. Rendered with the tiny
 * hooks runtime, no DOM, no network. Invented Forge names.
 */

vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});

const answers = new Map<string, unknown>();
const asked: string[] = [];
let onFiles: (() => void) | undefined;
vi.mock("../src/api/client.js", async () => {
  const real = await vi.importActual<typeof import("../src/api/client.js")>("../src/api/client.js");
  return {
    ...real,
    api: async (path: string) => {
      asked.push(path);
      return answers.get(path) ?? {};
    },
    useFileChanges: (on: () => void) => {
      onFiles = on;
    },
  };
});

const { forgetExplorerAnswers, QUIET_MS, readAnswerAgain, useKnownAnswer } =
  await import("../src/app/shell/explorer-data.js");
const { readingPath } = await import("../src/api/client.js");
const { STEP_QUESTIONS_PATH } = await import("../src/app/question-counts.js");
const { countsEstateSteps, questionsUrl } = await import("../src/screens/Questions.js");
const { withRoleScope } = await import("../src/screens/RoleQuestions.js");

const quiet = () => new Promise((r) => setTimeout(r, QUIET_MS + 50));
const repos = (n: number) => ({ repos: Array.from({ length: n }, (_, i) => `forge-${i}`) });

describe("a count shown from the last answer follows the files", () => {
  it("is read again on a file event when nothing on the page reads its path", async () => {
    const TRUST = "/api/trust?b27-stale";
    const Known = () => useKnownAnswer<{ repos: string[] }>(TRUST);
    forgetExplorerAnswers();
    asked.length = 0;
    answers.set(TRUST, repos(7));
    const m = mount(Known, {});
    await quiet();
    m.render();
    expect((m.tree as { repos: string[] }).repos).toHaveLength(7);
    expect(asked).toEqual([TRUST]);
    // A repo added: beta.27's first cut kept showing 7 until the page was loaded again.
    answers.set(TRUST, repos(8));
    asked.length = 0;
    onFiles!();
    m.render();
    await quiet();
    m.render();
    expect(asked).toEqual([TRUST]);
    expect((m.tree as { repos: string[] }).repos).toHaveLength(8);
    // And again on the next event.
    answers.set(TRUST, repos(9));
    asked.length = 0;
    onFiles!();
    m.render();
    await quiet();
    m.render();
    expect(asked).toEqual([TRUST]);
    expect((m.tree as { repos: string[] }).repos).toHaveLength(9);
  });

  it("leaves it to a read on the page that follows the path itself", async () => {
    const TRUST = "/api/trust?b27-followed";
    const Known = () => useKnownAnswer<{ repos: string[] }>(TRUST);
    forgetExplorerAnswers();
    answers.set(TRUST, repos(7));
    const m = mount(Known, {});
    await quiet();
    m.render();
    const stop = readingPath(TRUST);
    try {
      asked.length = 0;
      onFiles!();
      m.render();
      await quiet();
      m.render();
      expect(asked).toEqual([]);
    } finally {
      stop();
    }
  });

  it("reads nothing in an editor's panel (want false), files changing or not", async () => {
    const PATH = "/api/trust?b27-editor";
    forgetExplorerAnswers();
    asked.length = 0;
    const Off = () => useKnownAnswer<{ repos: string[] }>(PATH, false);
    const m = mount(Off, {});
    onFiles!();
    m.render();
    await quiet();
    m.render();
    expect(asked).toEqual([]);
  });
});

describe("the Questions page's line at its top, after an answer", () => {
  it("reads the estate's open questions again, and tells the count shown", async () => {
    forgetExplorerAnswers();
    answers.set(STEP_QUESTIONS_PATH, { questions: [], counts: { open: 4 } });
    const Known = () => useKnownAnswer<{ counts: { open: number } }>(STEP_QUESTIONS_PATH);
    const m = mount(Known, {});
    await quiet();
    m.render();
    expect((m.tree as { counts: { open: number } }).counts.open).toBe(4);
    // Answered on the page scoped to a change (its own read is another path): 3 now.
    answers.set(STEP_QUESTIONS_PATH, { questions: [], counts: { open: 3 } });
    await readAnswerAgain(STEP_QUESTIONS_PATH);
    m.render();
    expect((m.tree as { counts: { open: number } }).counts.open).toBe(3);
  });

  it("counts from its own read only when that read is the estate's", () => {
    expect(countsEstateSteps(questionsUrl("open", "all"))).toBe(true);
    expect(countsEstateSteps(questionsUrl("all", "all"))).toBe(true);
    expect(countsEstateSteps(questionsUrl("open", "mine"))).toBe(false);
    expect(
      countsEstateSteps(
        withRoleScope(questionsUrl("open", "all"), { change: "add-transfer-limit" }),
      ),
    ).toBe(false);
    expect(
      countsEstateSteps(withRoleScope(questionsUrl("open", "all"), { role: "architecture" })),
    ).toBe(false);
  });
});
