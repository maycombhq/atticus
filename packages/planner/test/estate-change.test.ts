import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadOrgPack, parseFacts, type Fact, type OrgPack } from "@maycombhq/core";
import { estateFromFacts } from "@maycombhq/scanner";
import {
  deployIssues,
  deployNeeds,
  endpointConsumers,
  estateOf,
  FlowDelta,
  type Estate,
} from "../src/index.js";

/**
 * One cross-repo change end to end on the estate the facts make (ADR 0124 addendum C-join):
 * three Forge repos' facts joined into one catalog and their flows, then a change that adds a
 * phone number to a customer, in the customers API (a new column, so a migration) and in the web
 * front end that sends it, and a currency to the account the API opens over gRPC in the ledger
 * (a column there too). The map names each entry's caller, and the deploy order runs each
 * migration before its code and each callee before its caller, read off the joins (the gRPC call
 * names no target: only the facts join says the ledger answers it).
 */

const ESTATE = join(__dirname, "..", "..", "..", "fixtures", "estate-facts");
const REPOS = ["forge-web", "forge-customers", "forge-ledger"];
const factsOf = (repo: string): Fact[] => {
  const r = parseFacts(readFileSync(join(ESTATE, "facts", `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};

let op: OrgPack;
let e: Estate;
beforeAll(async () => {
  op = await loadOrgPack(join(ESTATE, "org-pack"));
  const est = estateFromFacts({ op, repos: REPOS.map((repo) => ({ repo, facts: factsOf(repo) })) });
  e = estateOf(
    est.records,
    est.specs.flatMap((s) => s.flows.map((flow) => ({ repo: s.repo, flow }))),
  );
});

const deltas = (): FlowDelta[] =>
  [
    {
      schemaVersion: 2,
      flow: "customers-api.create-a-customer",
      repo: "forge-customers",
      change: "modify",
      why: "A customer's phone number is kept",
      steps: [
        {
          op: "change",
          step: 3,
          what: "The customer is inserted with the phone number",
          store: {
            table: "customers-db.customers",
            columns: ["first_name", "last_name", "email_address", "phone"],
            types: { phone: "varchar(20)" },
            classification: { phone: "personal" },
            migration: "V2__customer_phone.sql",
          },
        },
        {
          op: "change",
          step: 4,
          what: "The ledger opens the customer's account in the customer's currency",
          to: { component: "ledger-api", entry: "forge.ledger.v1.Ledger/OpenAccount" },
          fields: { sends: ["customerId", "currency"] },
        },
      ],
    },
    {
      schemaVersion: 2,
      flow: "ledger-api.open-an-account",
      repo: "forge-ledger",
      change: "modify",
      why: "An account has a currency",
      steps: [
        {
          op: "change",
          step: 1,
          what: "The account is inserted for the customer, in its currency",
          store: {
            table: "ledger-db.accounts",
            columns: ["customer_id", "currency"],
            types: { currency: "char(3)" },
            classification: { currency: "internal" },
            migration: "V2__account_currency.sql",
          },
        },
      ],
    },
    {
      schemaVersion: 2,
      flow: "web-app.add-a-customer",
      repo: "forge-web",
      change: "modify",
      why: "The form sends the phone number",
      steps: [
        {
          op: "change",
          step: 2,
          what: "POST the new customer, with the phone number",
          to: { component: "customers-api", entry: "POST /api/customers" },
          fields: { sends: ["firstName", "lastName", "email", "phone"] },
        },
      ],
    },
  ].map((d) => FlowDelta.parse(d));

describe("a change across the estate the facts make", () => {
  it("knows who calls each changed entry from the joins", () => {
    expect(endpointConsumers(e, "customers-api.post-customer")).toEqual(["web-app"]);
    expect(endpointConsumers(e, "ledger-api.forge-ledger-v1-ledger-openaccount")).toEqual([
      "customers-api",
    ]);
  });

  it("orders the deploy: the migration, then the API, then the front end that calls it", () => {
    const { needs } = deployNeeds(deltas(), e);
    expect(needs.map((n) => `${n.first} before ${n.then}`).sort()).toEqual([
      "code:forge-customers before code:forge-web",
      "code:forge-ledger before code:forge-customers",
      "migration:V2__account_currency.sql before code:forge-ledger",
      "migration:V2__customer_phone.sql before code:forge-customers",
    ]);
    const note = deployIssues(deltas(), undefined, e);
    expect(note.map((i) => i.message)).toEqual([
      "The target flows give no deploy order, and here the order matters: a migration runs before the code that needs it, and a callee deploys before its caller. Give it under deploy, one step a repo or migration, such as: 1. migration V2__account_currency.sql, in forge-ledger; 2. migration V2__customer_phone.sql, in forge-customers; 3. forge-ledger; 4. forge-customers; 5. forge-web.",
    ]);
    const right = [
      { repo: "forge-ledger", migration: "V2__account_currency.sql" },
      { repo: "forge-customers", migration: "V2__customer_phone.sql" },
      { repo: "forge-ledger" },
      { repo: "forge-customers" },
      { repo: "forge-web" },
    ];
    expect(deployIssues(deltas(), right, e)).toEqual([]);
    const callerFirst = [right[0]!, right[1]!, right[3]!, right[2]!, right[4]!];
    expect(deployIssues(deltas(), callerFirst, e).map((i) => i.rule)).toEqual([
      "delta.deploy-order",
    ]);
  });
});
