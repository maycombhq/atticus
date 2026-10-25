import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  answerQuestion,
  loadOrgPack,
  parseFacts,
  raiseQuestions,
  type Fact,
  type OrgPack,
} from "@maycombhq/core";
import { estateFromFacts } from "@maycombhq/scanner";
import {
  checkDeltas,
  FeaturePlacement,
  declaringFiles,
  estateIndex,
  estateOf,
  FlowDelta,
  interfaceChanges,
  parseYamlAs,
  questionsOnFile,
  scopeRepos,
  storeFacts,
  StoriesAnswerSchema,
  storiesFromDeltas,
  storySteps,
  type DeltaStory,
  type Estate,
} from "../src/index.js";
import { pathWords } from "../src/stages/schema-words.js";

/**
 * What the second stories bench run found (ADR 0124 addendum B-run2-fixes), on the C-join estate
 * the facts make (fixtures/estate-facts/), with the run's shapes added (fixtures/estate-facts/run2/):
 *
 * 1. The store facts of a store with no migrations name the files that declare the table's own
 *    columns: its schema file and the entity mapped to it, not a base class of other tables too.
 * 2. A task's places are where the fields it adds or changes are declared, not every field it
 *    names; a screen schema several screens' files share names the screen's own file.
 * 3. Two tasks at the same file and line are one place.
 */

const ESTATE = join(__dirname, "..", "..", "..", "fixtures", "estate-facts");
const REPOS = ["forge-web", "forge-customers", "forge-ledger"];

function factsOf(repo: string, o: { ledgerSchemaFile?: boolean } = {}): Fact[] {
  let text = readFileSync(join(ESTATE, "facts", `${repo}.jsonl`), "utf8");
  if (repo === "forge-web")
    text += readFileSync(join(ESTATE, "places", "forge-web.screens.jsonl"), "utf8");
  text += readFileSync(join(ESTATE, "run2", `${repo}.jsonl`), "utf8");
  if (repo === "forge-ledger" && o.ledgerSchemaFile)
    text = text.replaceAll(
      "src/main/resources/db/migration/V1__accounts.sql",
      "src/main/resources/schema.sql",
    );
  const r = parseFacts(text);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
}

