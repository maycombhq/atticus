import type { Desc } from "./commands.js";
import { POOL, type Code, type Estate } from "./estate.js";
import { InvariantError, type Invariant } from "./invariants.js";
import { checkOrder, runSequence } from "./runner.js";
import { Cmd } from "./commands.js";
import { records, type Rec, type World } from "./world.js";

/**
 * One hand-written example per invariant (ADR 0195 point 10), on the same two invented Forge
 * repos: forge-ledger (slot 0) serves GET /accounts and listens to forge.payments.changed;
 * forge-payments (slot 1) calls GET ledger.forge.example/accounts, publishes
 * forge.payments.changed and serves POST /refunds. Each runs its commands, checks only its own
 * invariant, and then asserts what the catalog holds at the end: a system that writes nothing,
 * or refuses everything, fails every example.
 */

const ledger = POOL.find((b) => b.id === "forge-ledger")!;
const payments = POOL.find((b) => b.id === "forge-payments")!;

const ledgerCode: Code = {
  endpoints: [{ method: "GET", path: "/accounts" }],
  calls: [],
  publishes: [],
  consumes: [payments.topic],
};
const paymentsCode: Code = {
  endpoints: [{ method: "POST", path: "/refunds" }],
  calls: [{ method: "GET", path: "/accounts", host: ledger.host }],
  publishes: [payments.topic],
  consumes: [],
};
export const TWO: Estate = {
  repos: [
    { base: ledger, code: ledgerCode },
    { base: payments, code: paymentsCode },
  ],
};

/** forge-payments without its call to the ledger and without its topic. */
const paymentsAlone: Code = { ...paymentsCode, calls: [], publishes: [] };
/** forge-payments also calling a host no repo lists (a loose end until someone answers). */
const paymentsLegacy: Code = {
  ...paymentsCode,
  calls: [...paymentsCode.calls, { method: "POST", path: "/entries", host: ledger.legacyHost }],
};
/** forge-ledger serving one more endpoint. */
const ledgerMore: Code = {
  ...ledgerCode,
  endpoints: [...ledgerCode.endpoints, { method: "POST", path: "/entries" }],
};

/**
 * The examples today's writers fail: each is of an invariant in KNOWN_FAILURES, and must fail
 * with it (the test says so when one starts passing). CS2 empties this list.
 */
export const FAILS_TODAY: ReadonlySet<Invariant> = new Set<Invariant>([]);

export interface Example {
  invariant: Invariant;
  name: string;
  run: () => Promise<void>;
}

/** What the catalog must hold at the end of an example: a sentence when it doesn't. */
type Holds = (recs: Rec[]) => string | undefined;

const endpoint = (component: string, method: string, path: string) => (recs: Rec[]) =>
  recs.find(
    (r) =>
      r.kind === "Endpoint" &&
      r.component === component &&
      r.method === method &&
      r.pathOrTopic === path,
  );
const arrow =
  (from: string, to: string, method: string | undefined, path: string) => (recs: Rec[]) =>
    recs.find(
      (r) =>
        r.kind === "Interface" &&
        r.from === from &&
        r.to === to &&
        r.method === method &&
        r.normalizedPath === path,
    );
const getAccounts = endpoint("ledger-api", "GET", "/accounts");
const postRefunds = endpoint("payments-api", "POST", "/refunds");
const callsLedger = arrow("payments-api", "ledger-api", "GET", "/accounts");
const topic = arrow("payments-api", "ledger-api", undefined, payments.topic);

const has =
  (what: string, f: (recs: Rec[]) => Rec | undefined): Holds =>
  (recs) =>
    f(recs) ? undefined : `the catalog has no ${what}`;
const lacks =
  (what: string, f: (recs: Rec[]) => Rec | undefined): Holds =>
  (recs) =>
    f(recs) ? `the catalog still has ${what}` : undefined;
const byAssistant =
  (what: string, f: (recs: Rec[]) => Rec | undefined): Holds =>
  (recs) => {
    const r = f(recs);
    return r && (r.evidence ?? []).some((e) => e.by === "assistant")
      ? undefined
      : `${what} isn't projected from the verified facts`;
  };

async function holds(invariant: Invariant, w: World, checks: Holds[]): Promise<void> {
  const recs = [...records((await w.snap()).generated).values()];
  for (const c of checks) {
    const why = c(recs);
    if (why) throw new InvariantError(invariant, `at the end of the example, ${why}`);
  }
}

