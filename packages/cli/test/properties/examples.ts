import type { Desc } from "./commands.js";
import { POOL, type Code, type Estate } from "./estate.js";
import { InvariantError, type Invariant } from "./invariants.js";
import { checkOrder, estateOf, runSequence } from "./runner.js";
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

/** A repo whose code serves, calls, publishes and listens to nothing. */
const empty: Code = { endpoints: [], calls: [], publishes: [], consumes: [] };
/** forge-payments without its call to the ledger and without its topic. */
const paymentsAlone: Code = { ...paymentsCode, calls: [], publishes: [] };
/** forge-payments also calling a host no repo lists (a loose end until someone answers). */
const paymentsLegacy: Code = {
  ...paymentsCode,
  calls: [...paymentsCode.calls, { method: "POST", path: "/entries", host: ledger.legacyHost }],
};
/**
 * Three repos where forge-payments calls two of forge-notify's endpoints, one of them not served:
 * the property run's shrunk estate (seed 615329782) for a suppressed legacy join.
 */
const notify = POOL.find((b) => b.id === "forge-notify")!;
const orders = POOL.find((b) => b.id === "forge-orders")!;
const customers = POOL.find((b) => b.id === "forge-customers")!;
const THREE: Estate = {
  repos: [
    {
      base: notify,
      code: {
        endpoints: [{ method: "GET", path: "/notices" }],
        calls: [{ method: "GET", path: "/accounts", host: ledger.host }],
        publishes: [notify.topic],
        consumes: [ledger.topic],
      },
    },
    {
      base: ledger,
      code: { endpoints: [], calls: [], publishes: [], consumes: [notify.topic] },
    },
    {
      base: payments,
      code: {
        endpoints: [],
        calls: [
          { method: "GET", path: "/channels", host: notify.host },
          { method: "POST", path: "/templates", host: notify.host },
        ],
        publishes: [payments.topic],
        consumes: [],
      },
    },
  ],
};

/** The same run's shrunk estate for a derived arrow suppressed by a hand deletion made curated. */
const FOUR: Estate = estateOf({
  repos: [
    {
      base: "forge-orders",
      code: {
        endpoints: [{ method: "GET", path: "/orders" }],
        calls: [{ method: "GET", path: "/payments", host: "payments.forge.example" }],
        publishes: ["forge.orders.changed"],
        consumes: ["forge.notify.changed"],
      },
    },
    {
      base: "forge-notify",
      code: {
        endpoints: [],
        calls: [{ method: "POST", path: "/carts", host: "orders.forge.example" }],
        publishes: [],
        consumes: ["forge.payments.changed"],
      },
    },
    {
      base: "forge-ledger",
      code: {
        endpoints: [],
        calls: [
          { method: "GET", path: "/orders", host: "orders.forge.example" },
          { method: "POST", path: "/carts", host: "orders.forge.example" },
        ],
        publishes: ["forge.ledger.changed"],
        consumes: [],
      },
    },
    {
      base: "forge-payments",
      code: {
        endpoints: [{ method: "GET", path: "/payments" }],
        calls: [{ method: "GET", path: "/orders", host: "orders.forge.example" }],
        publishes: [],
        consumes: ["forge.orders.changed"],
      },
    },
  ],
});

/** The same run's shrunk estate for a removal listing carried through a hand-edit refusal. */
const FILLED: Estate = estateOf({
  repos: [
    {
      base: "forge-ledger",
      code: {
        endpoints: [],
        calls: [],
        publishes: [],
        consumes: ["forge.payments.changed"],
        filler: 10,
      },
    },
    {
      base: "forge-payments",
      code: {
        endpoints: [],
        calls: [{ method: "GET", path: "/accounts", host: "ledger.forge.example" }],
        publishes: ["forge.payments.changed"],
        consumes: [],
        filler: 10,
      },
    },
    {
      base: "forge-orders",
      code: { endpoints: [], calls: [], publishes: [], consumes: [], filler: 10 },
    },
  ],
});

