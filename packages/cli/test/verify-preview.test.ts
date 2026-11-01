import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { uiFactsRoutes } from "../src/ui-api-facts.js";
import { verifyCommand } from "../src/verify-commands.js";
import { prCommand } from "../src/verify-preview.js";

/**
 * Corrections without git commands (plan item C4, ADR 0149): after a correction the app writes,
 * GET /api/facts/{repo}/preview gives the commands to run (the app runs none) and what the next
 * `atticus verify <repo> --write` will change, worked out by that command's own functions without
 * writing. Checked against the write itself: the files the preview names are the files it changes.
 * On the invented Forge estate of fixtures/link-estate; no git runs and nothing reaches the network.
 */

const FIX = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/link-estate");
const NOW = new Date("2026-11-01T10:00:00Z");
const PERSON = "Priya Nair <priya@forge.example>";
const quiet = { out: () => undefined, err: () => undefined };

let srv: RunningServer;
let root: string;

const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(srv.url + path, {
    method,
    headers: { "X-Atticus-Token": srv.token, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

/** Every file under a folder with its text, by path from the root. */
async function snapshot(dir: string, base = dir, out = new Map<string, string>()) {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    // Atticus's own local state (the catalog's read cache), never committed.
    if (e.name === ".atticus") continue;
    if (e.isDirectory()) await snapshot(p, base, out);
    else
      out.set(
        p
          .slice(base.length + 1)
          .split("\\")
          .join("/"),
        await readFile(p, "utf8"),
      );
  }
  return out;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-preview-"));
  await cp(join(FIX, "org-pack"), join(root, "org-pack"), { recursive: true });
  await cp(join(FIX, "facts"), join(root, "facts"), { recursive: true });
  for (const r of await readdir(join(FIX, "repos")))
    await cp(join(FIX, "repos", r), join(root, "workspace", r), { recursive: true });
  // The catalog as the estate has it: every repo written once.
  for (const r of ["forge-accounts", "forge-cards", "forge-payments"])
    expect(await verifyCommand(root, r, { write: true }, quiet)).toBe(0);
  srv = await startServer({
    root,
    port: 0,
    user: PERSON,
    extend: (r, ctx) => uiFactsRoutes(r, ctx, { now: () => NOW }),
  });
}, 120_000);
afterAll(() => srv?.close());

describe(
  "after a correction: the commands, and what verify --write will change",
  { timeout: 60_000 },
  () => {
    it("gives the line written, then a preview of the write that matches the write itself", async () => {
      const posted = await call("POST", "/api/facts/forge-payments/corrections", {
        fact: "call.post.accounts-id-debits",
        action: "edit",
        set: { to: "forge-cards" },
        reason: "the debits go to the cards ledger",
      });
      expect(posted.status).toBe(200);
      const res = Api.FactCorrectionResult.parse(posted.body);
      const file = await readFile(join(root, "facts/forge-payments.corrections.jsonl"), "utf8");
      // The line the app wrote, exactly as written: the only file it touched.
      expect(file).toBe(`${res.line}\n`);

      const before = await snapshot(root);
      const r = await call(
        "GET",
        "/api/facts/forge-payments/preview?fact=call.post.accounts-id-debits",
      );
      expect(r.status).toBe(200);
      const v = Api.VerifyPreviewView.parse(r.body);
      // The preview wrote nothing.
      expect(await snapshot(root)).toEqual(before);

      expect(v.wrote).toBe("facts/forge-payments.corrections.jsonl");
      expect(v.branch).toBe("correct/forge-payments-call.post.accounts-id-debits");
      expect(v.steps.map((s) => s.step)).toEqual([
        "verify",
        "branch",
        "add",
        "commit",
        "push",
        "pr",
      ]);
      expect(v.steps[0]!.command).toBe("atticus verify forge-payments --write");
      expect(v.steps[1]!.command).toBe(
        "git switch -c correct/forge-payments-call.post.accounts-id-debits",
      );
      expect(v.steps[3]!.command).toBe(
        `git commit -m "forge-payments: a person's correction of call.post.accounts-id-debits, applied by atticus verify --write"`,
      );
      expect(v.steps[4]!.command).toBe(
        "git push -u origin correct/forge-payments-call.post.accounts-id-debits",
      );
      // No Git host in the org pack: the pull request is opened by hand.
      expect(v.steps[5]!.command).toBeUndefined();

      const p = v.preview!;
      expect(p.facts.dropped).toEqual([]);
      expect(p.facts.edited).toEqual([
        expect.objectContaining({
          id: "call.post.accounts-id-debits",
          fields: [{ name: "to", now: "forge-cards" }],
        }),
      ]);
      expect(p.blocked).toBeUndefined();
      // The call no longer reaches forge-accounts: the link moves.
      expect(p.links!.moved).toEqual([
        expect.objectContaining({ from: "payments-api", method: "POST", to: "forge-cards" }),
      ]);
      expect(p.links!.moved[0]!.was).toMatch(/accounts/);
      expect(p.links!.added).toEqual([]);
      expect(p.links!.unmade).toEqual([]);

      // The write itself: every file it changes is one the add step names (or under a folder it names).
      expect(await verifyCommand(root, "forge-payments", { write: true }, quiet)).toBe(0);
      const after = await snapshot(root);
      const changed = [...new Set([...before.keys(), ...after.keys()])].filter(
        (k) => before.get(k) !== after.get(k),
      );
      const add = v.steps[2]!.command!.replace(/^git add /, "").split(" ");
      expect(add[0]).toBe("facts/forge-payments.corrections.jsonl");
      for (const k of changed)
        expect(
          add.some((a) => k === a || k.startsWith(`${a}/`)),
          `${k} changed but isn't added`,
        ).toBe(true);
      // And the catalog files it names are the ones that changed.
      const catalog = changed.filter((k) => k.startsWith("catalog/generated/")).sort();
      expect(p.catalog!.files).toEqual(catalog);
    });

    it("says a fact marked wrong is dropped", async () => {
      expect(
        (
          await call("POST", "/api/facts/forge-payments/corrections", {
            fact: "call.post.notifications",
            action: "wrong",
            reason: "notifications are sent by the event bus",
          })
        ).status,
      ).toBe(200);
      const v = Api.VerifyPreviewView.parse(
        (await call("GET", "/api/facts/forge-payments/preview")).body,
      );
      expect(v.branch).toBe("correct/forge-payments");
      expect(v.preview!.facts.dropped).toEqual([
        expect.objectContaining({ id: "call.post.notifications", why: "wrong" }),
      ]);
      // The record stays, held by the callee's side, but forge-payments no longer makes the link.
      expect(v.preview!.links!.unmade).toEqual([
        expect.objectContaining({ from: "payments-api", method: "POST", path: "/notifications" }),
      ]);
    });

    it("still gives the commands when there is no checkout, and 404 for a repo with no facts", async () => {
      await rm(join(root, "workspace/forge-cards"), { recursive: true, force: true });
      const v = Api.VerifyPreviewView.parse(
        (await call("GET", "/api/facts/forge-cards/preview")).body,
      );
      expect(v.unavailable).toBe("no-checkout");
      expect(v.preview).toBeUndefined();
      expect(v.steps[0]!.command).toBe("atticus verify forge-cards --write");
      expect(existsSync(join(root, "facts/forge-cards.corrections.jsonl"))).toBe(false);
      expect((await call("GET", "/api/facts/forge-nothing/preview")).status).toBe(404);
      expect((await call("GET", "/api/facts/..%2Fx/preview")).status).toBe(400);
    });

    it("names the pull request command of the Git host the org pack sets", () => {
      expect(prCommand("github", "correct/x")).toBe("gh pr create --fill --head correct/x");
      expect(prCommand("gitlab", "correct/x")).toBe(
        "glab mr create --fill --source-branch correct/x",
      );
      expect(prCommand("azure-repos", "correct/x")).toBe(
        "az repos pr create --source-branch correct/x",
      );
      expect(prCommand("bitbucket", "correct/x")).toBeUndefined();
      expect(prCommand(undefined, "correct/x")).toBeUndefined();
    });
  },
);
