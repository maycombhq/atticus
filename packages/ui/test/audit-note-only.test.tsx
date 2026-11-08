import { expect, it, vi } from "vitest";
import { Api } from "@maycombhq/core";
import { all, mount } from "./support/hooks.js";

/** Review round 32: editing only the note of an item answered before saves it with that answer. */
vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
const { AuditAnswerForm } = await import("../src/screens/map/AuditAnswer.js");

const SAMPLE = Api.AuditSampleView.parse({
  repo: "forge-payments",
  file: "facts/forge-payments.audit.yaml",
  seed: "s1",
  size: 1,
  defaultSeed: "forge-payments@c3c0006",
  command: "atticus verify audit forge-payments --seed s1 --size 1",
  items: [
    {
      id: "link:call.post.notifications",
      kind: "link",
      of: "joined-by-host",
      claim: "forge-payments POST /notifications → forge-notifications",
      cites: ["forge-payments src/main/java/forge/payments/PaymentsService.java:27"],
      fact: "call.post.notifications",
      to: "forge-notifications",
      answer: "right",
      by: "Priya Nair",
      note: "old",
      lines: [{ cite: "forge-payments src/main/java/forge/payments/PaymentsService.java:27" }],
    },
  ],
});

it("keeps the answer on file when only the note changed", () => {
  let saved: unknown;
  const m = mount(
    AuditAnswerForm as never,
    {
      repo: "forge-payments",
      sample: { state: "ready", data: SAMPLE },
      picks: { "link:call.post.notifications": { note: "checked the host" } },
      onPick: () => undefined,
      saving: { state: "idle" },
      onSave: (a: unknown) => (saved = a),
    } as never,
  );
  const save = all(m.tree).find((e) => e.type === "button" && e.props.className === "btn primary");
  (save!.props.onClick as () => void)();
  expect(saved).toEqual([
    { id: "link:call.post.notifications", answer: "right", note: "checked the host" },
  ]);
});
