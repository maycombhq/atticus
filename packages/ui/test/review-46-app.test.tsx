import { describe, expect, it, vi } from "vitest";
import type { Api } from "@maycombhq/core";
import { all, mount, text } from "./support/hooks.js";

/**
 * Review round 46 (the web app): a result that stays past the reload it causes, the role filter
 * kept when a question opens, answers that land in order, the counts of the list shown, the
 * editor's text after Save and the Task board's messages. Rendered with the tiny hooks runtime,
 * no DOM; the API is a mock. Invented Forge names.
 */

vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});

type Pending = {
  path: string;
  init?: { method?: string; body?: unknown };
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
};
const h = vi.hoisted(() => ({
  pending: [] as Pending[],
  answer: undefined as ((p: Pending) => void) | undefined,
  useApi: (_path?: string): unknown => ({ state: "loading", reload: () => undefined }),
  apiPaths: [] as (string | undefined)[],
  live: undefined as ((e: { type: string; path?: string }) => void) | undefined,
}));
vi.mock("../src/api/client.js", async () => ({
  ...(await vi.importActual<object>("../src/api/client.js")),
  api: (path: string, init?: Pending["init"]) =>
    new Promise((resolve, reject) => {
      const p = { path, ...(init ? { init } : {}), resolve, reject };
      h.pending.push(p);
      h.answer?.(p);
    }),
  useApi: (path?: string) => {
    h.apiPaths.push(path);
    return h.useApi(path);
  },
  useLiveEvents: (fn: (e: { type: string; path?: string }) => void) => {
    h.live = fn;
  },
  useReloadOnFiles: () => undefined,
}));

const { COPY } = await import("../src/copy.js");
const { DecisionsProvider, UndoBatch, UndoResultView } = await import("../src/app/decisions.js");
const { DecisionsPage } = await import("../src/screens/map/Decisions.js");
const { BulkAnswer, BulkResultView, QuestionList, Questions } =
  await import("../src/screens/Questions.js");
const { RoleFilter } = await import("../src/screens/RoleQuestions.js");
const { latestCall } = await import("../src/api/latest.js");
const { ArtifactEditor } = await import("../src/screens/Changes.js");
const { tasksThatChanged, withoutTasks } = await import("../src/screens/know/Phase.js");

const flush = () => new Promise((r) => setTimeout(r, 0));
type El = ReturnType<typeof all>[number];
const find = (tree: unknown, pred: (e: El) => boolean) => all(tree).find(pred);
const ofType = (tree: unknown, type: unknown) => all(tree).filter((e) => e.type === type);
/** A View's body for its data: the render function it was handed. */
const viewBody = (tree: unknown, data: unknown) => {
  const v = find(tree, (e) => typeof e.props.children === "function" && "of" in e.props);
  if (!v) throw new Error(`no View: ${text(tree)}`);
  return (v.props.children as (d: unknown) => unknown)(data);
};
const reset = () => {
  h.pending.length = 0;
  h.answer = undefined;
  h.apiPaths.length = 0;
  h.live = undefined;
};

// ------------------------------------------------------------------ 1. Undo's result stays

const BATCH: Api.DecisionBatchViewT = {
  id: "b-20261108-110000-0f0f0f",
  kind: "rule",
  at: "2026-11-08T11:00:00Z",
  by: "Priya Nair",
  applied: 4,
  reverted: 1,
  file: "decisions/b-20261108-110000-0f0f0f.yaml",
};
const view = (b: Api.DecisionBatchViewT): Api.DecisionsViewT => ({
  decide: {
    configured: { links: "propose", questions: "propose", minPrecision: 0.95 },
    now: { links: "propose", questions: "propose" },
    precision: {
      drawn: 0,
      right: 0,
      wrong: 0,
      unsure: 0,
      open: 0,
      gone: 0,
      precision: null,
      low: null,
      high: null,
    },
  },
  links: { counts: { fromCode: 4, byPerson: 1, byAi: 0 }, items: [] },
  questions: { counts: { fromCode: 0, byPerson: 1, byAi: 0, open: 0 }, items: [] },
  batches: [b],
  problems: [],
});
const UNDID: Api.UndoBatchResultT = {
  batch: BATCH.id,
  removed: 4,
  restored: 1,
  skipped: ["forge-ledger src/holds.ts:12 changed since"],
  files: ["forge-ledger.corrections.jsonl"],
  verify: ["atticus verify forge-ledger --write"],
  commit: "git commit",
};

