import { beforeEach, describe, expect, it, vi } from "vitest";
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
type Burst = { type: string; path?: string; catalog?: boolean }[];
/** Every mounted listener of file events, each with its latest handler (as the real hook keeps). */
const listeners = new Set<{ on: (events: Burst) => void }>();
/** A burst of file events, to every listener. */
const onFiles = (events: Burst = [{ type: "file.changed", path: "catalog/generated/x.yaml" }]) => {
  for (const l of listeners) l.on(events);
};
vi.mock("../src/api/client.js", async () => {
  const real = await vi.importActual<typeof import("../src/api/client.js")>("../src/api/client.js");
  const { shim } = await import("./support/hooks.js");
  return {
    ...real,
    api: async (path: string) => {
      asked.push(path);
      // An answer comes a moment later, as the server's does.
      await new Promise((r) => setTimeout(r, 5));
      return answers.get(path) ?? {};
    },
    useFileChanges: (on: (events: Burst) => void) => {
      const r = shim.useRef<{ on: (events: Burst) => void } | undefined>(undefined);
      if (!r.current) {
        r.current = { on };
        listeners.add(r.current);
      }
      r.current.on = on;
    },
  };
});

const { forgetExplorerAnswers, FRESH_MS, QUIET_MS, readAnswerAgain, useKnownAnswer } =
  await import("../src/app/shell/explorer-data.js");
const { MANIFEST_REPOS_PATH, manifestMayHaveChanged } = await import("../src/app/repo-counts.js");
const { readingPath } = await import("../src/api/client.js");
const { STEP_QUESTIONS_PATH, stepQuestionsMayHaveChanged } =
  await import("../src/app/question-counts.js");
const { countsEstateSteps, questionsUrl } = await import("../src/screens/Questions.js");
const { withRoleScope } = await import("../src/screens/RoleQuestions.js");

const quiet = () => new Promise((r) => setTimeout(r, QUIET_MS + 50));
beforeEach(() => listeners.clear());
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
    onFiles();
    m.render();
    await quiet();
    m.render();
    expect(asked).toEqual([TRUST]);
    expect((m.tree as { repos: string[] }).repos).toHaveLength(8);
    // And again on the next event.
    answers.set(TRUST, repos(9));
    asked.length = 0;
    onFiles();
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
      onFiles();
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
    onFiles();
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

describe("beta.27 re-review: one read of a path per burst, and only for a burst that can change it", () => {
  it("reads /api/trust once for a burst, however many counts show it (the status bar, the Explorer)", async () => {
    forgetExplorerAnswers();
    answers.set(MANIFEST_REPOS_PATH, repos(7));
    // The shell's status bar and the Explorer's Systems header, on a page that doesn't read it.
    const Both = () => [
      useKnownAnswer<{ repos: string[] }>(MANIFEST_REPOS_PATH, true, manifestMayHaveChanged),
      useKnownAnswer<{ repos: string[] }>(MANIFEST_REPOS_PATH, true, manifestMayHaveChanged),
    ];
    const m = mount(Both, {});
    await quiet();
    m.render();
    expect(asked.filter((p) => p === MANIFEST_REPOS_PATH)).toHaveLength(1);
    // A burst that can change it: one GET, both counts told.
    answers.set(MANIFEST_REPOS_PATH, repos(8));
    asked.length = 0;
    onFiles([
      { type: "file.changed", path: "catalog/generated/forge-ledger/x.yaml" },
      { type: "file.changed", path: "facts/forge-ledger.jsonl" },
      { type: "file.changed", path: "repos.manifest.yaml" },
    ]);
    m.render();
    await quiet();
    m.render();
    expect(asked).toEqual([MANIFEST_REPOS_PATH]);
    const [a, b] = m.tree as { repos: string[] }[];
    expect(a!.repos).toHaveLength(8);
    expect(b!.repos).toHaveLength(8);
    // A burst that can't (a question answered, a run's files): no GET at all.
    asked.length = 0;
    onFiles([
      { type: "file.changed", path: "questions/q-0123456789ab.yaml", catalog: false },
      { type: "run.changed", path: ".atticus/runs/add-transfer-limit/run-1/answer.md" },
    ]);
    m.render();
    await quiet();
    m.render();
    expect(asked).toEqual([]);
  });

  it("after an answer on Questions, reads the steps' questions once, its file events included", async () => {
    forgetExplorerAnswers();
    answers.set(STEP_QUESTIONS_PATH, { questions: [], counts: { open: 4 } });
    // The status bar's count and the Questions page's line, both from the estate's read.
    const Both = () => [
      useKnownAnswer<{ counts: { open: number } }>(
        STEP_QUESTIONS_PATH,
        true,
        stepQuestionsMayHaveChanged,
      ),
      useKnownAnswer<{ counts: { open: number } }>(
        STEP_QUESTIONS_PATH,
        true,
        stepQuestionsMayHaveChanged,
      ),
    ];
    const m = mount(Both, {});
    await quiet();
    m.render();
    asked.length = 0;
    answers.set(STEP_QUESTIONS_PATH, { questions: [], counts: { open: 3 } });
    // The page reads it again after its answer; the answer's write comes as file events after.
    const again = readAnswerAgain(STEP_QUESTIONS_PATH);
    onFiles([{ type: "file.changed", path: "questions/q-0123456789ab.yaml", catalog: false }]);
    await again;
    m.render();
    await quiet();
    m.render();
    expect(asked).toEqual([STEP_QUESTIONS_PATH]);
    const [a, b] = m.tree as { counts: { open: number } }[];
    expect(a!.counts.open).toBe(3);
    expect(b!.counts.open).toBe(3);
    // A later change, past FRESH_MS, is read again (once).
    await new Promise((r) => setTimeout(r, FRESH_MS));
    asked.length = 0;
    onFiles([{ type: "file.changed", path: "questions/q-0123456789ac.yaml", catalog: false }]);
    m.render();
    await quiet();
    m.render();
    expect(asked).toEqual([STEP_QUESTIONS_PATH]);
  });
});
