import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadOrgPack, parseFacts, type Fact, type OrgPack } from "@maycombhq/core";
import { estateFromFacts } from "@maycombhq/scanner";
import {
  checkDeltas,
  estateOf,
  FeaturePlacement,
  FlowDelta,
  migrationsOf,
  placeIssues,
  storeFacts,
  storiesFromDeltas,
  storySteps,
  taskPrompt,
  type DeltaStory,
  type Estate,
} from "../src/index.js";

/**
 * The places a change goes into (ADR 0124 addendum B-places), on the C-join estate the facts
 * make (fixtures/estate-facts/), with the web front end's form and display fields added
 * (fixtures/estate-facts/places/). A customer's birth date crosses the estate: the form and the
 * model type in forge-web, the API's request and a new migration in forge-customers.
 *
 * 1. A front end's model types, form fields and displayed fields are field facts (the calls'
 *    request and response, the screen's `side: screen`), so a task names those files.
 * 2. An added step goes where the target flow says (`at`), not on its neighbour's line.
 * 3. A store's migrations come from the facts: a new migration beside them, never an edit of
 *    one; a schema file changed in place only where the store has no migrations.
 */

const ESTATE = join(__dirname, "..", "..", "..", "fixtures", "estate-facts");
const REPOS = ["forge-web", "forge-customers", "forge-ledger"];

type Variant = { ledgerSchemaFile?: boolean; customersAlembic?: boolean };
const ALEMBIC = "app/alembic/versions/e2412789c190_customers.py";

function factsOf(repo: string, o: Variant = {}): Fact[] {
  let text = readFileSync(join(ESTATE, "facts", `${repo}.jsonl`), "utf8");
  if (repo === "forge-web")
    text += readFileSync(join(ESTATE, "places", "forge-web.screens.jsonl"), "utf8");
  // A ledger whose columns are declared in a schema file it changes in place: no migrations.
  if (repo === "forge-ledger" && o.ledgerSchemaFile)
    text = text.replaceAll(
      "src/main/resources/db/migration/V1__accounts.sql",
      "src/main/resources/schema.sql",
    );
  // Customers' migrations as revisions with no numbering to follow.
  if (repo === "forge-customers" && o.customersAlembic)
    text = text.replaceAll("src/main/resources/db/migration/V1__customers.sql", ALEMBIC);
  const r = parseFacts(text);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
}

let op: OrgPack;
const estates = new Map<string, Estate>();
async function estate(o: Variant = {}): Promise<Estate> {
  const key = JSON.stringify(o);
  const had = estates.get(key);
  if (had) return had;
  const est = estateFromFacts({
    op,
    repos: REPOS.map((repo) => ({ repo, facts: factsOf(repo, o) })),
  });
  const e = estateOf(
    est.records,
    est.specs.flatMap((s) => s.flows.map((flow) => ({ repo: s.repo, flow }))),
  );
  estates.set(key, e);
  return e;
}
beforeAll(async () => {
  op = await loadOrgPack(join(ESTATE, "org-pack"));
});

const delta = (d: Record<string, unknown>) => FlowDelta.parse({ schemaVersion: 2, ...d });

const addForm = (o: { to?: boolean } = {}) =>
  delta({
    flow: "web-app.add-a-customer",
    repo: "forge-web",
    change: "modify",
    why: "The form asks for the customer's birth date",
    steps: [
      {
        op: "change",
        step: 1,
        what: "Save stays disabled until the form, with a birth date in the past, is valid",
        fields: { checks: ["birthDate"] },
      },
      {
        op: "change",
        step: 2,
        what: "POST the new customer, with the birth date",
        // The drafter may leave out where a changed call-out goes: today's step says it.
        ...(o.to ? { to: { component: "customers-api", entry: "POST /api/customers" } } : {}),
        fields: { sends: ["firstName", "lastName", "email", "phone", "birthDate"] },
      },
    ],
  });

const viewPage = () =>
  delta({
    flow: "web-app.view-a-customer",
    repo: "forge-web",
    change: "modify",
    why: "The customer's page shows the birth date",
    steps: [
      {
        op: "change",
        step: 1,
        what: "GET the customer, with the birth date",
        fields: { returns: ["birthDate"] },
      },
      {
        op: "change",
        step: 3,
        what: "Show the customer's name, email, balance and birth date",
        fields: { returns: ["birthDate"] },
      },
    ],
  });

