import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "@maycombhq/server";
import { uiDocumentRoutes } from "../src/ui-api-documents.js";

/**
 * General knowledge as files through the local API (ADR 0122): the Documents tab's list, adding
 * a file to inputs/inbox/, and copying a change's file there. Invented Forge files only.
 */

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
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-ui-documents-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  await writeFile(
    join(root, "org-pack", "runtime.yaml"),
    "schemaVersion: 1\nassistants: { allowed: [copilot], default: copilot }\n",
  );
  await mkdir(join(root, "inputs"), { recursive: true });
  await writeFile(
    join(root, "inputs", "forge-pay-runbook.txt"),
    "Forge Pay runbook\n\nRetry twice.\n",
  );
  srv = await startServer({
    root,
    port: 0,
    user: "priya.nair",
    watch: false,
    extend: (r, ctx) => uiDocumentRoutes(r, ctx),
  });
});
afterAll(() => srv?.close());

describe("the Documents API (ADR 0122)", () => {
  it("lists the files in inputs/, not read until a sync", async () => {
    const r = await call("GET", "/api/knowledge/documents");
    expect(r.status).toBe(200);
    expect(r.body.snapshot).toBeNull();
    expect(r.body.documents).toEqual([
      expect.objectContaining({
        path: "inputs/forge-pay-runbook.txt",
        state: "not-synced",
        inbox: false,
      }),
    ]);
  });

  it("adds a file to inputs/inbox/, and refuses the same bytes twice", async () => {
    const add = await call("POST", "/api/knowledge/documents", {
      name: "ledger-limits.md",
      content: b64("# Limits\n\nThe ledger owns every limit.\n"),
    });
    expect(add.status).toBe(201);
    expect(add.body.added).toEqual([
      { name: "ledger-limits.md", path: "inputs/inbox/ledger-limits.md", kind: "document" },
    ]);
    expect(await readFile(join(root, "inputs", "inbox", "ledger-limits.md"), "utf8")).toContain(
      "owns every limit",
    );
    const again = await call("POST", "/api/knowledge/documents", {
      name: "copy.md",
      content: b64("# Limits\n\nThe ledger owns every limit.\n"),
    });
    expect(again.status).toBe(422);
    expect(JSON.stringify(again.body)).toMatch(/already in inputs/);
  });

  it("says when a change to promote from isn't there", async () => {
    const r = await call("POST", "/api/changes/no-such-change/inputs/x.md/promote");
    expect(r.status).toBe(404);
  });
});