/** forge-ledger no longer serving GET /accounts. */
const ledgerWithout: Code = { ...ledgerCode, endpoints: [] };
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
    "a reader failing, a repo not cloned, a refused verify --write, a cancelled scan, a scan that read nothing and a rename whose slots don't read or whose write stops part way leave what they couldn't read as it was",
    [
      { t: "scan" },
      { t: "change-code", slot: 0, code: ledgerMore },
      { t: "scan-reader-fails", slot: 0 },
      { t: "scan-not-cloned", slot: 0 },
      { t: "verify-write", slot: 0, ok: false },
      { t: "scan-cancelled" },
      { t: "scan-nothing" },
      { t: "rename", slot: 0, fail: true },
      { t: "crash", at: "mid-records", via: "rename", slot: 0 },
      { t: "crash", at: "after-slots", via: "rename", slot: 1 },
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
    "links-are-live",
    "after the upgrade the callee is read afresh while the caller stays legacy: the arrow stays a legacy join, so a later change to the callee doesn't explain it away",
    [
      { t: "seed-beta26", verify: [] },
      { t: "upgrade", yes: true },
      // The ledger (the callee) read afresh; forge-payments (the caller) stays a legacy slot,
      // whose records hold no call to derive the arrow from.
      { t: "scan-subset", slots: [0] },
      { t: "confirm-removals" },
      { t: "change-code", slot: 0, code: ledgerWithout },
      { t: "scan-subset", slots: [0] },
      { t: "confirm-removals" },
    ],
    [
      has("the arrow from payments to GET /accounts, kept from before the upgrade", callsLedger),
      has("the topic's arrow, kept from before the upgrade", topic),
      lacks("ledger's GET /accounts, which its new read doesn't serve", getAccounts),
    ],
  ),
  seq(
    "completeness",
    "after the upgrade a person deletes a legacy join's arrow by hand and makes it curated: the suppress takes it out, and the build is not expected to keep it",
    [
      { t: "seed-beta26", verify: [] },
      { t: "upgrade", yes: true },
      { t: "hand-edit", pick: 37, how: "delete" },
      { t: "curate-edits" },
    ],
    [
      lacks(
        "the arrow from payments to POST /templates, suppressed",
        arrow("payments-api", "notify-api", "POST", "/templates"),
      ),
      has(
        "the arrow from payments to GET /channels, kept from before the upgrade",
        arrow("payments-api", "notify-api", "GET", "/channels"),
      ),
    ],
    THREE,
  ),
  seq(
    "completeness",
    "after the upgrade and a scan a person deletes a derived arrow by hand and makes it curated: the build is not expected to make it",
    [
      { t: "seed-beta26", verify: [] },
      { t: "upgrade", yes: true },
      { t: "scan" },
      { t: "hand-edit", pick: 35, how: "delete" },
      { t: "curate-edits" },
    ],
    [
      lacks(
        "the arrow from payments to GET /orders, suppressed",
        arrow("payments-api", "orders-api", "GET", "/orders"),
      ),
    ],
    FOUR,
  ),
  seq(
    "completeness",
    "a removal listing carried through a confirmation that met hand edits keeps its age: a scan acted since, so the discard that confirms it is judged by its count",
    [
      { t: "verify-write", slot: 4, ok: true },
      { t: "verify-write", slot: 0, ok: true },
      { t: "scan-subset", slots: [0] },
      { t: "hand-edit", pick: 0, how: "change" },
    ],
    [has("the topic's arrow", topic)],
    FILLED,
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
  seq(
    "completeness",
    "an undo that took back the upgrade is itself undone, not refused as not upgraded, and a scan then writes",
    [
      { t: "seed-beta26", verify: [0] },
      { t: "upgrade", yes: true },
      { t: "undo", n: 0, yes: true, back: true },
      { t: "scan" },
      { t: "confirm-removals" },
    ],
    [has("the arrow", callsLedger), has("payments' POST /refunds", postRefunds)],
  ),
  seq(
    "nothing-removed-unexplained",
    "a removal after an upgrade migrated the org pack may be said as an input's, and is listed (seed 1349124163)",
    [{ t: "scan-subset", slots: [3, 0] }, { t: "upgrade", yes: false }, { t: "scan" }],
    [has("orders' POST /carts", endpoint(orders.component, "POST", "/carts"))],
    {
      repos: [
        {
          base: orders,
          code: {
            endpoints: [{ method: "POST", path: "/carts" }],
            calls: [],
            publishes: [],
            consumes: [],
          },
        },
        {
          base: ledger,
          code: { endpoints: [], calls: [], publishes: [ledger.topic], consumes: [] },
        },
        { base: notify, code: { endpoints: [], calls: [], publishes: [], consumes: [] } },
        {
          base: payments,
          code: {
            endpoints: [],
            calls: [{ method: "POST", path: "/carts", host: orders.host }],
            publishes: [],
            consumes: [ledger.topic],
          },
        },
      ],
    },
  ),
  seq(
    "equivalence",
    "a scan refused for a removal, confirmed into the hand-edits guard, settles once the edit is made curated (seed 1344785347)",
    [
      { t: "verify-write", slot: 0, ok: true },
      { t: "scan" },
      { t: "hand-edit", pick: 0, how: "delete" },
      { t: "confirm-removals" },
      { t: "curate-edits" },
      { t: "prune", yes: false },
    ],
    [
      has("arrow for forge.payments.changed", topic),
      lacks("the ledger's loose end for forge.payments.changed", (recs) =>
        recs.find((r) => r.kind === "Unresolved"),
      ),
    ],
    {
      repos: [
        { base: ledger, code: { ...ledgerCode, endpoints: [] } },
        { base: payments, code: { ...paymentsCode, endpoints: [], calls: [] } },
      ],
    },
  ),
  seq(
    "equivalence",
    "a rename undone leaves the ledger's slot under its old id and the manifest under the new: the settling build lists its records as removals, and settles once confirmed with that count (seed 1351551411)",
    // ADR 0195 point 7 and the joint review: `catalog undo` puts back the rename's slots, record
    // files and build.json, not the inputs it renamed (the manifest entry among them), so the old
    // slot is orphaned and forge-ledger-core has no slot until it is scanned.
    [{ t: "scan" }, { t: "rename", slot: 0 }, { t: "undo", n: 0, yes: true, back: false }],
    [
      lacks("the ledger's GET /accounts, whose slot no listed repo has", getAccounts),
      has("payments' POST /refunds", postRefunds),
    ],
  ),
  seq(
    "nothing-removed-unexplained",
    "after a rename undone, the confirmed build's removals of the ledger's records may be said as the manifest's: their evidence names an id no manifest lists, its slot kept (seed 1351551411)",
    [{ t: "scan" }, { t: "rename", slot: 0 }, { t: "undo", n: 0, yes: true, back: false }],
    [lacks("the ledger's GET /accounts, whose slot no listed repo has", getAccounts)],
  ),
  seq(
    "completeness",
    "archiving payments when the ledger's only source is a facts file with no fact is refused as an empty catalog, and the catalog is kept (seed 1754877814)",
    // ADR 0195 point 4: no empty catalog over a full one, unless the manifests list no repo. The
    // ledger is listed and read, but its verified facts hold no fact, so they make no record:
    // with payments archived the build has no record from code, and it refuses.
    [
      { t: "change-code", slot: 1, code: { ...empty, publishes: [payments.topic] } },
      { t: "verify-write", slot: 0, ok: true },
      { t: "verify-write", slot: 1, ok: true },
      { t: "archive", slot: 1 },
    ],
    [
      has("payments' own Component, kept by the refusal", (recs) =>
        recs.find((r) => r.kind === "Component" && r.id === payments.component),
      ),
    ],
    {
      repos: [
        { base: ledger, code: empty },
        { base: payments, code: empty },
      ],
    },
  ),
  seq(
    "equivalence",
    "a verify --write refused for a removal, its repo then archived, settles without its confirmation: the refused command no longer runs (seed 1754877814)",
    // ADR 0195 point 4: a refused command writes nothing, and its listing waits for its own
    // confirmation. Archiving forge-payments leaves it unread, so `verify --write` of it is no
    // longer one to confirm: its listing is moot, and the build of the rest settles.
    [
      { t: "change-code", slot: 1, code: { ...empty, publishes: [payments.topic] } },
      { t: "verify-write", slot: 0, ok: true },
      { t: "verify-write", slot: 1, ok: true },
      { t: "archive", slot: 1 },
    ],
    [
      has("the ledger's loose end for forge.payments.changed, no repo publishing it", (recs) =>
        recs.find((r) => r.kind === "Unresolved"),
      ),
      lacks("payments' own Component", (recs) =>
        recs.find((r) => r.kind === "Component" && r.id === payments.component),
      ),
    ],
    {
      repos: [
        { base: ledger, code: { ...empty, consumes: [payments.topic] } },
        { base: payments, code: empty },
      ],
    },
  ),
  seq(
    "locality",
    "an archive refused for a hand edit leaves the manifest archived: the scan whose build takes it in may change the system's repos, a record of the manifests' (seed -1183949415)",
    // ADR 0195 point 4: archiving is the person's change to the manifest, an input, followed by
    // a build, and it is the build a guard refuses. A refused command writes nothing under
    // catalog/ (no slot, no record file, no build.json); the manifest is the person's own file and
    // stays as they left it, as a curated file does. The next build that writes takes it in, here
    // the scan's, confirmed by discarding the edit. A System lists its repos from the manifests,
    // so it changes with them, though no repo's evidence names it.
    [
      { t: "scan-reader-fails", slot: 1 },
      { t: "hand-edit", pick: 0, how: "change" },
      { t: "archive", slot: 1 },
      { t: "scan" },
    ],
    [
      has("the ledger's GET /accounts", getAccounts),
      has("payments' system, listing no repo now that its one repo is archived", (recs) =>
        recs.find(
          (r) =>
            r.kind === "System" &&
            r.id === payments.system &&
            Array.isArray(r.repos) &&
            !r.repos.includes(payments.id),
        ),
      ),
    ],
  ),
  seq(
    "completeness",
    "an archive refused as a large removal leaves the manifest archived; a hand edit to the archived ledger's record is made curated against the record as the last build made it (seed -2093340699)",
    // ADR 0195 point 4: a hand edit is made curated, and the assert waits, orphaned, while the
    // build no longer makes its record. The ledger's readers slot holds what the readers gave,
    // not what the build made of it (the merge names an endpoint by its path), so
    // `edits --curate` reads the edit against what the build makes with the ledger not archived.
    [
      { t: "scan" },
      { t: "archive", slot: 0 },
      { t: "hand-edit", pick: 0, how: "change" },
      { t: "curate-edits" },
    ],
    [has("payments' POST /refunds", postRefunds)],
  ),
  seq(
    "completeness",
    "a removal refused as large leaves the manifest without the ledger; a hand edit to its record is made curated against the record as the last build wrote it (seeds -2093340699, 1361862919)",
    // As above, for a repo taken out of the manifests: its entry is gone, so `edits --curate`
    // lists it again from its slot's Component, and uses a record of it only when its text is
    // the one build.json hashed.
    [
      { t: "scan" },
      { t: "remove", slot: 0 },
      { t: "hand-edit", pick: 0, how: "change" },
      { t: "curate-edits" },
    ],
    [has("payments' POST /refunds", postRefunds)],
  ),
  seq(
    "large-removals-confirmed",
    "an archive refused, then a record deleted by hand and one changed: the discard's confirmation counts the changed one, not the file already deleted (seed 1361807166)",
    // ADR 0195 point 4: a large removal is confirmed with the count the refusal listed. A file
    // the person deleted is no removal of the build's (it is gone already, and the discard of
    // the edit confirms it); a changed one whose record the build no longer makes is.
    [
      { t: "scan" },
      { t: "archive", slot: 3 },
      { t: "hand-edit", pick: 0, how: "delete" },
      { t: "hand-edit", pick: 0, how: "change" },
      { t: "verify-live", slot: 0 },
    ],
    [has("payments' Component", (recs) => recs.find((r) => r.id === payments.component))],
    {
      repos: [
        { base: payments, code: { ...empty, publishes: [payments.topic] } },
        { base: ledger, code: { ...ledgerCode, consumes: [payments.topic] } },
      ],
    },
  ),
  seq(
    "large-removals-confirmed",
    "a record changed by hand and one added, then its repo removed: the discard's confirmation counts the changed one, not the added one, which the build never made (seed 1361868403)",
    [
      { t: "scan" },
      { t: "hand-edit", pick: 9, how: "change" },
      { t: "hand-edit", pick: 0, how: "add" },
      { t: "remove", slot: 0 },
    ],
    [lacks("the ledger's GET /accounts", getAccounts)],
    {
      repos: [
        { base: ledger, code: { ...ledgerCode, consumes: [] } },
        {
          base: customers,
          code: { ...empty, endpoints: [{ method: "GET", path: "/customers" }] },
        },
      ],
    },
  ),
];
