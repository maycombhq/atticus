import { expect, it, vi } from "vitest";
import { all, mount, text } from "./support/hooks.js";

/**
 * ADR 0195 point 3, the review: a dismissal sends the hash of the readers' value the page showed
 * (the server dismisses that value or nothing), and a promote that refused itself is said as the
 * promote's refusal, not as verify stopping after a fact was written.
 */
vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
vi.mock("../src/api/client.js", () => ({
  api: () => Promise.reject(new Error("no call")),
  ApiError: class extends Error {},
  useApi: () => ({ state: "loading" }),
  useReloadOnFiles: () => undefined,
}));
const { ItemAction } = await import("../src/screens/map/CrossCheck.js");
const { ConfirmDialog } = await import("../src/screens/setup/CatalogBuild.js");
const { JobFailed } = await import("../src/app/job.js");
const { COPY } = await import("../src/copy.js");
const X = COPY.crossCheck;
const tick = () => new Promise((r) => setTimeout(r, 0));
const SHA = "a".repeat(64);
const item = {
  key: "Endpoint|GET /accounts/{}/balance",
  kind: "Endpoint",
  state: "readers-only" as const,
  readers: { value: { method: "GET", path: "/accounts/{id}/balance" }, cites: [] },
  readersSha256: SHA,
};

it("dismisses with the hash of the readers' value shown", async () => {
  const ran: unknown[][] = [];
  const m = mount(
    ItemAction as never,
    {
      repo: "forge-ledger",
      item,
      run: async (...a: unknown[]) => {
        ran.push(a);
        return { lines: [] };
      },
      onDone: () => undefined,
    } as never,
  );
  const dismiss = all(m.tree).find((e) => e.type === "button" && text(e) === X.dismiss)!;
  (dismiss.props.onClick as () => void)();
  await tick();
  expect(ran).toEqual([["forge-ledger", item.key, false, SHA]]);
});

it("says a promote that refused itself as the promote's refusal, and nothing as promoted", async () => {
  const done: string[] = [];
  const m = mount(
    ItemAction as never,
    {
      repo: "forge-ledger",
      item,
      run: async () => ({ lines: [] }),
      steps: {
        preview: async () => ({ repo: "forge-ledger", key: item.key, can: true, sha256: SHA }),
        promote: () =>
          Promise.reject(
            new JobFailed(
              "refused",
              ["forge-ledger: the fact promoting it isn't the one previewed any more."],
              undefined,
              3,
            ),
          ),
      },
      onDone: (n: string) => done.push(n),
    } as never,
  );
  const promote = all(m.tree).find((e) => e.type === "button" && text(e) === X.promote)!;
  (promote.props.onClick as () => void)();
  await tick();
  m.render();
  const dialog = all(m.tree).find((e) => e.type === ConfirmDialog)!;
  await (dialog.props.onConfirm as () => Promise<void>)();
  m.render();
  expect(text(m.tree)).toContain(
    X.promoteRefused("forge-ledger: the fact promoting it isn't the one previewed any more."),
  );
  expect(done).toEqual([]);
});
