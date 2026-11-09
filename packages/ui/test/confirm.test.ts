import { afterEach, expect, it, vi } from "vitest";

/**
 * Review round 48 (ADR 0186): a click on a write to a shared system asks the server for the
 * person's confirmation, with the page key the server put in the page, and sends it in the body.
 */
const asked: { path: string; body: unknown }[] = [];
vi.mock("../src/api/client.js", async () => ({
  ...(await vi.importActual<object>("../src/api/client.js")),
  api: async (path: string, o: { body: unknown }) => {
    asked.push({ path, body: o.body });
    return { confirmation: "c".repeat(43), write: "handoff", target: "x", expiresAt: "" };
  },
}));
const { confirmed, pageKey } = await import("../src/api/confirm.js");

afterEach(() => {
  vi.unstubAllGlobals();
  asked.length = 0;
});

it("asks for one write and target with the page's key, and gives { confirmation } for the body", async () => {
  vi.stubGlobal("document", {
    querySelector: (q: string) =>
      q === 'meta[name="atticus-page-key"]' ? { content: "page-key-from-the-server" } : null,
  });
  expect(pageKey()).toBe("page-key-from-the-server");
  expect(await confirmed("handoff", "add-transfer-limit")).toEqual({
    confirmation: "c".repeat(43),
  });
  expect(asked).toEqual([
    {
      path: "/api/confirmations",
      body: { write: "handoff", target: "add-transfer-limit", pageKey: "page-key-from-the-server" },
    },
  ]);
});

it("has no key where there is no page", () => {
  expect(pageKey()).toBe("");
});
