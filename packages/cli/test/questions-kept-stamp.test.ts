import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { startServer, type RunningServer } from "@maycombhq/server";
import { keepAnswersWhileWatched, whyWorkedOut } from "../src/watched-memo.js";

/**
 * beta.23: /api/questions is kept while the server follows the files, and its answers' checked
 * proposals read the code they cite in the base clones, which the server doesn't follow. Like
 * Map › Trust and the cockpit, it is worked out again once a checkout moves (checkoutsStamp).
 */
let stamp = "one";
vi.mock("../src/ui-api-trust.js", async (orig) => ({
  ...(await orig<typeof import("../src/ui-api-trust.js")>()),
  checkoutsStamp: vi.fn(async () => stamp),
}));
const { uiQuestionRoutes } = await import("../src/ui-api-questions.js");

let root: string;
let srv: RunningServer;
let unkeep: () => void;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-questions-kept-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  srv = await startServer({
    root,
    port: 0,
    user: "priya.nair",
    extend: (r, ctx) => uiQuestionRoutes(r, ctx),
  });
  unkeep = keepAnswersWhileWatched(root, () => true);
});
afterAll(async () => {
  unkeep?.();
  await srv?.close();
  await rm(root, { recursive: true, force: true });
});

const ask = async () => {
  const r = await fetch(`${srv.url}/api/questions`, { headers: { "X-Atticus-Token": srv.token } });
  expect(r.status).toBe(200);
};

it("is worked out again once a base clone's checkout moves, and kept while none does", async () => {
  whyWorkedOut();
  await ask();
  expect(whyWorkedOut().filter((w) => w.startsWith("questions?"))).toHaveLength(1);
  await ask();
  expect(whyWorkedOut().filter((w) => w.startsWith("questions?"))).toEqual([]);
  stamp = "two";
  await ask();
  expect(whyWorkedOut().filter((w) => w.startsWith("questions?"))).toEqual([
    expect.stringContaining("a checkout moved"),
  ]);
});
