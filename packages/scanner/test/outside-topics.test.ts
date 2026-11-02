import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  DECLARED_TOPIC,
  loadOrgPack,
  TOPICS_OUTSIDE_LABEL,
  parseFacts,
  type Fact,
  type OrgPack,
} from "@maycombhq/core";
import {
  catalogWithFacts,
  hostAliases,
  outsideSystems,
  topicQuestionDrafts,
} from "../src/index.js";

/**
 * ADR 0162 (F8): a topic or queue no estate repo serves the other side of, named among an outside
 * system's topics in the profile (its amendment: `topics`, kept apart from aliases), lands on that system (another team's or a vendor's), marked
 * declared, never over a counterpart the estate has. On the invented bank-shaped estate
 * (fixtures/link-estate), with a publish, a send to a queue and a listener added.
 */

const FIX = join(__dirname, "..", "..", "..", "fixtures", "link-estate");
const factsOf = (repo: string): Fact[] => {
  const r = parseFacts(readFileSync(join(FIX, "facts", `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
const fact = (x: Record<string, unknown>) => {
  const r = parseFacts(JSON.stringify(x));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts[0]!;
};
const base = { verified: "line", by: "assistant", conf: "declared" };

/** forge-payments sends to Lantern Mail's outbox queue; forge-cards listens to Harbor Audit's topic. */
const payments = (also: Fact[] = []) => [
  ...factsOf("forge-payments"),
  fact({
    kind: "call",
    id: "call.mq.outbox",
    repo: "forge-payments",
    commit: "c3c0006",
    callType: "mq-queue",
    path: "LANTERN.MAIL.OUTBOX",
    from: "entry.post.payments",
    sync: "async",
    cite: {
      file: "src/main/java/forge/payments/PaymentsService.java",
      line: 28,
      value: "LANTERN.MAIL.OUTBOX",
      quote: 'jms.send("LANTERN.MAIL.OUTBOX", receipt);',
    },
    ...base,
  }),
  ...also,
];
const cards = () => [
  ...factsOf("forge-cards"),
  fact({
    kind: "entry",
    id: "entry.on.audit-events",
    repo: "forge-cards",
    commit: "c3c0007",
    entryType: "event-topic",
    path: "harbor.audit.events",
    handler: "AuditListener.on",
    cite: {
      file: "src/main/java/forge/cards/AuditListener.java",
      line: 9,
      value: "harbor.audit.events",
      quote: '@KafkaListener(topics = "harbor.audit.events")',
    },
    ...base,
  }),
];

let op: OrgPack;
beforeAll(async () => {
  const loaded = await loadOrgPack(join(FIX, "org-pack"));
  op = {
    ...loaded,
    profiles: loaded.profiles.map((p) => ({
      ...p,
      profile: p.profile && {
        ...p.profile,
        systems: p.profile.systems.map((s) =>
          s.id === "harbor-audit"
            ? { ...s, topics: ["harbor.audit.events"] }
            : s.id === "lantern-mail"
              ? { ...s, topics: ["LANTERN.MAIL.OUTBOX"] }
              : s,
        ),
      },
    })),
  } as OrgPack;
});

const write = (repo: string, facts: Fact[], others: { repo: string; facts: Fact[] }[]) =>
  catalogWithFacts({ repo, facts, existing: [], op, decisions: [], estate: others });

const iface = (rs: { kind: string }[], from: string, to: string) =>
  rs.find(
    (r) =>
      r.kind === "Interface" &&
      (r as unknown as { from: string }).from === from &&
      (r as unknown as { to: string }).to === to,
  ) as
    | { confidence: string; flags?: string[]; via: string; evidence: { source: string }[] }
    | undefined;

describe("topics and queues of another team or a vendor (ADR 0162)", () => {
  it("lands a send to a vendor's queue on the vendor, declared", () => {
    const out = write("forge-payments", payments(), [{ repo: "forge-cards", facts: cards() }]);
    expect(out.invalid).toEqual([]);
    const i = iface(out.records, "payments-api", "lantern-mail");
    expect(i).toMatchObject({ confidence: "asserted", flags: [DECLARED_TOPIC], via: "event-bus" });
    expect(i!.evidence.map((e) => e.source).sort()).toEqual(["code", "manual"]);
    expect(
      out.records.some(
        (r) => r.kind === "Unresolved" && (r as { raw?: string }).raw === "LANTERN.MAIL.OUTBOX",
      ),
    ).toBe(false);
  });

  it("lands a listener on another team's topic on their system, declared", () => {
    const out = write("forge-cards", cards(), [{ repo: "forge-payments", facts: payments() }]);
    expect(iface(out.records, "harbor-audit", "cards-api")).toMatchObject({
      confidence: "asserted",
      flags: [DECLARED_TOPIC],
    });
  });

  it("never over a topic an estate repo publishes: the code's link stands", () => {
    const publishes = fact({
      kind: "call",
      id: "call.publish.audit",
      repo: "forge-payments",
      commit: "c3c0006",
      callType: "event-topic",
      path: "harbor.audit.events",
      from: "entry.post.payments",
      sync: "async",
      cite: {
        file: "src/main/java/forge/payments/PaymentsService.java",
        line: 29,
        value: "harbor.audit.events",
        quote: 'kafka.send("harbor.audit.events", audit);',
      },
      ...base,
    });
    const out = write("forge-cards", cards(), [
      { repo: "forge-payments", facts: payments([publishes]) },
    ]);
    expect(iface(out.records, "harbor-audit", "cards-api")).toBeUndefined();
    expect(iface(out.records, "payments-api", "cards-api")?.flags ?? []).not.toContain(
      DECLARED_TOPIC,
    );
  });
});

describe("the topics question (ADR 0162)", () => {
  it("asks who owns a topic no repo serves the other side of and no system names", () => {
    const plain = { ...op, profiles: op.profiles.map((p) => ({ ...p })) } as OrgPack;
    const bare = {
      ...plain,
      profiles: plain.profiles.map((p) => ({
        ...p,
        profile: p.profile && {
          ...p.profile,
          systems: p.profile.systems.map((s) => ({
            ...s,
            topics: (s.topics ?? []).filter((a) => a !== "harbor.audit.events"),
          })),
        },
      })),
    } as OrgPack;
    const out = catalogWithFacts({
      repo: "forge-cards",
      facts: cards(),
      existing: [],
      op: bare,
      decisions: [],
      estate: [{ repo: "forge-payments", facts: payments() }],
    });
    const qs = topicQuestionDrafts("forge-cards", out.records);
    expect(qs.map((q) => q.draft.question)).toEqual([
      "Who owns the topic harbor.audit.events, which cards-api listens on?",
    ]);
    expect(qs[0]!.draft.evidence).toEqual(["src/main/java/forge/cards/AuditListener.java:9"]);
    expect(qs[0]!.draft.options.map((o) => o.label)).toEqual([
      TOPICS_OUTSIDE_LABEL,
      "None of these",
    ]);
    // With the topic in the profile, it lands, and nothing is asked.
    const landed = write("forge-cards", cards(), [{ repo: "forge-payments", facts: payments() }]);
    expect(topicQuestionDrafts("forge-cards", landed.records)).toEqual([]);
  });
});

describe("topics apart from aliases (ADR 0162 amendment, review item 15)", () => {
  /** The profile with Harbor Audit's topic written among its aliases, as beta.11 builds did. */
  const asAlias = () =>
    ({
      ...op,
      profiles: op.profiles.map((p) => ({
        ...p,
        profile: p.profile && {
          ...p.profile,
          systems: p.profile.systems.map((s) =>
            s.id === "harbor-audit"
              ? { ...s, topics: [], aliases: [...s.aliases, "harbor.audit.events"] }
              : s,
          ),
        },
      })),
    }) as OrgPack;

  it("reads a system's topics only: a topic among its aliases doesn't land", () => {
    const out = catalogWithFacts({
      repo: "forge-cards",
      facts: cards(),
      existing: [],
      op: asAlias(),
      decisions: [],
      estate: [{ repo: "forge-payments", facts: payments() }],
    });
    expect(iface(out.records, "harbor-audit", "cards-api")).toBeUndefined();
    expect(topicQuestionDrafts("forge-cards", out.records).map((q) => q.topic)).toEqual([
      "harbor.audit.events",
    ]);
  });

  it("keeps a dotted topic out of the names and hosts a call joins an outside system by", () => {
    expect(outsideSystems(op)).not.toContain("harbor.audit.events");
    expect(outsideSystems(op)).not.toContain("LANTERN.MAIL.OUTBOX");
    const lantern = op.profiles
      .flatMap((p) => p.profile?.systems ?? [])
      .find((s) => s.id === "lantern-mail")!;
    expect(hostAliases(lantern.aliases)).toEqual(["api.lanternmail.example"]);
  });
});
