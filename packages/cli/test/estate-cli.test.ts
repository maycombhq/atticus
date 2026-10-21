import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { EstateJoins, parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { estateFlowCommand, estateJoin, estateLineage } from "../src/estate-commands.js";

const ESTATE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/estate");
const T = new Date("2026-10-21T12:00:00Z");

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
};

/** A metarepo with the fixture catalog, the two repos cloned in workspace/, and their specs. */
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "atticus-estate-cli-"));
  for (const r of parse(await readFile(join(ESTATE, "catalog.yaml"), "utf8")) as unknown[]) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(JSON.stringify(p.issues));
    const file = join(root, "catalog", "generated", recordPath(p.record));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, serializeRecord(p.record));
  }
  await cp(join(ESTATE, "org-pack"), join(root, "org-pack"), { recursive: true });
  for (const repo of ["forge-web", "forge-customers"]) {
    await cp(join(ESTATE, "repos", repo), join(root, "workspace", repo), { recursive: true });
    await cp(join(ESTATE, "specs", repo), join(root, "specs", repo), { recursive: true });
  }
  return root;
}

describe("atticus estate join, flow and lineage (ADR 0085)", () => {
  it("joins the call-outs, writes specs/estate.yaml and says why the others aren't joined", async () => {
    const root = await setup();
    const j = io();
    expect(await estateJoin(root, { now: T }, j.io)).toBe(0);
    expect(j.err).toEqual([]);
    expect(j.out).toEqual([
      "Joined 2 of 4 call-outs across 2 repos (forge-customers, forge-web); written to specs/estate.yaml.",
      "  forge-web.save-customer step 1 → forge-customers.create-customer (through the Interface if-c74e2fa3c8152a13)",
      "  forge-web.view-customer step 1 → forge-customers.get-customer (by method and path)",
      "2 call-outs aren't joined:",
      "  forge-web.remove-customer step 1 (no flow): DELETE /api/customers/{id} reaches forge-customers.delete-customer, but no flow of forge-customers starts there",
      "  forge-web.view-customer step 2 (no target): forge-customers has no entry point for GET /api/customers/{id}/points, and no Interface from forge-web reaches it",
      "Next: atticus estate flow <flow-id> follows a flow across repos.",
    ]);
    const written = EstateJoins.parse(
      parse(await readFile(join(root, "specs", "estate.yaml"), "utf8")),
    );
    const want = EstateJoins.parse(
      parse(await readFile(join(ESTATE, "expected", "estate.yaml"), "utf8")),
    );
    expect(written).toEqual(want);
  });

  it("checks the cited lines in the clones, and says which repos it couldn't check", async () => {
    const root = await setup();
    // The API's controller lost its lines: the create join has no citation at its callee end.
    await writeFile(
      join(
        root,
        "workspace",
        "forge-customers",
        "src",
        "main",
        "java",
        "forge",
        "customers",
        "CustomerController.java",
      ),
      "package forge.customers;\n",
    );
    const j = io();
    expect(await estateJoin(root, { now: T, json: true }, j.io)).toBe(0);
    const r = JSON.parse(j.out.join("\n")) as EstateJoins & { unchecked: string[] };
    expect(r.joins).toEqual([]);
    expect(r.unmatched.filter((u) => u.reason === "no-citation").map((u) => u.from.flow)).toEqual([
      "forge-web.save-customer",
      "forge-web.view-customer",
    ]);
    await rm(join(root, "workspace", "forge-customers"), { recursive: true });
    const k = io();
    await estateJoin(root, { now: T }, k.io);
    expect(k.out).toContain(
      "Cited lines of forge-customers weren't checked: there is no clone of it here.",
    );
  });

  it("prints a flow across repos with the data at each crossing", async () => {
    const root = await setup();
    const none = io();
    expect(await estateFlowCommand(root, "forge-web.save-customer", {}, none.io)).toBe(2);
    expect(none.err).toEqual([
      "There is no specs/estate.yaml yet. Join the repos' flows first: atticus estate join.",
    ]);
    await estateJoin(root, { now: T }, io().io);
    const f = io();
    expect(await estateFlowCommand(root, "forge-web.save-customer", {}, f.io)).toBe(0);
    const C = "forge-customers:src/main/java/forge/customers";
    expect(f.out).toEqual([
      "forge-web.save-customer: A person saves a new customer (forge-web)",
      "Trigger (action): The Save button of the customer form is pressed  [forge-web:src/app/customers/customer-form.component.ts:11]",
      "1 call-out: POST /api/customers with the form's fields, through the gateway  [forge-web:src/app/customers/customer.service.ts:10]",
      "  → forge-customers.create-customer: A client creates a customer (forge-customers), through the Interface if-c74e2fa3c8152a13",
      "    sends name, email, phone; the callee takes name, email, phone; returns id, fullName, emailAddress",
      `  1.1 entry: CustomerController.create receives the request  [${C}/CustomerController.java:11]`,
      `  1.2 transform: The request becomes a Customer  [${C}/CustomerMapper.java:6]`,
      `  1.3 write: The customer is inserted  [${C}/CustomerController.java:12]`,
      `  1.4 respond: The saved customer is returned  [${C}/CustomerController.java:13]`,
      "2 respond: The saved customer's id is kept on the form  [forge-web:src/app/customers/customer-form.component.ts:12]",
    ]);
    const v = io();
    expect(await estateFlowCommand(root, "forge-web.view-customer", { depth: 0 }, v.io)).toBe(0);
    expect(v.out).toContain("    (not followed: the depth limit; raise --depth)");
    expect(v.out).toContain(
      "  ✗ not joined (no target): forge-customers has no entry point for GET /api/customers/{id}/points, and no Interface from forge-web reaches it",
    );
    const j = io();
    expect(await estateFlowCommand(root, "forge-web.save-customer", { json: true }, j.io)).toBe(0);
    expect(JSON.parse(j.out.join("\n")).steps[0].call.callee.flow.id).toBe(
      "forge-customers.create-customer",
    );
    const missing = io();
    expect(await estateFlowCommand(root, "forge-web.nothing", {}, missing.io)).toBe(2);
    expect(missing.err).toEqual(["There is no flow forge-web.nothing in specs/."]);
  });

  it("follows a field from the UI to its column, and says where a chain breaks", async () => {
    const root = await setup();
    await estateJoin(root, { now: T }, io().io);
    const n = io();
    expect(await estateLineage(root, "forge-web.save-customer", "name", {}, n.io)).toBe(0);
    const C = "forge-customers:src/main/java/forge/customers";
    expect(n.out).toEqual([
      "name along forge-web.save-customer:",
      "  1 call-out, sent name: POST /api/customers with the form's fields, through the gateway  [forge-web:src/app/customers/customer.service.ts:10]",
      `  1.1 entry, named name: CustomerController.create receives the request  [${C}/CustomerController.java:11]`,
      `  1.2 transform, renamed CustomerRequest.name → Customer.fullName: The request becomes a Customer  [${C}/CustomerMapper.java:6]`,
      `  1.3 write, stored forge-customers-db.customers.full_name: The customer is inserted  [${C}/CustomerController.java:12]`,
      "name is stored in forge-customers-db.customers.full_name.",
    ]);
    const p = io();
    expect(await estateLineage(root, "forge-web.save-customer", "phone", {}, p.io)).toBe(1);
    expect(p.out.at(-1)).toBe(
      "The chain breaks: After 1.1 no step names phone, and no write stores it.",
    );
    const j = io();
    expect(
      await estateLineage(root, "forge-web.save-customer", "email", { json: true }, j.io),
    ).toBe(0);
    expect(JSON.parse(j.out.join("\n")).stored).toEqual({
      table: "forge-customers-db.customers",
      column: "email_address",
    });
  });

  it("needs repo specs", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-estate-cli-"));
    await mkdir(join(root, "org-pack"), { recursive: true });
    const e = io();
    expect(await estateJoin(root, {}, e.io)).toBe(2);
    expect(e.err).toEqual([
      "There are no repo specs in specs/ yet. Draft them first: atticus spec draft <repo>.",
    ]);
  });
});