const createApi = (o: { at?: string; migration?: string } = {}) =>
  delta({
    flow: "customers-api.create-a-customer",
    repo: "forge-customers",
    change: "modify",
    why: "A customer's birth date is kept",
    steps: [
      {
        op: "add",
        after: 1,
        kind: "validate",
        what: "A birth date in the future is refused with 400",
        fields: { checks: ["birthDate"] },
        ...(o.at ? { at: o.at } : {}),
      },
      {
        op: "change",
        step: 3,
        what: "The customer is inserted with the birth date",
        store: {
          table: "customers-db.customers",
          columns: ["first_name", "last_name", "email_address", "birth_date"],
          types: { birth_date: "date" },
          classification: { birth_date: "personal" },
          migration: o.migration ?? "V2__customer_birth_date.sql",
        },
      },
    ],
  });

const storyOf = (stories: DeltaStory[], flow: string) => stories.find((s) => s.flow === flow)!;

const LEVELS = ["public", "internal", "personal", "secret"];
const placement = () =>
  FeaturePlacement.parse({
    schemaVersion: 1,
    change: "add-birth-date",
    entry: "brief",
    summary: "A customer's birth date is kept.",
    flows: [{ id: "customers-api.create-a-customer", why: "It stores the customer" }],
  });

describe("1. a front end's places: its model type, form and displayed fields", () => {
  it("a changed call-out names the model type its call sends, from today's step when the delta leaves out where it goes", async () => {
    const e = await estate();
    for (const to of [false, true]) {
      const s = storyOf(storiesFromDeltas([addForm({ to })], e), "web-app.add-a-customer");
      const [form, post] = s.tasks;
      expect(post!.files).toEqual([
        {
          file: "forge-web:src/app/customers/customer.ts",
          lines: [3, 4, 5, 6],
          why: "where the call to customers-api POST /api/customers' request fields are (if-0f06d434a34c81c9.request)",
        },
      ]);
      // The form's validation is checked on the form: the form group declares its fields.
      expect(form!.files).toEqual([
        {
          file: "forge-web:src/app/customers/new-customer.component.ts",
          lines: [9, 10, 11, 12],
          why: "where /customers/new's screen fields are (web-app.any-new.screen)",
        },
      ]);
    }
  });

  it("a call-out that returns a new field names the model type it receives; the page that shows it, the fields it shows", async () => {
    const e = await estate();
    const s = storyOf(storiesFromDeltas([viewPage()], e), "web-app.view-a-customer");
    const [get, show] = s.tasks;
    expect(get!.files).toEqual([
      {
        file: "forge-web:src/app/customers/customer.ts",
        lines: [3, 5],
        why: "where the call to customers-api GET /api/customers/{customerId}'s response fields are (if-32758fa9e8968383.response)",
      },
    ]);
    expect(show!.files).toEqual([
      {
        file: "forge-web:src/app/customers/customer-card.component.html",
        lines: [3, 4],
        why: "where /customers/:id's screen fields are (web-app.any-customer.screen)",
      },
    ]);
  });

  it("the story's steps are those places: the form, the model and the code of each step", async () => {
    const e = await estate();
    const s = storyOf(storiesFromDeltas([addForm()], e), "web-app.add-a-customer");
    expect(storySteps(s).map((x) => `${x.kind} ${x.file}:${x.lines.join(",")}`)).toEqual([
      "code forge-web:src/app/customers/new-customer.component.html:30",
      "declares forge-web:src/app/customers/new-customer.component.ts:9,10,11,12",
      "code forge-web:src/app/customers/new-customer.component.ts:18",
      "declares forge-web:src/app/customers/customer.ts:3,4,5,6",
    ]);
  });

  it("a call the estate can't join yet (Unresolved) still names its model type", async () => {
    const own = factsOf("forge-web");
    const est = estateFromFacts({ op, repos: [{ repo: "forge-web", facts: own }] });
    const e = estateOf(
      est.records,
      est.specs.flatMap((s) => s.flows.map((flow) => ({ repo: s.repo, flow }))),
    );
    const s = storyOf(storiesFromDeltas([addForm()], e), "web-app.add-a-customer");
    expect(s.tasks[1]!.files?.map((f) => `${f.file}:${f.lines.join(",")}`)).toEqual([
      "forge-web:src/app/customers/customer.ts:3,4,5,6",
    ]);
  });
});

