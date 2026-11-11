import type { Desc } from "./commands.js";
import { POOL, type Code, type Estate } from "./estate.js";
import type { Invariant } from "./invariants.js";
import { checkOrder, runSequence } from "./runner.js";
import { Cmd } from "./commands.js";

/**
 * One hand-written example per invariant (ADR 0195 point 10), on the same two invented Forge
 * repos: forge-ledger (slot 0) serves GET /accounts and listens to forge.payments.changed;
 * forge-payments (slot 1) calls GET ledger.forge.example/accounts, publishes
 * forge.payments.changed and serves POST /refunds. Each runs its commands and checks only its
 * own invariant, so it reads as the case the invariant is about.
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
 * The examples today's writers fail: each is of an invariant in KNOWN_FAILURES, and runs as a
 * known failure. The other known failures' examples pass today (the case they show is one the
 * writers get right; their counterexample is in regressions/). CS2 empties this list.
 */
export const FAILS_TODAY: ReadonlySet<Invariant> = new Set<Invariant>([
  "equivalence",
  "readers-never-destroy-facts",
  "links-are-live",
  "nothing-removed-unexplained",
  "upgrade-is-lossless",
  "undo-restores",
  "hand-edits-never-silently-lost",
  "large-removals-confirmed",
]);

export interface Example {
  invariant: Invariant;
  name: string;
  run: () => Promise<void>;
}

const seq = (invariant: Invariant, name: string, commands: Desc[]): Example => ({
  invariant,
  name,
  run: () =>
    runSequence(
      TWO,
      commands.map((d) => new Cmd(d)),
      new Set([invariant]),
    ),
});

export const EXAMPLES: Example[] = [
  seq(
    "equivalence",
    "a scan, verify --write of the ledger, and a scan give what a fresh build of those reads gives",
    [{ t: "scan" }, { t: "verify-write", slot: 0, ok: true }, { t: "scan" }],
  ),
  seq(
    "locality",
    "forge-payments drops its call and topic, and a scan changes only records of forge-payments or its arrows",
    [{ t: "scan" }, { t: "change-code", slot: 1, code: paymentsAlone }, { t: "scan" }],
  ),
  seq("idempotence", "the same scan, and the same verify --write, a second time change no byte", [
    { t: "scan" },
    { t: "again" },
    { t: "verify-write", slot: 0, ok: true },
    { t: "again" },
  ]),
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
      ),
  },
  seq(
    "failure-neutrality",
    "a reader failing, a repo not cloned and a refused verify --write leave what they couldn't read as it was",
    [
      { t: "scan" },
      { t: "change-code", slot: 0, code: ledgerMore },
      { t: "scan-reader-fails", slot: 0 },
      { t: "scan-not-cloned", slot: 0 },
      { t: "verify-write", slot: 0, ok: false },
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
  ),
  seq(
    "curation-survives",
    "a suppress of a ledger endpoint survives a scan and a verify --write of the ledger",
    [
      { t: "scan" },
      { t: "curate", action: "suppress", pick: 0 },
      { t: "scan" },
      { t: "verify-write", slot: 0, ok: true },
      { t: "scan" },
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
  ),
  seq(
    "nothing-removed-unexplained",
    "forge-payments' facts, checked but not written, remove none of its readers' records at the next scan",
    [
      { t: "change-code", slot: 1, code: paymentsLegacy },
      { t: "scan" },
      { t: "verify-live", slot: 1 },
      { t: "scan" },
    ],
  ),
  seq(
    "upgrade-is-lossless",
    "a dry run writes nothing, and --yes adopts every record into one legacy slot each",
    [{ t: "scan" }, { t: "upgrade", yes: false }, { t: "upgrade", yes: true }],
  ),
  seq("undo-restores", "undo after a scan that read a code change gives the catalog before it", [
    { t: "scan" },
    { t: "change-code", slot: 1, code: paymentsAlone },
    { t: "scan" },
    { t: "undo" },
  ]),
  seq(
    "hand-edits-never-silently-lost",
    "a hand edit to a generated file stops the next scan from writing until it is made curated or discarded",
    [{ t: "scan" }, { t: "hand-edit", pick: 0, how: "change" }, { t: "scan" }],
  ),
  seq(
    "large-removals-confirmed",
    "archiving forge-payments removes all of its records only once the removals are confirmed",
    [{ t: "scan" }, { t: "archive", slot: 1 }, { t: "scan" }],
  ),
];
