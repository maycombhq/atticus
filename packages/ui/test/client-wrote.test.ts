import { afterEach, expect, it, vi } from "vitest";
import { api, onWrote } from "../src/api/client.js";

/** beta.23: every write the app makes is heard, so a page showing what waits reads it again. */
afterEach(() => vi.unstubAllGlobals());

const ok = () => {
  // No page here: the token's meta tag is read from a document that has none.
  vi.stubGlobal("document", { querySelector: () => null });
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    ),
  );
};

it("a POST is heard; a GET isn't", async () => {
  ok();
  let heard = 0;
  const off = onWrote(() => void heard++);
  await api("/api/x");
  expect(heard).toBe(0);
  await api("/api/facts/forge-ledger/corrections", { method: "POST", body: {} });
  expect(heard).toBe(1);
  off();
  await api("/api/x", { method: "POST", body: {} });
  expect(heard).toBe(1);
});