let op: OrgPack;
const estates = new Map<string, Estate>();
function estate(o: { ledgerSchemaFile?: boolean } = {}): Estate {
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
const storyOf = (stories: DeltaStory[], flow: string) => stories.find((s) => s.flow === flow)!;
const files = (t: { files?: { file: string }[] }) => (t.files ?? []).map((f) => f.file);

const SCHEMA = "src/main/resources/schema.sql";
const ACCOUNT = "src/main/java/forge/ledger/Account.java";

const openAccount = () =>
  delta({
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

describe("1. the store facts name the files that declare the table's own columns", () => {
  it("the schema file and the entity mapped to the table, not a base class of another table's too", () => {
    const e = estate({ ledgerSchemaFile: true });
    expect(declaringFiles(e, ["ledger-db.accounts"]).map((f) => f.path)).toEqual([ACCOUNT, SCHEMA]);
    expect(storeFacts(e, ["ledger-db"], ["ledger-db.accounts"])).toContain(
      `the catalog has no migration of it; the columns of accounts are declared in ${ACCOUNT}, ${SCHEMA}: a change there is made in place, so name the schema file that creates the table under store.migration`,
    );
    // Not the files of every column of the store, first by path (the run's BaseEntity.java).
    expect(storeFacts(e, ["ledger-db"], ["ledger-db.accounts"])).not.toMatch(/BaseEntity|Audited/);
  });

  it("a write that adds a column names the same files, and the table's own query", () => {
    const e = estate({ ledgerSchemaFile: true });
    const write = storiesFromDeltas([openAccount()], e)[0]!.tasks[0]!;
    expect(files(write)).toEqual([
      "forge-ledger:src/main/java/forge/ledger/AccountRepository.java",
      `forge-ledger:${SCHEMA}`,
      `forge-ledger:${ACCOUNT}`,
    ]);
  });
});

describe("2. a task's places are where what it adds or changes is declared", () => {
  const createApi = (steps: Record<string, unknown>[]) =>
    delta({
      flow: "customers-api.create-a-customer",
      repo: "forge-customers",
      change: "modify",
      why: "A customer's birth date is kept",
      steps,
    });

  it("a check of a new field and fields the request has: the DTO, not a validator citing one of them", () => {
    const s = storiesFromDeltas(
      [
        createApi([
          {
            op: "add",
            after: 1,
            kind: "validate",
            what: "The email and a birth date in the past are checked",
            fields: { checks: ["email", "birthDate"] },
          },
        ]),
      ],
      estate(),
    )[0]!;
    expect(files(s.tasks[0]!)).toEqual([
      "forge-customers:src/main/java/forge/customers/NewCustomer.java",
    ]);
  });

  it("only naming fields the request has is no place; making one required is, at its own line", () => {
    const [named, required] = storiesFromDeltas(
      [
        createApi([
          {
            op: "add",
            after: 1,
            kind: "validate",
            what: "The names and email are checked again",
            fields: { checks: ["firstName", "email"] },
          },
          {
            op: "add",
            after: 1,
            kind: "validate",
            what: "A phone number is required",
            fields: { checks: ["phone"], required: ["phone"] },
          },
        ]),
      ],
      estate(),
    )[0]!.tasks;
    expect(named!.files).toBeUndefined();
    expect(required!.files).toEqual([
      {
        file: "forge-customers:src/main/java/forge/customers/NewCustomer.java",
        lines: [9],
        why: "where POST /api/customers' request fields are (customers-api.post-customer.request: phone)",
      },
    ]);
  });

  it("a screen's fields that two screens' files share: the screen's own file, from today's flow", () => {
    const s = storyOf(
      storiesFromDeltas(
        [
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
            ],
          }),
        ],
        estate(),
      ),
      "web-app.add-a-customer",
    );
    expect(files(s.tasks[0]!)).toEqual(["forge-web:src/app/customers/new-customer.component.ts"]);
  });

  it("a file the target flow puts a step in (at) is the screen's own too", () => {
    // The customer page's flow cites neither file of its shown fields (the card, and a list that
    // shows them too); the step it adds goes in the card, so the card is the page's own.
    const s = storyOf(
      storiesFromDeltas(
        [
          delta({
            flow: "web-app.view-a-customer",
            repo: "forge-web",
            change: "modify",
            why: "The customer's page shows the birth date",
            steps: [
              {
                op: "change",
                step: 3,
                what: "Show the customer's name, email, balance and birth date",
                fields: { returns: ["birthDate"] },
              },
              {
                op: "add",
                after: 3,
                at: "src/app/customers/customer-card.component.html:4",
                kind: "transform",
                what: "The birth date is shown as a date, with no time",
                fields: { from: ["birthDate"] },
              },
            ],
          }),
        ],
        estate(),
      ),
      "web-app.view-a-customer",
    );
    expect(files(s.tasks[0]!)).toEqual([
      "forge-web:src/app/customers/customer-card.component.html",
    ]);
  });
});

describe("3. two tasks at the same file and line are one place", () => {
  it("a read and a check added at one line are one step, with both tasks", () => {
    const at = "src/main/java/forge/customers/CustomerService.java:29";
    const s = storiesFromDeltas(
      [
        delta({
          flow: "customers-api.create-a-customer",
          repo: "forge-customers",
          change: "modify",
          why: "A customer's email is unique",
          steps: [
            {
              op: "add",
              after: 1,
              at,
              kind: "lookup",
              what: "Look for a customer with the email",
              store: { table: "customers-db.customers", columns: ["email_address"] },
              fields: { checks: ["email"] },
            },
            {
              op: "add",
              after: 1,
              at,
              kind: "validate",
              what: "An email another customer has is refused with 409",
              fields: { checks: ["email"] },
            },
          ],
        }),
      ],
      estate(),
    )[0]!;
    const steps = storySteps(s);
    expect(steps.map((x) => [x.kind, x.file, x.lines, x.tasks])).toEqual([
      [
        "code",
        "forge-customers:src/main/java/forge/customers/CustomerService.java",
        [29],
        ["1.1", "1.2"],
      ],
    ]);
    expect(steps[0]!.what).toBe(
      "adds the lookup step after this code: Look for a customer with the email; adds the validate step after this code: An email another customer has is refused with 409",
    );
  });
});

