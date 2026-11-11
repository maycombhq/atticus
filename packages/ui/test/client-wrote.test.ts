import { afterEach, expect, it, vi } from "vitest";
import { api, onWrote, writtenOf } from "../src/api/client.js";

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

/**
 * Review of beta.24: a write that failed but wrote some files all the same (a 500 whose problem
 * names them, `written`) is heard too, and says which; one that wrote nothing isn't.
 */
it("a failed write that wrote some files is heard, with what it wrote", async () => {
  vi.stubGlobal("document", { querySelector: () => null });
  const problem = (written: unknown[]) =>
    new Response(
      JSON.stringify({
        type: "about:blank",
        title: "Atticus wrote only part of it",
        status: 500,
        written,
      }),
      { status: 500, headers: { "content-type": "application/problem+json" } },
    );
  const answers = [
    problem([{ repo: "forge-ledger", file: "facts/forge-ledger.corrections.jsonl" }]),
    problem([]),
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => answers.shift()!),
  );
  let heard = 0;
  const off = onWrote(() => void heard++);
  const e = await api("/api/links/corrections", { method: "POST", body: {} }).catch((x) => x);
  expect(writtenOf(e)).toEqual([
    { repo: "forge-ledger", file: "facts/forge-ledger.corrections.jsonl" },
  ]);
  expect(heard).toBe(1);
  const none = await api("/api/links/corrections", { method: "POST", body: {} }).catch((x) => x);
  expect(writtenOf(none)).toEqual([]);
  expect(heard).toBe(1);
  off();
});
