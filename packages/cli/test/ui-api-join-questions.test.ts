import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Api,
  HOSTS_OUTSIDE_VENDOR,
  JOIN_IGNORE_LABEL,
  parseFacts,
  TARGETS_STEP_ID,
} from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { projectFactsIntoCatalog } from "../src/map-render-commands.js";
import { uiQuestionRoutes } from "../src/ui-api-questions.js";
import { verifyCommand } from "../src/verify-commands.js";
import { confirmed } from "./seed-slots.js";

/**
 * Beta.24 review: the join's question about a gateway's token target URL is on the app's
 * Questions page and Home's waiting list (both read GET /api/questions?state=open) with its words
 * and options, and answering it there (POST /api/questions/{id}/answer) changes the next Apply's
 * map. On the invented Forge estate of fixtures/gateway-facts/join-questions; no network.
 */

const FIX = join(__dirname, "..", "..", "..", "fixtures", "gateway-facts", "join-questions");
const COMMIT: Record<string, string> = {
  "forge-fx-v1": "7777aaa",
  "forge-fx-v1-canary": "6666aaa",
  "northwind_rates_1-0": "9999aaa",
  "forge-teller": "5555aaa",
};
const PROXY = "northwind_rates_1-0";
const AT = new Date("2026-11-10T10:00:00.000Z");

let root: string;
let srv: RunningServer;

const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(srv.url + path, {
    method,
    headers: { "X-Atticus-Token": srv.token, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

async function apply(repo: string): Promise<string[]> {
  const out: string[] = [];
  // ADR 0195 point 4 and the owner's third answer: an answer that joins a call explains the
  // Unresolved record it removes; above 10% of a repo's records the write waits for the count
  // it lists, confirmed as a person would (the app's confirm step is CS3's).
  const code = await confirmed(
    (io, allowRemovals) =>
      verifyCommand(
        root,
        repo,
        {
          commit: COMMIT[repo]!,
          dir: join(root, "workspace", repo),
          write: true,
          now: () => AT,
          ...(allowRemovals !== undefined ? { allowRemovals } : {}),
        },
        io,
      ),
    { out: (l) => out.push(l), err: (l) => out.push(`ERR ${l}`) },
  );
  expect(code, out.join("\n")).toBe(0);
  return out;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "atticus-ui-join-questions-"));
  cpSync(join(FIX, "org-pack"), join(root, "org-pack"), { recursive: true });
  mkdirSync(join(root, "facts"), { recursive: true });
  for (const r of Object.keys(COMMIT)) {
    cpSync(join(FIX, "repos", r), join(root, "workspace", r), { recursive: true });
    writeFileSync(
      join(root, "facts", `${r}.jsonl`),
      readFileSync(join(FIX, "facts", `${r}.jsonl`), "utf8"),
    );
  }
  for (const r of Object.keys(COMMIT)) await apply(r);
  srv = await startServer({
    root,
    port: 0,
    user: "priya.nair",
    extend: (r, ctx) => uiQuestionRoutes(r, ctx),
  });
}, 60_000);
afterAll(() => {
  srv?.close();
  rmSync(root, { recursive: true, force: true });
});

describe("the join's questions in the app (beta.24 review)", () => {
  it("lists the token's question with its words and options, and takes its answer", async () => {
    const open = Api.QuestionList.parse((await call("GET", "/api/questions?state=open")).body);
    const q = open.questions.find((x) => x.askedBy.step === TARGETS_STEP_ID && x.repo === PROXY)!;
    expect(q.question).toMatch(/^Which repo answers on @targetVendorUrl@\? /);
    expect(q.question).toMatch(/read northwind_rates_1-0 again with your assistant/);
    const labels = q.options.map((o) => o.label);
    expect(labels).toContain(HOSTS_OUTSIDE_VENDOR);
    expect(labels.at(-1)).toBe(JOIN_IGNORE_LABEL);
    // Home's waiting list counts it with the others the join asks.
    expect(open.counts!.open).toBe(3);

    const r = await call("POST", `/api/questions/${q.id}/answer`, {
      option: labels.indexOf(HOSTS_OUTSIDE_VENDOR) + 1,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const after = Api.QuestionList.parse((await call("GET", "/api/questions?state=open")).body);
    expect(after.questions.some((x) => x.id === q.id)).toBe(false);

    // The next Apply sends the token's call to the vendor named by it.
    await apply(PROXY);
    const facts = parseFacts(readFileSync(join(root, "facts", `${PROXY}.jsonl`), "utf8"));
    if (!facts.ok) throw new Error("facts don't parse");
    const p = await projectFactsIntoCatalog(root, PROXY, facts.facts);
    expect(p.result.join!.asks).toEqual([]);
    expect(p.result.join!.outside?.map((o) => o.target)).toEqual(["targetvendorurl"]);
  }, 60_000);
});
