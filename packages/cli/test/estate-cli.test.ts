import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  EstateJoins,
  HOSTS_STEP,
  listQuestions,
  parseRecord,
  Question,
  recordPath,
  RepoManifest,
  serializeRecord,
} from "@maycombhq/core";
import {
  ESTATE_TARGETS_STEP,
  estateFlowCommand,
  estateJoin,
  estateLineage,
} from "../src/estate-commands.js";
import { questionsFiles } from "../src/question-commands.js";

const ESTATE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/estate");
const T = new Date("2026-10-21T12:00:00Z");

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
};

/** A metarepo with the fixture catalog, the two repos cloned in workspace/, and their specs. */
async function setup(o: { owners?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "atticus-estate-cli-"));
  // With owners, the owners part of the estate (ADR 0088) goes on top of the base.
  const parts = o.owners ? [ESTATE, join(ESTATE, "owners")] : [ESTATE];
  for (const part of parts)
    for (const r of parse(await readFile(join(part, "catalog.yaml"), "utf8")) as unknown[]) {
      const p = parseRecord(r);
      if (!p.ok) throw new Error(JSON.stringify(p.issues));
      const file = join(root, "catalog", "generated", recordPath(p.record));
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, serializeRecord(p.record));
    }
  await cp(join(ESTATE, "org-pack"), join(root, "org-pack"), { recursive: true });
  for (const part of parts)
    for (const repo of ["forge-web", "forge-customers"]) {
      await cp(join(part, "repos", repo), join(root, "workspace", repo), { recursive: true });
      await cp(join(part, "specs", repo), join(root, "specs", repo), { recursive: true });
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

  it("refuses a join through a wrong family, asks which repo answers on a host, and follows an object to its column (ADR 0088)", async () => {
    const root = await setup({ owners: true });
    const j = io();
    expect(await estateJoin(root, { now: T }, j.io)).toBe(0);
    expect(j.err).toEqual([]);
    expect(j.out[0]).toBe(
      "Joined 3 of 6 call-outs across 2 repos (forge-customers, forge-web); written to specs/estate.yaml.",
    );
    expect(j.out).toContain(
      "  forge-web.find-owners step 1 (a wrong family): GET /owners reaches forge-customers.get-owners, which only forge-customers.add-owner stands for, in its family, and atticus spec check finds that wrong: forge-customers.add-owner stands for forge-customers.get-owners (GET /owners), a read, but its trigger forge-customers.post-owner (POST /owners) is a write. Redraft it: atticus spec draft forge-customers",
    );
    const written = EstateJoins.parse(
      parse(await readFile(join(root, "specs", "estate.yaml"), "utf8")),
    );
    expect(written).toEqual(
      EstateJoins.parse(
        parse(await readFile(join(ESTATE, "owners", "expected", "estate.yaml"), "utf8")),
      ),
    );

    // The UI's calls to localhost:9966 join no repo: one question, forge-customers first.
    const asked = (await listQuestions(root, { step: HOSTS_STEP })).questions;
    expect(asked).toHaveLength(1);
    const want = Question.parse(
      parse(await readFile(join(ESTATE, "owners", "expected", "question.yaml"), "utf8")),
    );
    expect({
      ...asked[0]!,
      id: want.id,
      askedBy: { ...asked[0]!.askedBy, command: "atticus scan" },
    }).toEqual(want);
    expect(asked[0]!.askedBy.command).toBe("atticus estate join");
    expect(j.out).toContain(
      `Calls to localhost:9966 join no repo: no repo lists it under hosts. Asked ${asked[0]!.id}: Which repo answers on localhost:9966? Answer it: atticus questions answer ${asked[0]!.id} --option <n> (1 is forge-customers).`,
    );
    // Asked once: the next join says it's still open.
    const again = io();
    await estateJoin(root, { now: T }, again.io);
    expect((await listQuestions(root, { step: HOSTS_STEP })).questions).toHaveLength(1);
    expect(again.out).toContain(
      `Still open: Which repo answers on localhost:9966? Answer it: atticus questions answer ${asked[0]!.id} --option <n>, then atticus scan.`,
    );

    // Answering writes the host into forge-customers' hosts and says what to run.
    const a = io();
    expect(
      await questionsFiles(
        root,
        ["questions", "answer", asked[0]!.id, "--option", "1", "--by", "priya.nair"],
        a.io,
        { now: T },
      ),
    ).toBe(0);
    expect(a.out).toContain(
      "Wrote localhost:9966 under hosts for forge-customers in org-pack/profiles/forge/repos.manifest.yaml; review it in the same pull request.",
    );
    expect(a.out.at(-1)).toBe("Next: atticus scan");
    const m = RepoManifest.parse(
      parse(
        await readFile(join(root, "org-pack", "profiles", "forge", "repos.manifest.yaml"), "utf8"),
      ),
    );
    expect(m.repos.find((r) => r.id === "forge-customers")!.hosts).toEqual(["localhost:9966"]);
    // With the host listed, nothing is asked.
    const after = io();
    await estateJoin(root, { now: T }, after.io);
    expect(after.out.some((l) => l.includes("localhost:9966"))).toBe(false);

    // The UI sends one owner; firstName reaches owners.first_name in the API.
    const f = io();
    expect(await estateFlowCommand(root, "forge-web.add-owner", {}, f.io)).toBe(0);
    expect(f.out).toContain("    owner carries the callee's firstName, lastName");
    const l = io();
    expect(await estateLineage(root, "forge-web.add-owner", "firstName", {}, l.io)).toBe(0);
    expect(l.out).toEqual([
      "firstName along forge-web.add-owner:",
      "  1 call-out, sent owner.firstName: POST /owners with the owner  [forge-web:src/app/owners/owner.service.ts:10]",
      "  1.1 entry, named firstName: OwnerController.add takes the owner's fields  [forge-customers:src/main/java/forge/customers/OwnerController.java:12]",
      "  1.2 write, stored forge-customers-db.owners.first_name: The owner is saved  [forge-customers:src/main/java/forge/customers/OwnerController.java:14]",
      "firstName is stored in forge-customers-db.owners.first_name.",
    ]);
  });

  it("joins a relative call whose target the catalog doesn't have by method and path, says each is inferred, and asks when two could answer (ADR 0124 addendum C-join)", async () => {
    const REL = join(ESTATE, "relative");
    const root = await mkdtemp(join(tmpdir(), "atticus-estate-relative-"));
    for (const r of parse(await readFile(join(REL, "catalog.yaml"), "utf8")) as unknown[]) {
      const p = parseRecord(r);
      if (!p.ok) throw new Error(JSON.stringify(p.issues));
      const file = join(root, "catalog", "generated", recordPath(p.record));
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, serializeRecord(p.record));
    }
    await cp(join(ESTATE, "org-pack"), join(root, "org-pack"), { recursive: true });
    await cp(join(REL, "specs"), join(root, "specs"), { recursive: true });

    const j = io();
    expect(await estateJoin(root, { now: T }, j.io)).toBe(0);
    expect(j.err).toEqual([]);
    const asked = (await listQuestions(root, { step: ESTATE_TARGETS_STEP })).questions;
    expect(asked).toHaveLength(1);
    const q = asked[0]!;
    expect(q.question).toBe(
      "Which component answers GET /api/archive/{id}, which forge-notes-web calls?",
    );
    expect(q.evidence).toEqual(["web/src/notes/notes-api.ts:13"]);
    expect(q.options.map((o) => o.label)).toEqual([
      "forge-archive",
      "forge-archive-replica",
      "None of these",
    ]);
    expect(j.out).toEqual([
      "Joined 3 of 4 call-outs across 2 repos (forge-archive, forge-notes); written to specs/estate.yaml.",
      "  forge-notes-web.open-note step 1 → forge-notes.get-note (by method and path, inferred)",
      "  forge-notes-web.open-note step 2 → forge-archive.list-tags (by method and path, inferred)",
      "  forge-notes-web.open-note step 4 → forge-notes.create-note (by method and path, inferred)",
      "1 call-out isn't joined:",
      "  forge-notes-web.open-note step 3 (no target): notes-service isn't a component in the catalog, and 2 components of forge-archive serve GET /api/archive/{id} (forge-archive, forge-archive-replica): a person says which",
      "Cited lines of forge-archive, forge-notes weren't checked: there is no clone of them here.",
      "3 joins are inferred: their step names a target that isn't a component in the catalog (a relative call's guessed name, or none), so each joined the only entry point that serves its method and path, the caller's own repo first. When the repo is next read, a relative call leaves `to` out or names the component that serves it.",
      `Two or more components answer a call-out: asked ${q.id}: ${q.question} Answer it: atticus questions answer ${q.id} --option <n>, then atticus estate join.`,
      "Next: atticus estate flow <flow-id> follows a flow across repos.",
    ]);
    const written = EstateJoins.parse(
      parse(await readFile(join(root, "specs", "estate.yaml"), "utf8")),
    );
    expect(written).toEqual(
      EstateJoins.parse(parse(await readFile(join(REL, "expected", "estate.yaml"), "utf8"))),
    );

    // JSON says which joins are inferred, and the question.
    const js = io();
    expect(await estateJoin(root, { now: T, json: true }, js.io)).toBe(0);
    const out = JSON.parse(js.out.join("\n")) as {
      inferred: { from: { step: number }; within: string }[];
      questions: string[];
    };
    expect(out.inferred.map((x) => [x.from.step, x.within])).toEqual([
      [1, "repo"],
      [2, "estate"],
      [4, "repo"],
    ]);
    expect(out.questions).toEqual([q.id]);

    // The answer joins it, and nothing more is asked.
    expect(
      await questionsFiles(
        root,
        ["questions", "answer", q.id, "--option", "2", "--by", "priya.nair"],
        io().io,
        { now: T },
      ),
    ).toBe(0);
    const after = io();
    expect(await estateJoin(root, { now: T }, after.io)).toBe(0);
    expect(after.out[0]).toBe(
      "Joined 4 of 4 call-outs across 2 repos (forge-archive, forge-notes); written to specs/estate.yaml.",
    );
    expect(after.out).toContain(
      "  forge-notes-web.open-note step 3 → forge-archive-replica.get-archived (by method and path)",
    );
    expect(after.out.some((l) => l.includes("asked"))).toBe(false);
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