describe("Map › Decided by AI: Undo's result (review round 46)", () => {
  it("stays shown after the reload marks the batch undone, until it is closed", () => {
    reset();
    let reloads = 0;
    const props = {
      of: {
        state: "ready" as const,
        data: view(BATCH),
        reload: () => {
          reloads++;
        },
      },
      repo: "",
      kind: "",
      onRepo: () => undefined,
      onKind: () => undefined,
    };
    const m = mount(DecisionsPage as never, props as never);
    const undo = ofType(viewBody(m.tree, view(BATCH)), UndoBatch)[0]!;
    (undo.props.onDone as (r: Api.UndoBatchResultT) => void)(UNDID);
    m.render();
    expect(reloads).toBe(1);
    // The reload lands: the batch is undone, and its Undo (with its own result) is gone.
    const after = viewBody(
      m.tree,
      view({ ...BATCH, undone: { by: "Priya Nair", at: UNDID.batch } }),
    );
    expect(ofType(after, UndoBatch)).toHaveLength(0);
    const shown = ofType(after, UndoResultView);
    expect(shown).toHaveLength(1);
    expect(shown[0]!.props.r).toBe(UNDID);
    // Closed, it goes.
    (shown[0]!.props.onDismiss as () => void)();
    m.render();
    expect(ofType(viewBody(m.tree, view(BATCH)), UndoResultView)).toHaveLength(0);
  });

  it("says its lines left and next steps, with a Close", () => {
    const m = mount(UndoResultView as never, { r: UNDID, onDismiss: () => undefined } as never);
    const t = text(m.tree);
    expect(t).toContain(COPY.decisions.undoneResult(UNDID.batch, 4, 1));
    expect(t).toContain(UNDID.skipped[0]);
    expect(find(m.tree, (e) => e.type === "button" && text(e) === COPY.app.dismiss)).toBeTruthy();
  });
});

// ------------------------------------------------------------------ 5. one decisions load at a time

describe("the AI's decisions load in order (review round 46)", () => {
  it("makes one load at a time; a burst of file changes asks once more, and the last answer stands", async () => {
    reset();
    const m = mount(DecisionsProvider as never, { children: null } as never);
    const value = () => (m.tree as El).props.value as { view: unknown; need(): void };
    value().need();
    expect(h.pending).toHaveLength(1);
    for (let n = 0; n < 3; n++) h.live!({ type: "file.changed", path: "decisions/b.yaml" });
    expect(h.pending).toHaveLength(1);
    const older = view(BATCH);
    const newer = view({ ...BATCH, id: "b-20261108-120000-1a1a1a" });
    h.pending[0]!.resolve(older);
    await flush();
    expect(h.pending).toHaveLength(2);
    h.pending[1]!.resolve(newer);
    await flush();
    m.render();
    expect(value().view).toEqual({ state: "ready", data: newer });
    expect(h.pending).toHaveLength(2);
  });
});

// ------------------------------------------------------------------ 4. the newest focus only

describe("the canvas's focus answers (review round 46)", () => {
  it("counts only the newest call, and none once dropped", () => {
    const c = latestCall();
    const first = c.start();
    expect(first()).toBe(true);
    const second = c.start();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
    c.drop();
    expect(second()).toBe(false);
  });
});

// ------------------------------------------------------------------ 2 and 3. Questions

const AT = "2026-11-08T10:00:00.000Z";
const question = (id: string, state: "open" | "answered" = "open") =>
  ({
    schemaVersion: 5,
    id,
    askedBy: {
      step: "change-architecture",
      command: "atticus change architecture add-holds",
      at: AT,
    },
    repo: "forge-ledger",
    question: `Does forge-ledger own ${id}?`,
    evidence: ["src/holds.ts:12"],
    scope: { level: "repo", id: "forge-ledger" },
    state,
    rerun: "atticus change architecture add-holds",
    role: "architecture",
  }) as never;
const listOf = (qs: unknown[], reload = () => undefined) => ({
  state: "ready" as const,
  data: { questions: qs, problems: [] },
  reload,
});

describe("Questions keeps the role filter when a question opens (review round 46)", () => {
  it("links each question with the change and the role", () => {
    const m = mount(
      QuestionList as never,
      {
        of: listOf([question("q-000000000001")]),
        change: "add-holds",
        role: "architecture",
      } as never,
    );
    const body = viewBody(m.tree, listOf([question("q-000000000001")]).data);
    const link = find(body, (e) => e.type === "a" && e.props.className === "q-item");
    expect(link?.props.href).toBe("#/questions/q-000000000001?change=add-holds&role=architecture");
  });

  it("keeps a role picked on the page when only the question opened changes", () => {
    reset();
    h.useApi = (path) =>
      path?.startsWith("/api/questions") ? listOf([question("q-000000000001")]) : listOf([]);
    const props = { hash: "#/questions" };
    const m = mount(Questions as never, props as never);
    const filter = () => ofType(m.tree, RoleFilter)[0]!;
    (filter().props.onChange as (r: string) => void)("architecture");
    m.render();
    expect(filter().props.value).toBe("architecture");
    props.hash = "#/questions/q-000000000001?role=architecture";
    m.render();
    props.hash = "#/questions/q-000000000002";
    m.render();
    // The address names no role now, and it did before: the person cleared it there.
    expect(filter().props.value).toBeUndefined();
    (filter().props.onChange as (r: string) => void)("architecture");
    m.render();
    props.hash = "#/questions/q-000000000001";
    m.render();
    expect(filter().props.value).toBe("architecture");
    expect(h.apiPaths.at(-2)).toContain("role=architecture");
  });
});

