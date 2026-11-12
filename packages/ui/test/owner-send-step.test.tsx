import { expect, it, vi } from "vitest";
import { all, mount, text } from "./support/hooks.js";

/**
 * Beta.27 review, final round: a send that became a step for the person (manual notifications, or
 * a live notifier that couldn't reach the system) is no send: the card says Asked, a step waiting
 * for the person to send it, never Sent; the server's reason is shown. After a 409 (sent already)
 * the card reloads, so it doesn't say "Not sent yet" beside "already sent". Invented Forge names;
 * no network (the client is mocked).
 */
vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
let answer: "step" | "409" = "step";
vi.mock("../src/api/confirm.js", () => ({
  confirmed: async () => ({ confirmation: "c-1" }),
}));
vi.mock("../src/api/client.js", async () => {
  const real = await vi.importActual<typeof import("../src/api/client.js")>("../src/api/client.js");
  return {
    ...real,
    api: async () => {
      if (answer === "409")
        throw new real.ApiError({
          type: "about:blank",
          title: "Already sent",
          status: 409,
          detail: "q.x was sent: choose Send again to send it once more.",
        });
      return {
        state: "step",
        to: "team-reports",
        id: "step-1",
        why: "Not sent: the notify adapter couldn't send it (unavailable: slack: the Northwind chat service is down), so sending it is a step for you (Home › Manual steps).",
      };
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

const q = {
  id: "q.unattended-workload-monitored.reports-job",
  system: "reports-job",
  owner: "team-reports",
  ownerName: "Reports team",
  question: "Who is told when reports-job fails overnight?",
  neededFact: "The job's alert route",
  channel: "teams",
  state: "sent" as const,
  records: ["reports-job"],
  file: "catalog/curated/ownerquestion/q.unattended-workload-monitored.reports-job.yaml",
};

it("a step is said as a step, with the server's reason, and never as sent", async () => {
  answer = "step";
  const got: string[] = [];
  const m = mount(
    SendOwnerQuestion as never,
    {
      id: q.id,
      owner: "Reports team",
      onSent: (_at: string, how: string) => got.push(how),
    } as never,
  );
  (button(m.tree, S.button("Reports team")).props.onClick as () => void)();
  await tick();
  m.render();
  expect(got).toEqual(["step"]);
  expect(text(m.tree)).toContain("the Northwind chat service is down");
  expect(text(m.tree)).not.toContain(S.sent("Reports team"));
});

it("the card for a step says Asked: a step for the owner, not Sent", () => {
  const m = mount(OwnerQuestionCard as never, { q, onAnswered: () => undefined } as never);
  expect(text(m.tree)).toContain(O.notSentTo("Reports team", "Microsoft Teams"));
  const send = all(m.tree).find((e) => e.type === SendOwnerQuestion)!;
  (send.props.onSent as (at: string, how: string) => void)("2026-11-09T09:00:00Z", "step");
  m.render();
  expect(text(m.tree)).toContain(O.askedStep("Reports team"));
  expect(text(m.tree)).toContain(O.asked);
  expect(text(m.tree)).not.toContain(O.sent);
  expect(text(m.tree)).not.toContain(O.notSentTo("Reports team", "Microsoft Teams"));
  // A real send afterwards says Sent.
  (send.props.onSent as (at: string, how: string) => void)("2026-11-09T09:05:00Z", "sent");
  m.render();
  expect(text(m.tree)).toContain(O.sent);
});

it("after a 409 the card reloads what is on file", async () => {
  answer = "409";
  let reloaded = 0;
  const m = mount(OwnerQuestionCard as never, { q, onAnswered: () => reloaded++ } as never);
  const send = all(m.tree).find((e) => e.type === SendOwnerQuestion)!;
  const s = mount(SendOwnerQuestion as never, send.props as never);
  (button(s.tree, S.button("Reports team")).props.onClick as () => void)();
  await tick();
  s.render();
  expect(text(s.tree)).toContain(S.already("Reports team"));
  expect(reloaded).toBe(1);
});