describe("2. an added step goes where the target flow says", () => {
  const SERVICE = "src/main/java/forge/customers/CustomerService.java";

  it("at path:line: the task is cited there, not at its neighbour's line", async () => {
    const e = await estate();
    const s = storyOf(
      storiesFromDeltas([createApi({ at: `${SERVICE}:29` })], e),
      "customers-api.create-a-customer",
    );
    const check = s.tasks[0]!;
    expect(check.evidence).toEqual([`forge-customers:${SERVICE}:29`]);
    expect(check.placed).toBe("given");
    expect(storySteps(s)[0]).toMatchObject({
      kind: "code",
      file: `forge-customers:${SERVICE}`,
      lines: [29],
    });
    expect(taskPrompt("add-birth-date", s, check, [])).toContain(
      `It goes in at forge-customers:${SERVICE}:29, as the target flow says.`,
    );
  });

  it("at path:function: the file, and the function said in the task", async () => {
    const e = await estate();
    const s = storyOf(
      storiesFromDeltas([createApi({ at: `${SERVICE}:create` })], e),
      "customers-api.create-a-customer",
    );
    const check = s.tasks[0]!;
    expect(check.evidence).toEqual([`forge-customers:${SERVICE}`]);
    expect(taskPrompt("add-birth-date", s, check, [])).toContain(
      `It goes in at forge-customers:${SERVICE}, in create, as the target flow says.`,
    );
  });

  it("no at: the neighbour's line, and the task says so", async () => {
    const e = await estate();
    const s = storyOf(storiesFromDeltas([createApi()], e), "customers-api.create-a-customer");
    const check = s.tasks[0]!;
    expect(check.evidence).toEqual([
      "forge-customers:src/main/java/forge/customers/CustomerController.java:25",
    ]);
    expect(check.placed).toBe("neighbour");
    expect(taskPrompt("add-birth-date", s, check, [])).toContain(
      "The target flow doesn't say where it goes: forge-customers:src/main/java/forge/customers/CustomerController.java:25 is the step before it, so put it where it fits after that.",
    );
  });

  it("checks the place: a file of the repo in its checkout or the catalog, a line it has, a function in it", async () => {
    const e = await estate();
    const root = await mkdtemp(join(tmpdir(), "atticus-places-"));
    const file = async (path: string, lines: string[]) => {
      const f = join(root, "workspace/forge-customers", path);
      await mkdir(dirname(f), { recursive: true });
      await writeFile(f, `${lines.join("\n")}\n`);
    };
    const body = Array.from({ length: 40 }, (_, i) =>
      i === 28 ? "  public CustomerView create(NewCustomer body) {" : "",
    );
    await file(SERVICE, body);
    await file("src/main/java/forge/customers/BirthDates.java", ["class BirthDates {}"]);
    const rules = async (at: string, r?: string) =>
      (await placeIssues([createApi({ at })], e, r)).map(
        (i) => `${i.rule}${i.blocking ? "" : " (note)"}`,
      );

    // The catalog cites the file: known without a checkout.
    expect(await rules(`${SERVICE}:29`)).toEqual([]);
    // Neither the catalog nor a checkout has it.
    expect(await rules("src/main/java/forge/customers/Nowhere.java:3")).toEqual([
      "delta.at-unknown",
    ]);
    // In the checkout only: known.
    expect(await rules("src/main/java/forge/customers/BirthDates.java:1", root)).toEqual([]);
    // A line past the file's end, a function the file doesn't have.
    expect(await rules(`${SERVICE}:99`, root)).toEqual(["delta.at-line"]);
    expect(await rules(`${SERVICE}:create`, root)).toEqual([]);
    expect(await rules(`${SERVICE}:remove`, root)).toEqual(["delta.at-function"]);
    // A path out of the repo is no place.
    expect(await rules("../forge-ledger/x.java:1", root)).toEqual(["delta.at-unknown"]);
    const [msg] = await placeIssues([createApi({ at: "src/Nowhere.java:3" })], e);
    expect(msg!.message).toBe(
      "Change 1 to customers-api.create-a-customer puts the new step at src/Nowhere.java:3, but forge-customers has no such file in its checkout or the catalog: give the path as the repo has it (path:line of the line the step goes after, or path:function). Leave at out only for code in a file the change creates.",
    );
  });

  it("old answers without at read as before", async () => {
    const e = await estate();
    const before = storiesFromDeltas([createApi()], e);
    expect(before[0]!.tasks[0]!.evidence).toEqual([
      "forge-customers:src/main/java/forge/customers/CustomerController.java:25",
    ]);
    expect(await placeIssues([createApi()], e)).toEqual([]);
  });
});

