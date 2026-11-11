import { expect, it, vi } from "vitest";
import type { Api } from "@maycombhq/core";
import { all, mount, text } from "./support/hooks.js";

/**
 * Beta.25 (review of beta.24): on Map › Trust, a fix's preview is shown only under its own fix
 * (Ignore's plan, answering after the person chose Rename, is dropped, never shown under "Yes,
 * rename it"), and the write sends back the preview's stamp, so it is the one previewed.
 */
vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
const calls: { path: string; body: Record<string, unknown>; done: (r: unknown) => void }[] = [];
vi.mock("../src/api/client.js", () => ({
  api: (path: string, o: { body: Record<string, unknown> }) =>
    new Promise((done) => calls.push({ path, body: o.body, done })),
}));
const { AnswerBoxRow } = await import("../src/screens/map/AnswerBoxes.js");
const { COPY } = await import("../src/copy.js");
const B = COPY.trust.answerBoxes;

const BOX: Api.AnswerBoxT = {
  id: "ignore-this-its-cicd-related",
  name: "ignore this, its cicd related",
  profile: "org-pack/profiles/forge/profile.yaml",
  questions: [{ id: "q-1", repo: "forge-payments", question: "Which repo answers on x?" }],
};
const plan = (now: string, stamp: string): Api.AnswerBoxResultT => ({
  id: BOX.id,
  written: false,
  answers: [{ id: "q-1", repo: "forge-payments", was: BOX.id, now }],
  repos: ["forge-payments"],
  stamp,
});
const tick = () => new Promise((r) => setTimeout(r, 0));

it("drops Ignore's preview once Rename is chosen, and writes with the stamp previewed", async () => {
  const m = mount(AnswerBoxRow as never, { box: BOX } as never);
  const button = (label: string) =>
    all(m.tree).find((e) => e.type === "button" && e.props["aria-label"] === label);
  (button(B.ignoreOf(BOX.name))!.props.onClick as () => void)();
  m.render();
  (button(B.renameOf(BOX.name))!.props.onClick as () => void)();
  m.render();
  // Ignore's preview answers late.
  calls[0]!.done(plan("Ignore: it was", "aaaa"));
  await tick();
  m.render();
  expect(text(m.tree)).not.toContain(B.confirmRename);
  expect(text(m.tree)).not.toContain(B.confirmIgnore);

  // Rename's own preview, then the write, which carries its stamp.
  const input = all(m.tree).find((e) => e.type === "input");
  (input!.props.onChange as (e: unknown) => void)({ target: { value: "Northwind Hooks" } });
  m.render();
  const look = all(m.tree).find((e) => e.type === "button" && text(e) === B.preview);
  (look!.props.onClick as () => void)();
  m.render();
  calls[1]!.done(plan("northwind-hooks", "bbbb"));
  await tick();
  m.render();
  const yes = all(m.tree).find((e) => e.type === "button" && text(e) === B.confirmRename);
  expect(yes).toBeDefined();
  (yes!.props.onClick as () => void)();
  m.render();
  expect(calls[2]).toMatchObject({
    path: "/api/trust/answer-boxes/rename",
    body: { id: BOX.id, name: "Northwind Hooks", stamp: "bbbb" },
  });
  expect(calls[2]!.body.preview).toBeUndefined();
});
