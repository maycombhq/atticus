import { expect, it, vi } from "vitest";
import { all, mount, text } from "./support/hooks.js";

/**
 * Sixth UX walk: Home offers Apply before Propose only while a repo's corrections are newer than
 * its last Apply (the server's applyFirst), and after Push the pending lines go, leaving what
 * the push said.
 */
vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
let applyFirst: string[] | undefined = [];
let reloads = 0;
vi.mock("../src/api/client.js", async () => ({
  ...(await vi.importActual<object>("../src/api/client.js")),
  useApi: () => ({
    state: "ready",
    data: {
      scope: "work",
      files: [
        { path: "facts/forge-card-vault.corrections.jsonl", status: "??" },
        { path: "facts/forge-card-vault.jsonl", status: "M" },
      ],
      branch: "propose/work/2026-11-08-ada",
      title: "Changes made in the Atticus app",
      ...(applyFirst ? { applyFirst } : {}),
    },
    reload: () => void reloads++,
  }),
}));
const { COPY } = await import("../src/copy.js");
const { ApplyAndPropose, PendingProposals, Propose } = await import("../src/app/propose.js");
const P = COPY.propose;

it("offers no Apply once Apply ran after the corrections", () => {
  applyFirst = [];
  const m = mount(PendingProposals as never, {} as never);
  expect(text(m.tree)).toContain(P.pending(2));
  expect(text(m.tree)).not.toContain(P.applyFirst);
  expect(all(m.tree).some((e) => e.type === ApplyAndPropose)).toBe(false);
});

it("offers Apply for a repo whose corrections are newer than its last Apply", () => {
  applyFirst = ["forge-card-vault"];
  const m = mount(PendingProposals as never, {} as never);
  expect(text(m.tree)).toContain(P.applyFirst);
  expect(all(m.tree).find((e) => e.type === ApplyAndPropose)?.props.repo).toBe("forge-card-vault");
});

it("an older server without applyFirst still asks for Apply on a corrections file", () => {
  applyFirst = undefined;
  const m = mount(PendingProposals as never, {} as never);
  expect(all(m.tree).some((e) => e.type === ApplyAndPropose)).toBe(true);
});

it("after Push, the pending lines go and the list is read again", () => {
  applyFirst = ["forge-card-vault"];
  reloads = 0;
  const m = mount(PendingProposals as never, {} as never);
  const propose = all(m.tree).find((e) => e.type === Propose)!;
  (propose.props.onDone as () => void)();
  m.render();
  expect(text(m.tree)).not.toContain(P.pending(2));
  expect(text(m.tree)).not.toContain(P.applyFirst);
  expect(all(m.tree).some((e) => e.type === Propose)).toBe(true);
  expect(reloads).toBe(1);
});
