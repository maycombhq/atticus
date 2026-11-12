import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { all, mount, text } from "./support/hooks.js";

/**
 * Beta.27 review, round 2: "sent" is on file in the question's own record, so the send route
 * refuses a second send (409) of a question another person sent; the card then offers Send again,
 * which asks first and says `again`. A system nobody owns is sent to the role it is routed to,
 * never to "Nobody owns it". Invented Forge names; no network (the client is mocked).
 */
vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
const calls: { path: string; body?: unknown }[] = [];
vi.mock("../src/api/confirm.js", () => ({
  confirmed: async () => ({ confirmation: "c-1" }),
}));
vi.mock("../src/api/client.js", async () => {
  const real = await vi.importActual<typeof import("../src/api/client.js")>("../src/api/client.js");
  return {
    ...real,
    api: async (path: string, o?: { body?: unknown }) => {
      calls.push({ path, ...(o?.body ? { body: o.body } : {}) });
      const b = o?.body as { again?: boolean } | undefined;
      if (!b?.again)
        throw new real.ApiError({
          type: "about:blank",
          title: "Already sent",
          code: "already-sent",
          status: 409,
          detail: "q.x was sent: choose Send again to send it once more.",
        });
      return { state: "sent", to: "team-reports" };
    },
  };
});
const { COPY } = await import("../src/copy.js");
const { OwnerQuestionCard, SendOwnerQuestion } = await import("../src/screens/OwnerQuestions.js");
const S = COPY.roleWork.send;
const O = COPY.questions.ownerQuestions;
const tick = () => new Promise((r) => setTimeout(r, 0));
const button = (tree: unknown, words: string) =>
  all(tree).find((e) => e.type === "button" && text(e.props.children) === words)!;

it("refused as already sent, offers Send again, which asks first and says again", async () => {
  let sent = 0;
  const m = mount(
    SendOwnerQuestion as never,
    {
      id: "q.unattended-workload-monitored.reports-job",
      owner: "Reports team",
      onSent: () => sent++,
    } as never,
  );
  (button(m.tree, S.button("Reports team")).props.onClick as () => void)();
  await tick();
  m.render();
  expect(calls.at(-1)?.body).toEqual({ confirmation: "c-1" });
  expect(text(m.tree)).toContain(S.already("Reports team"));
  expect(sent).toBe(0);
  // Send again, now the secondary choice, asks before it sends.
  const again = button(m.tree, S.again("Reports team"));
  expect(again.props.className).toBe("btn");
  const before = calls.length;
  (again.props.onClick as () => void)();
  m.render();
  expect(calls.length).toBe(before);
  expect(text(m.tree)).toContain(S.confirmAgain("Reports team"));
  // Cancel sends nothing.
  (button(m.tree, S.cancel).props.onClick as () => void)();
  m.render();
  expect(text(m.tree)).not.toContain(S.confirmAgain("Reports team"));
  expect(calls.length).toBe(before);
  (button(m.tree, S.again("Reports team")).props.onClick as () => void)();
  m.render();
  (button(m.tree, S.yesAgain).props.onClick as () => void)();
  await tick();
  m.render();
  expect(calls.at(-1)?.body).toEqual({ confirmation: "c-1", again: true });
  expect(text(m.tree)).toContain(S.sent("Reports team"));
  expect(sent).toBe(1);
});

it("sends a question nobody owns to the role it goes to, saying Nobody owns it only as whose", () => {
  const q = {
    id: "q.owner-named.reports",
    system: "reports",
    owner: "unassigned",
    routeTo: "architect",
    question: "Who owns reports-db?",
    neededFact: "Its owning team",
    channel: "teams",
    state: "sent" as const,
    records: ["reports-db"],
    file: "catalog/curated/ownerquestion/q.owner-named.reports.yaml",
  };
  const m = mount(OwnerQuestionCard as never, { q, onAnswered: () => undefined } as never);
  const send = all(m.tree).find((e) => e.type === SendOwnerQuestion)!;
  expect(send.props.owner).toBe(O.toRole("architect"));
  const out = renderToStaticMarkup(<OwnerQuestionCard q={q} onAnswered={() => undefined} />);
  expect(out).toContain(O.notSentTo("the architect", "Microsoft Teams"));
  expect(out).toContain(S.button("the architect"));
  expect(out).not.toContain(S.button(O.nobody));
  expect(out).toContain(O.ask(O.nobody, "reports", "Microsoft Teams"));
});
