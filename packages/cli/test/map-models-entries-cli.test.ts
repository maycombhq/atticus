import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { mapCommand } from "../src/map-commands.js";
import { loadReadPlan } from "../src/map-parts.js";
import { main } from "../src/main.js";
import { verifyCommand } from "../src/verify-commands.js";

/**
 * ADR 0170: `--models entries`, the model classes the repo's own entry points reach read first,
 * and those only an outbound client reaches left out as notReached with that reason, so the
 * gateway-to-service payload check needs few parts. `reachable` stays the default. On the
 * invented forge-gate service (fixtures/reachable/forge-gate): a controller using 2 classes and
 * a client using 6 others. Files only, no network.
 */

const FIX = join(__dirname, "..", "..", "..", "fixtures", "reachable");
const REPO = "forge-gate";
const COMMIT = "0123abc";
const M = "src/main/java/forge/gate/model";
const ENTRY = ["TransferRequest", "TransferResponse"].map((n) => `${M}/${n}.java`);
const CLIENT = [
  "LedgerAmount",
  "LedgerError",
  "LedgerFee",
  "LedgerParty",
  "LedgerPostRequest",
  "LedgerPostResponse",
].map((n) => `${M}/${n}.java`);

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
function adopted(): string {
  const root = mkdtempSync(join(tmpdir(), "atticus-entries-"));
  temps.push(root);
  cpSync(join(FIX, REPO), root, { recursive: true });
  mkdirSync(join(root, ".atticus", "org-pack"), { recursive: true });
  return root;
}
const io = () => {
  const out: string[] = [];
  return {
    out,
    text: () => out.join("\n"),
    io: { out: (l: string) => out.push(l), err: (l: string) => out.push(`ERR ${l}`) },
  };
};
const estimate = async (root: string, more: Parameters<typeof mapCommand>[2] = {}) => {
  const o = io();
  expect(
    await mapCommand(root, REPO, { estimate: true, commit: COMMIT, ...more }, o.io),
    o.text(),
  ).toBe(0);
  return o;
};

describe("atticus map <repo> --models entries (ADR 0170)", () => {
  it("by default (reachable) reads all eight: the client's classes are reached too", async () => {
    const root = adopted();
    const t = (await estimate(root)).text();
    expect(t).toMatch(/Model classes \(ADR 0169\): 8; 8 reached from the entry points and calls/);
    expect((await loadReadPlan(root, REPO))?.notReached).toBeUndefined();
  });

  it("reads the controller's two and leaves the client's six as reached only from an outbound client", async () => {
    const root = adopted();
    const t = (await estimate(root, { models: "entries" })).text();
    expect(t).toContain(
      "Model classes (ADR 0169): 8; 2 reached from the entry points, read after them; 6 reached only from an outbound client, left out: atticus map forge-gate --models reachable reads them.",
    );
    expect(t).toContain("Reached only from an outbound client (left out; don't read them):");
    const plan = (await loadReadPlan(root, REPO))!;
    expect(plan.models).toBe("entries");
    expect(plan.notReached?.files).toEqual(CLIENT);
    expect(plan.notReached?.clientOnly).toEqual({
      why: "reached only from an outbound client; --models reachable reads them",
      files: CLIENT,
    });
    expect(plan.estimate?.files).toBe(12 - CLIENT.length);
    // Fewer tokens to read than reachable takes: the payload check needs fewer parts.
    const all = adopted();
    await estimate(all);
    expect(plan.estimate!.tokens).toBeLessThan((await loadReadPlan(all, REPO))!.estimate!.tokens);
    const j = JSON.parse((await estimate(root, { models: "entries", json: true })).text());
    expect(j.models.mode).toBe("entries");
    expect(j.models.roots).toEqual(["src/main/java/forge/gate/api/TransferController.java"]);
    expect(j.models.reached.map((x: { path: string }) => x.path)).toEqual(ENTRY);
    expect(j.models.notReached).toEqual(CLIENT);
    // The mode is kept in the read plan: the next estimate keeps it, and reachable reads them.
    expect((await estimate(root)).text()).toContain("6 reached only from an outbound client");
    const back = (await estimate(root, { models: "reachable" })).text();
    expect(back).toMatch(/8 reached from the entry points and calls/);
    expect((await loadReadPlan(root, REPO))?.models).toBeUndefined();
  });

  it("verify counts the client's classes apart and says what reads them", async () => {
    const root = adopted();
    await estimate(root, { models: "entries" });
    writeFileSync(
      join(root, ".atticus", "facts", `${REPO}.jsonl`),
      `${JSON.stringify({
        kind: "entry",
        id: "entry.post.transfers",
        repo: REPO,
        commit: COMMIT,
        entryType: "rest",
        method: "POST",
        path: "/transfers",
        cite: {
          file: "src/main/java/forge/gate/api/TransferController.java",
          line: 9,
          value: "/transfers",
        },
      })}\n`,
    );
    const o = io();
    await verifyCommand(root, REPO, { commit: COMMIT }, o.io);
    expect(o.text()).toMatch(
      /0 rejected; coverage \d+% \(1 read, \d+ unknown, 6 model files no entry or call reaches\)/,
    );
    expect(o.text()).toContain(
      "6 model files only an outbound client reaches; atticus map forge-gate --models reachable reads them.",
    );
  });

  it("takes --models entries on the command line, and refuses a mode it doesn't know", async () => {
    const root = adopted();
    const out: string[] = [];
    const run = (args: string[]) =>
      main(
        [...args, "--root", root],
        { out: (l) => out.push(l), err: (l) => out.push(`ERR ${l}`) },
        { quiet: true },
      );
    expect(await run(["map", REPO, "--estimate", "--commit", COMMIT, "--models", "entries"])).toBe(
      0,
    );
    expect(out.join("\n")).toContain("6 reached only from an outbound client");
    out.length = 0;
    expect(await run(["map", REPO, "--estimate", "--models", "some"])).toBe(2);
    expect(out).toEqual(["ERR --models is entries, reachable or all (got some)."]);
  });
});