describe("3. a store's migrations come from the facts", () => {
  const FOLDER = "src/main/resources/db/migration";

  it("the store's migrations: their folder, newest and the next name", async () => {
    const e = await estate();
    expect(migrationsOf(e, "customers-db")).toMatchObject({
      store: "customers-db",
      repo: "forge-customers",
      tool: "flyway",
      folder: FOLDER,
      files: ["V1__customers.sql"],
      pattern: { prefix: "V", sep: "__", ext: ".sql", newest: 1 },
    });
    expect(storeFacts(e, ["customers-db"])).toContain(
      `migrations in ${FOLDER}, the newest V1__customers.sql; the next is V2__<what_it_does>.sql`,
    );
  });

  it("a new migration is a new file in their folder; the migration a column was added in isn't touched", async () => {
    const e = await estate();
    const s = storyOf(storiesFromDeltas([createApi()], e), "customers-api.create-a-customer");
    const write = s.tasks[1]!;
    expect(write.data?.migrationFile).toBe(`${FOLDER}/V2__customer_birth_date.sql`);
    expect(write.files?.some((f) => f.file.includes("V1__customers.sql"))).toBe(false);
    const steps = storySteps(s);
    expect(steps.filter((x) => x.kind === "migration").map((x) => x.file)).toEqual([
      `forge-customers:${FOLDER}/V2__customer_birth_date.sql`,
    ]);
    expect(steps.some((x) => x.file?.includes("V1__customers.sql"))).toBe(false);
  });

  it("naming a migration the store has, or a file out of its numbering, is refused with the next name", async () => {
    const e = await estate();
    const migrationRules = (name: string) =>
      checkDeltas([createApi({ migration: name })], e, placement(), [], { levels: LEVELS })
        .filter((i) => i.rule === "delta.bad-migration")
        .map((i) => i.message);
    expect(migrationRules("V2__customer_birth_date.sql")).toEqual([]);
    expect(migrationRules("V1__customers.sql")).toEqual([
      `Change 2 to customers-api.create-a-customer names the migration V1__customers.sql, which customers-db already has: a change to its tables is a new migration beside it, in ${FOLDER}: name the file V2__customers.sql.`,
    ]);
    expect(migrationRules("schema.sql")).toEqual([
      expect.stringContaining(`name the file V2__schema.sql, in ${FOLDER}`),
    ]);
  });

  it("with no numbering to follow, naming a migration the store has is refused too", async () => {
    const e = await estate({ customersAlembic: true });
    expect(migrationsOf(e, "customers-db")).toMatchObject({
      tool: "alembic",
      folder: "app/alembic/versions",
      files: ["e2412789c190_customers.py"],
    });
    const bad = (name: string) =>
      checkDeltas([createApi({ migration: name })], e, placement(), [], { levels: LEVELS })
        .filter((i) => i.rule === "delta.bad-migration")
        .map((i) => i.message);
    expect(bad("3f5a9c1d2b7e_customer_birth_date.py")).toEqual([]);
    expect(bad("e2412789c190_customers.py")).toEqual([
      "Change 2 to customers-api.create-a-customer names the migration e2412789c190_customers.py, which customers-db already has: a change to its tables is a new migration beside it, in app/alembic/versions: name the file as its migrations are named (e2412789c190_customers.py).",
    ]);
    const s = storyOf(
      storiesFromDeltas([createApi({ migration: "3f5a9c1d2b7e_customer_birth_date.py" })], e),
      "customers-api.create-a-customer",
    );
    expect(s.tasks[1]!.data?.migrationFile).toBe(
      "app/alembic/versions/3f5a9c1d2b7e_customer_birth_date.py",
    );
  });

  it("a store with no migrations: its schema file is the place, changed in place", async () => {
    const e = await estate({ ledgerSchemaFile: true });
    expect(migrationsOf(e, "ledger-db").files).toEqual([]);
    expect(storeFacts(e, ["ledger-db"])).toContain(
      "the catalog has no migration of it; its columns are declared in src/main/resources/schema.sql: a change there is made in place, so name that file under store.migration",
    );
    const d = delta({
      flow: "ledger-api.open-an-account",
      repo: "forge-ledger",
      change: "modify",
      why: "An account has a currency",
      steps: [
        {
          op: "change",
          step: 1,
          what: "The account is inserted in its currency",
          store: {
            table: "ledger-db.accounts",
            columns: ["customer_id", "currency"],
            types: { currency: "char(3)" },
            classification: { currency: "internal" },
            migration: "schema.sql",
          },
        },
      ],
    });
    const s = storiesFromDeltas([d], e)[0]!;
    const steps = storySteps(s);
    expect(steps.filter((x) => x.kind === "migration")).toEqual([]);
    expect(steps.map((x) => `${x.kind} ${x.file}`)).toContain(
      "declares forge-ledger:src/main/resources/schema.sql",
    );
  });
});
