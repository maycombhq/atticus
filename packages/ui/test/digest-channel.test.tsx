import { afterEach, expect, it, vi } from "vitest";
import { all, mount } from "./support/hooks.js";

/**
 * Review round 50 (ADR 0186): Send it to me posts a message as the person, so its button names
 * where it posts, and the person's confirmation is for that channel: one for another channel (set
 * since the button showed it) sends nothing.
 */
vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});
const posted: { path: string; body: unknown }[] = [];
vi.mock("../src/api/client.js", async () => ({
  ...(await vi.importActual<object>("../src/api/client.js")),
  api: async (path: string, o: { body: unknown }) => {
    posted.push({ path, body: o.body });
    if (path === "/api/confirmations") return { confirmation: "c".repeat(43) };
    return { title: "Atticus: nothing waits on you", lines: [] };
  },
}));
const { DigestButtons } = await import("../src/screens/CommandCenter.js");
const { COPY } = await import("../src/copy.js");
const T = COPY.commandCenter;
type El = { type: unknown; props: Record<string, unknown> };
const text = (e: El) => JSON.stringify(e.props.children ?? "");

afterEach(() => {
  posted.length = 0;
});

it("names the channel on the button and confirms that channel", async () => {
  const m = mount(DigestButtons as never, { to: "#dana-updates" } as never);
  const send = all(m.tree).find(
    (e) => e.type === "button" && text(e).includes(T.sendItTo("#dana-updates")),
  )!;
  expect(send).toBeDefined();
  (send.props.onClick as () => void)();
  await new Promise((r) => setTimeout(r, 0));
  expect(posted).toEqual([
    {
      path: "/api/confirmations",
      body: { write: "digest-send", target: "#dana-updates", pageKey: "" },
    },
    { path: "/api/me/digest", body: { send: true, confirmation: "c".repeat(43) } },
  ]);
});

it("an older server that names no channel keeps its button and its target", async () => {
  const m = mount(DigestButtons as never, {} as never);
  const send = all(m.tree).find((e) => e.type === "button" && text(e).includes(T.sendItToMe))!;
  (send.props.onClick as () => void)();
  await new Promise((r) => setTimeout(r, 0));
  expect(posted[0]).toEqual({
    path: "/api/confirmations",
    body: { write: "digest-send", target: "me", pageKey: "" },
  });
});