const seq = (
  invariant: Invariant,
  name: string,
  commands: Desc[],
  checks: Holds[],
  estate: Estate = TWO,
): Example => ({
  invariant,
  name,
  run: () =>
    runSequence(
      estate,
      [],
      commands.map((d) => new Cmd(d)),
      new Set([invariant]),
      (w) => holds(invariant, w, checks),
    ),
});

export const EXAMPLES: Example[] = [
  seq(
    "equivalence",
    "a scan, verify --write of the ledger, and a scan give what a fresh build of those reads gives",
    [{ t: "scan" }, { t: "verify-write", slot: 0, ok: true }, { t: "scan" }],
    [
      byAssistant("the ledger's GET /accounts", getAccounts),
      has("payments' POST /refunds", postRefunds),
      has("arrow from payments to GET /accounts", callsLedger),
      has("arrow for forge.payments.changed", topic),
    ],
  ),
  seq(
    "locality",
    "forge-payments drops its call and topic, and a scan changes only records of forge-payments or its arrows",
    [{ t: "scan" }, { t: "change-code", slot: 1, code: paymentsAlone }, { t: "scan" }],
    [has("ledger's GET /accounts", getAccounts), lacks("the arrow from payments", callsLedger)],
  ),
  seq(
    "idempotence",
    "the same scan, the same verify --write and the same build a second time change no byte",
    [
      { t: "scan" },
      { t: "again" },
      { t: "verify-write", slot: 0, ok: true },
      { t: "again" },
      { t: "build" },
      { t: "again" },
    ],
    [byAssistant("the ledger's GET /accounts", getAccounts), has("the arrow", callsLedger)],
  ),
  {
    invariant: "order-independence",
    name: "verify --write of the ledger then of payments gives the bytes of the other order",
    run: () =>
      checkOrder(
        TWO,
        [{ t: "scan" }],
        [
          { t: "verify-write", slot: 0, ok: true },
          { t: "verify-write", slot: 1, ok: true },
        ],
        (w) =>
          holds("order-independence", w, [
            byAssistant("the ledger's GET /accounts", getAccounts),
            byAssistant("payments' POST /refunds", postRefunds),
            has("the arrow", callsLedger),
          ]),
      ),
  },
  seq(
    "failure-neutrality",
    "a reader failing, a repo not cloned, a refused verify --write, a cancelled scan and a scan that read nothing leave what they couldn't read as it was",
    [
      { t: "scan" },
      { t: "change-code", slot: 0, code: ledgerMore },
      { t: "scan-reader-fails", slot: 0 },
      { t: "scan-not-cloned", slot: 0 },
      { t: "verify-write", slot: 0, ok: false },
      { t: "scan-cancelled" },
      { t: "scan-nothing" },
    ],
    [
      has("ledger's GET /accounts", getAccounts),
      lacks(
        "ledger's POST /entries, which no run read",
        endpoint("ledger-api", "POST", "/entries"),
      ),
    ],
  ),
  seq(
    "readers-never-destroy-facts",
    "after verify --write of the ledger, its code moves on and a scan leaves the records its facts made",
    [
      { t: "scan" },
      { t: "verify-write", slot: 0, ok: true },
      { t: "change-code", slot: 0, code: ledgerMore },
      { t: "scan" },
    ],
    [
      byAssistant("the ledger's GET /accounts", getAccounts),
      lacks(
        "ledger's POST /entries, which only the readers saw",
        endpoint("ledger-api", "POST", "/entries"),
      ),
    ],
  ),
  seq(
    "curation-survives",
    "a suppress of a ledger endpoint survives a scan and a verify --write of the ledger, each removal confirmed with its count",
    [
      { t: "scan" },
      { t: "curate", action: "suppress", pick: 0 },
      { t: "confirm-removals" },
      { t: "scan" },
      { t: "verify-write", slot: 0, ok: true },
      { t: "confirm-removals" },
      { t: "scan" },
      { t: "curate", action: "assert", pick: 0 },
      { t: "confirm-removals" },
    ],
    [
      lacks("ledger's GET /accounts, suppressed", getAccounts),
      (recs) =>
        postRefunds(recs)?.auth === "oauth2"
          ? undefined
          : "payments' POST /refunds hasn't the asserted auth: oauth2",
    ],
  ),
  seq(
    "links-are-live",
    "forge-payments drops its call, a scan of it alone and a verify --write leave no arrow from it",
    [
      { t: "scan" },
      { t: "change-code", slot: 1, code: paymentsAlone },
      { t: "scan-subset", slots: [1] },
      { t: "verify-write", slot: 0, ok: true },
    ],
    [lacks("the arrow from payments", callsLedger), has("ledger's GET /accounts", getAccounts)],
  ),
  seq(
    "nothing-removed-unexplained",
    "facts checked but not written remove nothing, and an answer naming the ledger's own legacy host removes the loose end, listed",
    [
      { t: "change-code", slot: 1, code: paymentsLegacy },
      { t: "scan" },
      { t: "verify-live", slot: 1 },
      { t: "scan" },
      { t: "answer", host: 0, to: "self" },
    ],
    [
      has("payments' POST /refunds", postRefunds),
      lacks("the loose end to legacy-ledger.forge.example, answered", (recs) =>
        recs.find((r) => r.kind === "Unresolved" && String(r.raw).includes(ledger.legacyHost)),
      ),
      has(
        "arrow from payments to the ledger's POST /entries, by the answer",
        arrow("payments-api", "ledger-api", "POST", "/entries"),
      ),
    ],
  ),
  seq(
    "upgrade-is-lossless",
    "a beta.26 metarepo: a dry run writes nothing, --yes adopts every record into one legacy slot each, and a scan after keeps the arrows",
    [
      { t: "seed-beta26", verify: [0] },
      { t: "upgrade", yes: false },
      { t: "upgrade", yes: true },
      { t: "scan-subset", slots: [0] },
      { t: "confirm-removals" },
    ],
    [
      has("the arrow from payments", callsLedger),
      has("the topic's arrow", topic),
      has("payments' POST /refunds, from its legacy slot", postRefunds),
    ],
  ),
  seq(
    "undo-restores",
    "an undo of a scan can be undone, and undo 2 takes back a confirmed scan and an assert after it",
    [
      { t: "scan" },
      { t: "undo", n: 0, yes: true, back: true },
      { t: "change-code", slot: 1, code: paymentsAlone },
      { t: "scan" },
      { t: "confirm-removals" },
      { t: "curate", action: "assert", pick: 0 },
      { t: "undo", n: 1, yes: false },
      { t: "undo", n: 1, yes: true, back: false },
    ],
    [has("arrow from payments, its old read restored", callsLedger)],
  ),
  seq(
    "hand-edits-never-silently-lost",
    "a hand edit stops the next scan until it is discarded with its count; another made curated is kept",
    [
      { t: "scan" },
      { t: "hand-edit", pick: 0, how: "change" },
      { t: "scan" },
      { t: "discard-edits", wrong: true },
      { t: "discard-edits" },
      { t: "hand-edit", pick: 1, how: "change" },
      { t: "curate-edits" },
      { t: "scan" },
    ],
    [
      (recs) =>
        getAccounts(recs)?.auth === "mtls"
          ? "the discarded edit of GET /accounts stayed"
          : undefined,
      (recs) =>
        postRefunds(recs)?.auth === "mtls"
          ? undefined
          : "POST /refunds lost the auth: mtls a person set by hand and made curated",
    ],
  ),
  seq(
    "large-removals-confirmed",
    "archiving forge-payments removes its records only with --allow-removals of the count listed",
    [
      { t: "scan" },
      { t: "archive", slot: 1 },
      { t: "confirm-removals", wrong: true },
      { t: "confirm-removals" },
    ],
    [lacks("payments' POST /refunds", postRefunds), has("ledger's GET /accounts", getAccounts)],
  ),
  seq(
    "completeness",
    "each command does what it was asked: a scan writes both repos, an assert and a build take, and a rename keeps the repo",
    [
      { t: "scan" },
      { t: "curate", action: "assert", pick: 1 },
      { t: "build" },
      { t: "rename", slot: 0 },
      { t: "prune", yes: false },
    ],
    [
      has("ledger's GET /accounts", getAccounts),
      (recs) =>
        postRefunds(recs)?.auth === "oauth2" ? undefined : "POST /refunds hasn't auth: oauth2",
      has("the arrow", callsLedger),
    ],
  ),
];