describe("8. an answered question reaches the next prompt with what the answer says", () => {
  it("the option's label, what it means and changes; or the person's own words", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-run2-"));
    const ask = (question: string) =>
      raiseQuestions(
        root,
        [
          {
            question,
            options: [
              {
                label: "Yes",
                means: "a customer may have two accounts in one currency",
                changes: "the open-account check counts accounts per currency",
              },
              { label: "No", means: "one account per customer", changes: "a second is refused" },
            ],
            evidence: ["src/main/java/forge/ledger/LedgerService.java:21"],
            scope: "repo",
          },
        ],
        {
          step: "architecture",
          repo: "add-currency",
          command: "atticus change architecture add-currency",
          rerun: "atticus change architecture add-currency",
          at: "2026-10-25T09:00:00Z",
        },
      );
    const one = (await ask("Can a customer have two accounts in one currency?")).raised[0]!.id;
    const two = (await ask("Which currencies may an account be opened in?")).raised[0]!.id;
    await answerQuestion(root, one, { option: 1, by: "pat", at: "2026-10-25T10:00:00Z" });
    await answerQuestion(root, two, {
      text: "EUR and GBP only, for now",
      by: "pat",
      at: "2026-10-25T10:00:00Z",
    });
    const text = (await questionsOnFile(root, "add-currency")).find(
      (s) => s.id === "questions-on-file",
    )!.text;
    expect(text).toContain(
      "  Answer (pat): Yes. It means: a customer may have two accounts in one currency. It changes: the open-account check counts accounts per currency.",
    );
    expect(text).toContain("  Answer (pat): EUR and GBP only, for now");
  });
});

describe("9. an answer's schema problems say what is wrong, in words", () => {
  const story = (interfaces: string) =>
    [
      "stories:",
      "  - id: s1-x",
      "    title: x",
      "    asA: clerk",
      "    iWant: x",
      "    soThat: y",
      `    interfaces: ${interfaces}`,
      "    tasks: []",
    ].join("\n");
  const said = (text: string) =>
    parseYamlAs(text, StoriesAnswerSchema, (d) => d, "stories").issues.map((i) => i.message);

  it("a list's item is named in the singular, and a union names the cause in the branch meant", () => {
    expect(
      said(
        story(
          "[{ entry: POST /api/customers, change: changed, breaking: false, fields: [{ name: phone, side: both, type: string, change: added }] }]",
        ),
      ),
    ).toEqual([
      "In your answer at line 7: story 1's interface 1's field 1's side is text (\"both\"): write one of request, response, message.",
    ]);
    // Neither a list nor { none }: what each takes.
    expect(said(story("nothing changes"))).toEqual([
      'In your answer at line 7: story 1\'s interfaces is text ("nothing changes"): write a list, such as [orderId], or keys and values, such as { table: forge-orders-db.orders }.',
    ]);
    expect(pathWords(["entries", 0, "id"])).toBe("entry 1's id");
  });
});

