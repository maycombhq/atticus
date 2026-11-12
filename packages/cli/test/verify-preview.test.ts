import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
import { confirmed } from "./seed-slots.js";

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

/** Every file under a folder with its text, by path from the root (Atticus's own `.atticus` state too). */
async function snapshot(dir: string, base = dir, out = new Map<string, string>()) {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
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

/**
 * The files a write changed, Atticus's own local state left out (the catalog's read cache under
 * `.atticus/`, and since ADR 0195 point 7 the build's undo copies under `.index/build-undo/`,
 * both git-ignored and never committed): the preview's add step names the rest.
 */
const changedFiles = (before: Map<string, string>, after: Map<string, string>) =>
  [...new Set([...before.keys(), ...after.keys()])].filter(
    (k) =>
      before.get(k) !== after.get(k) &&
      !k.split("/").includes(".atticus") &&
      !k.startsWith(".index/"),
  );

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-preview-"));
  await cp(join(FIX, "org-pack"), join(root, "org-pack"), { recursive: true });
  await cp(join(FIX, "facts"), join(root, "facts"), { recursive: true });
  for (const r of await readdir(join(FIX, "repos")))
    await cp(join(FIX, "repos", r), join(root, "workspace", r), { recursive: true });
  // The catalog as the estate has it: every repo written once. ADR 0195 point 2: the build joins
  // the facts slots only, which only a repo's own verify --write writes, so forge-notifications
  // (which forge-payments calls) is written too (beta.26's join read its live facts file).
  for (const r of ["forge-accounts", "forge-cards", "forge-notifications", "forge-payments"])
    expect(
      await confirmed(
        (io, allowRemovals) =>
          verifyCommand(
            root,
            r,
            { write: true, ...(allowRemovals !== undefined ? { allowRemovals } : {}) },
            io,
          ),
        quiet,
      ),
    ).toBe(0);
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
    it("reads a repo's contract files from its checkout as the write does: a Pact file it gained confirms the link in both", async () => {
      // forge-payments gains a Pact file for its debits call to forge-accounts since its last write.
      await mkdir(join(root, "workspace/forge-payments/pacts"), { recursive: true });
      await writeFile(
        join(root, "workspace/forge-payments/pacts/forge-payments-forge-accounts.json"),
        JSON.stringify(
          {
            consumer: { name: "forge-payments" },
            provider: { name: "forge-accounts" },
            interactions: [
              {
                description: "a debit",
                request: { method: "POST", path: "/accounts/ACC-1001/debits" },
                response: { status: 201 },
              },
            ],
            metadata: { pactSpecification: { version: "3.0.0" } },
          },
          null,
          2,
        ),
      );
      // No read cache on file: a preview that kept one would write it.
      await rm(join(root, ".atticus"), { recursive: true, force: true });
      const before = await snapshot(root);
      const r = await call("GET", "/api/facts/forge-payments/preview");
      expect(r.status).toBe(200);
      const p = Api.VerifyPreviewView.parse(r.body).preview!;
      // Nothing written, not even a cache file under .atticus.
      expect(await snapshot(root)).toEqual(before);
      expect(await verifyCommand(root, "forge-payments", { write: true }, quiet)).toBe(0);
      const changed = changedFiles(before, await snapshot(root));
      const catalog = changed.filter((k) => k.startsWith("catalog/generated/")).sort();
      // The link the Pact file confirms is a change the preview names, as the write makes it.
      expect(catalog.some((k) => k.startsWith("catalog/generated/interface/"))).toBe(true);
      expect(p.catalog!.files).toEqual(catalog);
      const add = Api.VerifyPreviewView.parse(r.body)
        .steps[2]!.command!.replace(/^git add /, "")
        .split(" ");
      expect(changed).toContain("facts/forge-payments.contracts.yaml");
      for (const k of changed)
        expect(
          add.some((a) => k === a || k.startsWith(`${a}/`)),
          `${k} changed but isn't added`,
        ).toBe(true);
      const iface = catalog.find((k) => k.startsWith("catalog/generated/interface/"))!;
      expect(await readFile(join(root, iface), "utf8")).toMatch(/confirmed-by-contract/);
    });

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
        `git commit -m "forge-payments: a correction by a person of call.post.accounts-id-debits, applied by atticus verify --write"`,
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
      // ADR 0195 point 4: the corrected call's link to forge-accounts (and the feature it made)
      // leave the catalog, 2 of forge-accounts's 13 records: a large removal, explained by the
      // correction, which waits for its count. Confirmed as a person would.
      expect(
        await confirmed(
          (io, allowRemovals) =>
            verifyCommand(
              root,
              "forge-payments",
              { write: true, ...(allowRemovals !== undefined ? { allowRemovals } : {}) },
              io,
            ),
          quiet,
        ),
      ).toBe(0);
      const after = await snapshot(root);
      const changed = changedFiles(before, after);
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

    // WAITS FOR CS2: the preview lists the dropped fact, but its links come out empty (no link
    // added, removed or unmade) while the catalog still has payments-api's POST /notifications
    // Interface: the preview's build doesn't put the corrected facts in place of the repo's
    // facts snapshot. Turns green when previewWrite builds with the facts the write would
    // snapshot (packages/cli/src/verify-preview.ts).
    it.fails("says a fact marked wrong is dropped", async () => {
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
      // ADR 0195 point 10, "links are live": no derived arrow outlives its caller. beta.26's
      // incremental write kept the Interface, held by the callee's side, as a link unmade; the
      // build makes the estate's links from the facts slots alone, so the link is removed.
      expect(v.preview!.links!.removed).toEqual([
        expect.objectContaining({ from: "payments-api", method: "POST", path: "/notifications" }),
      ]);
      expect(v.preview!.links!.unmade).toEqual([]);
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