describe("Questions: a bulk answer's result (review round 46)", () => {
  it("stays shown after the answered ones leave the open list, and they leave the picks", () => {
    reset();
    let reloads = 0;
    let qs = [question("q-000000000001"), question("q-000000000002")];
    h.useApi = (path) =>
      path?.startsWith("/api/questions")
        ? listOf(qs, () => {
            reloads++;
          })
        : listOf([]);
    const m = mount(Questions as never, { hash: "#/questions" } as never);
    const list = () => ofType(m.tree, QuestionList)[0]!;
    (list().props.onSelect as (ids: string[], on: boolean) => void)(
      ["q-000000000001", "q-000000000002"],
      true,
    );
    m.render();
    const bulk = ofType(m.tree, BulkAnswer)[0]!;
    const r = { ok: ["q-000000000001"], failed: [{ id: "q-000000000002", why: "no such repo" }] };
    (bulk.props.onDone as (x: typeof r) => void)(r);
    m.render();
    expect(reloads).toBe(1);
    expect([...(list().props.selected as Set<string>)]).toEqual(["q-000000000002"]);
    // The reload lands: the answered one has left the open list; the result is still there.
    qs = [question("q-000000000002")];
    m.render();
    const shown = ofType(m.tree, BulkResultView);
    expect(shown).toHaveLength(1);
    expect(shown[0]!.props.r).toEqual(r);
    expect(ofType(m.tree, BulkAnswer)[0]!.props.ids).toEqual(["q-000000000002"]);
    (shown[0]!.props.onDismiss as () => void)();
    m.render();
    expect(ofType(m.tree, BulkResultView)).toHaveLength(0);
  });

  it("says how many were answered, why the others weren't, and what to run next", () => {
    const m = mount(
      BulkResultView as never,
      {
        r: { ok: ["q-000000000001"], failed: [{ id: "q-000000000002", why: "no such repo" }] },
        onDismiss: () => undefined,
      } as never,
    );
    const t = text(m.tree);
    expect(t).toContain(COPY.questions.bulk.done(1));
    expect(t).toContain("q-000000000002: no such repo");
    expect(t).toContain(COPY.questions.bulk.next);
    expect((m.tree as El).props.role).toBe("status");
  });
});

// ------------------------------------------------------------------ 7. the editor after Save

describe("the artifact editor after Save (review round 46)", () => {
  it("shows the saved text until the file read again lands, and saves next against it", async () => {
    reset();
    let file = { path: "openspec/changes/add-holds/proposal.md", content: "old", sha256: "s1" };
    let reloads = 0;
    h.useApi = () => ({
      state: "ready",
      data: file,
      reload: () => {
        reloads++;
      },
    });
    h.answer = (p) => {
      const b = p.init?.body as { content: string };
      p.resolve({ ...file, content: b.content, sha256: `sha-of-${b.content}` });
    };
    const m = mount(
      ArtifactEditor as never,
      { change: "add-holds", artifact: "proposal", onClose: () => undefined } as never,
    );
    const form = () => viewBody(m.tree, file);
    const box = () => find(form(), (e) => e.type === "textarea")!;
    const type = (v: string) => {
      (box().props.onChange as (e: { target: { value: string } }) => void)({
        target: { value: v },
      });
      m.render();
    };
    const save = async () => {
      const f = find(form(), (e) => e.type === "form")!;
      (f.props.onSubmit as (e: { preventDefault(): void }) => void)({ preventDefault: () => {} });
      await flush();
      m.render();
    };
    type("new");
    await save();
    expect(reloads).toBe(1);
    // The reload hasn't landed: the box shows what was saved, not the text from before.
    expect(box().props.value).toBe("new");
    type("newer");
    await save();
    expect(h.pending.map((p) => (p.init?.body as { baseSha256: string }).baseSha256)).toEqual([
      "s1",
      "sha-of-new",
    ]);
    // The file read again lands.
    file = { ...file, content: "newer", sha256: "sha-of-newer" };
    m.render();
    expect(box().props.value).toBe("newer");
  });
});

// ------------------------------------------------------------------ 8. the Task board's messages

describe("the Task board's messages (review round 46)", () => {
  const task = (id: string, done = false) =>
    ({ id, repo: "forge-ledger", description: `Task ${id}`, done, branch: "b" }) as never;
  it("finds only the tasks whose state changed", () => {
    const before = [task("1.1"), task("1.2"), task("1.3")];
    const after = [task("1.1", true), task("1.2")];
    expect([...tasksThatChanged(before, after)].sort()).toEqual(["1.1", "1.3"]);
    expect(tasksThatChanged(before, [task("1.1"), task("1.2"), task("1.3")]).size).toBe(0);
  });
  it("drops only those tasks' messages", () => {
    const said = { "1.1": "Run prepared", "1.2": "Working" };
    expect(withoutTasks(said, new Set(["1.1"]))).toEqual({ "1.2": "Working" });
    expect(withoutTasks(said, new Set(["9.9"]))).toBe(said);
  });
});