describe("9. a field today's entry already returns has its source, named or not", () => {
  const placement = FeaturePlacement.parse({
    schemaVersion: 1,
    change: "add-birth-date",
    entry: "brief",
    summary: "A customer's birth date is kept.",
    flows: [{ id: "customers-api.create-a-customer", why: "It stores the customer" }],
  });
  const respond = (returns: string[]) =>
    delta({
      flow: "customers-api.create-a-customer",
      repo: "forge-customers",
      change: "modify",
      why: "A customer's birth date is kept",
      steps: [
        {
          op: "change",
          step: 3,
          what: "The customer is inserted with the birth date",
          store: {
            table: "customers-db.customers",
            columns: ["first_name", "last_name", "email_address", "birth_date"],
            types: { birth_date: "date" },
            classification: { birth_date: "personal" },
            migration: "V2__customer_birth_date.sql",
          },
        },
        { op: "change", step: 6, what: "201 with the new customer", fields: { returns } },
      ],
    });
  const refused = (returns: string[]) =>
    checkDeltas([respond(returns)], estate(), placement, [], {
      levels: ["public", "internal", "personal", "secret"],
    })
      .filter(
        (i) => i.rule === "delta.field-from-nowhere" || i.rule === "delta.returned-before-given",
      )
      .map((i) => i.target.split(":").at(-1));
  it("its response schema has status today, though no step of the flow names it: not refused", () => {
    // Today's 201 returns id and status (the response DTO), and the insert names neither.
    expect(refused(["id", "status", "birth_date"])).toEqual([]);
  });
  it("a field no step gives and today's entry doesn't return is still refused", () => {
    expect(refused(["id", "status", "nickname"])).toEqual(["nickname"]);
  });
});

describe("10. a new error status on an rpc is an interface change", () => {
  const openWith = (what: string) =>
    delta({
      flow: "ledger-api.open-an-account",
      repo: "forge-ledger",
      change: "modify",
      why: "A customer has at most three accounts",
      steps: [{ op: "add", after: 0, kind: "validate", what, fields: { checks: ["customer_id"] } }],
    });
  it("an added step that answers a gRPC status today's flow doesn't: the rpc's contract changes", () => {
    expect(
      interfaceChanges(
        [openWith('A fourth account is refused with FAILED_PRECONDITION "three accounts already"')],
        estate(),
      ),
    ).toEqual([
      {
        flow: "ledger-api.open-an-account",
        caller: "its callers",
        callee: "ledger-api",
        operation: "forge.ledger.v1.Ledger/OpenAccount",
        status: "planned-modify",
        fields: ["error status FAILED_PRECONDITION"],
      },
    ]);
  });
  it("no status named, or not an rpc: no interface change", () => {
    expect(interfaceChanges([openWith("A fourth account is refused")], estate())).toEqual([]);
    const http = delta({
      flow: "customers-api.create-a-customer",
      repo: "forge-customers",
      change: "modify",
      why: "x",
      steps: [{ op: "add", after: 1, kind: "validate", what: "refused with INVALID_ARGUMENT" }],
    });
    expect(interfaceChanges([http], estate())).toEqual([]);
  });
});

describe("11. in a metarepo two estates share, a change's estate index is its own estate's", () => {
  it("the repos it touches, their systems and the repos their components call or are called by", () => {
    const shop = parseFacts(readFileSync(join(ESTATE, "collision", "forge-shop.jsonl"), "utf8"));
    if (!shop.ok) throw new Error(JSON.stringify(shop.issues));
    const est = estateFromFacts({
      op,
      repos: [
        ...REPOS.map((repo) => ({ repo, facts: factsOf(repo) })),
        { repo: "forge-shop", facts: shop.facts },
      ],
    });
    const e = estateOf(
      est.records,
      est.specs.flatMap((s) => s.flows.map((flow) => ({ repo: s.repo, flow }))),
    );
    const scope = scopeRepos(e, ["forge-ledger"]);
    // forge-customers calls the ledger's OpenAccount: a neighbour by the join.
    expect([...scope]).toEqual(expect.arrayContaining(["forge-customers", "forge-ledger"]));
    expect(scope.has("forge-shop")).toBe(false);
    const all = estateIndex(e);
    const own = estateIndex(e, scope);
    expect(all).toContain("(repo forge-shop");
    expect(own).not.toContain("forge-shop");
    expect(own).toContain("flow ledger-api.open-an-account");
    // Nothing of the catalog in scope: the whole estate, as before.
    expect(estateIndex(e, new Set(["nowhere"]))).toBe(all);
  });
});
