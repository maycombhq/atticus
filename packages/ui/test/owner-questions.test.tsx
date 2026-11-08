import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { all, mount, text } from "./support/hooks.js";

/**
 * UX review (2026-11-08): Home's owner-question count and the Questions page agree, and an owner
 * question is answered on the Questions page, writing what `atticus questions owner` writes, then
 * proposed for review. Accepting the baseline offers Propose for review too.
 */
vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
const calls: { path: string; body?: unknown }[] = [];
let baselined = false;
vi.mock("../src/api/client.js", async () => ({
  ...(await vi.importActual<object>("../src/api/client.js")),
  api: async (path: string, o?: { body?: unknown }) => {
    calls.push({ path, ...(o?.body ? { body: o.body } : {}) });
    if (path === "/api/baseline") {
      baselined = true;
      return {};
    }
    return {
      file: "catalog/curated/ownerquestion/q.unattended-workload-monitored.reports-job.yaml",
      question: { ...Q, state: "answered", answer: "An alert pages team-reports." },
    };
  },
  useApi: () => ({
    state: "ready",
    data: {
      baselined,
      steps: [{ id: "scan", label: "Scan", detail: "read", done: true }],
    },
    reload: () => undefined,
  }),
  useLiveEvents: () => undefined,
}));
const { COPY } = await import("../src/copy.js");
const { Propose } = await import("../src/app/propose.js");
const { OwnerQuestionCard, OwnerQuestionList, questionsKind, waitingQuestions } =
  await import("../src/screens/OwnerQuestions.js");
const { SetupChecklist } = await import("../src/screens/CommandCenter.js");
const O = COPY.questions.ownerQuestions;
const tick = () => new Promise((r) => setTimeout(r, 0));

const Q = {
  id: "q.unattended-workload-monitored.reports-job",
  system: "reports",
  owner: "team-reports",
  question: "Which alert or dashboard watches reports-job?",
  neededFact: "ObservabilityAsset (alert or dashboard) for reports-job",
  channel: "ado",
  state: "sent" as const,
  records: ["reports-job"],
  file: "catalog/curated/ownerquestion/q.unattended-workload-monitored.reports-job.yaml",
};

it("counts what the Questions page shows, and links to the kind that waits", () => {
  expect(waitingQuestions(2, 3)).toEqual({ n: 5, href: "#/questions" });
  expect(waitingQuestions(0, 3)).toEqual({ n: 3, href: "#/questions?kind=owner" });
  expect(waitingQuestions(undefined, 3)).toEqual({ n: undefined, href: "#/questions" });
  expect(questionsKind("#/questions?kind=owner")).toBe("owner");
  expect(questionsKind("#/questions")).toBe("steps");
  expect(questionsKind("#/questions/q-0123456789ab")).toBe("steps");
});

it("answers an owner question, then offers Propose for review of owner answers", async () => {
  let answered = 0;
  const m = mount(OwnerQuestionCard as never, { q: Q, onAnswered: () => answered++ } as never);
  expect(text(m.tree)).toContain(Q.question);
  expect(text(m.tree)).toContain(O.needs(Q.neededFact));
  const field = all(m.tree).find((e) => e.type === "textarea")!;
  const label = all(m.tree).find((e) => e.type === "label")!;
  expect(label.props.htmlFor).toBe(field.props.id);
  const form = all(m.tree).find((e) => e.type === "form")!;
  // An empty answer is refused before any call.
  (form.props.onSubmit as (e: unknown) => void)({ preventDefault: () => undefined });
  m.render();
  expect(text(m.tree)).toContain(O.needAnswer);
  expect(calls).toEqual([]);
  (field.props.onChange as (e: unknown) => void)({
    target: { value: "An alert pages team-reports." },
  });
  m.render();
  (all(m.tree).find((e) => e.type === "form")!.props.onSubmit as (e: unknown) => void)({
    preventDefault: () => undefined,
  });
  await tick();
  m.render();
  expect(calls).toEqual([
    {
      path: `/api/owner-questions/${Q.id}/answer`,
      body: { answer: "An alert pages team-reports." },
    },
  ]);
  expect(answered).toBe(1);
  expect(text(m.tree)).toContain(O.saved(Q.file));
  const propose = all(m.tree).find((e) => e.type === Propose)!;
  expect(propose.props.scope).toBe("owner-answers");
});

it("has loading, empty and error states", () => {
  const html = (of: unknown) => renderToStaticMarkup(<OwnerQuestionList of={of as never} />);
  expect(html({ state: "loading" })).toContain('aria-busy="true"');
  expect(html({ state: "ready", data: { empty: true, open: 0, questions: [] } })).toContain(
    O.emptyCatalog,
  );
  expect(html({ state: "ready", data: { empty: false, open: 0, questions: [] } })).toContain(
    O.empty,
  );
  expect(html({ state: "error", error: "boom" })).toContain('role="alert"');
});

it("after accepting the baseline, keeps the note and offers Propose for review", async () => {
  calls.length = 0;
  const m = mount(SetupChecklist as never, {} as never);
  const accept = all(m.tree).find(
    (e) => e.type === "button" && text(e.props.children) === COPY.commandCenter.acceptTheCatalogAs,
  )!;
  (accept.props.onClick as () => void)();
  await tick();
  m.render();
  expect(calls.map((c) => c.path)).toEqual(["/api/baseline"]);
  expect(text(m.tree)).toContain(COPY.commandCenter.theCatalogIsAccepted);
  expect(text(m.tree)).not.toMatch(/Commit it/);
  const propose = all(m.tree).find((e) => e.type === Propose)!;
  expect(propose.props.scope).toBe("baseline");
});
