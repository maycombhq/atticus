import { describe, expect, it } from "vitest";
import { Dialect } from "@maycombhq/core";
import { memoryRepo, scanRepo } from "@maycombhq/sdk";
import { dialectExtractor, runDialectTests } from "../src/index.js";

const SHA = "0".repeat(40);

/** A house Terraform module that provisions a Kafka topic, read through a dialect (ADR 0056). */
const topicRule = {
  id: "house-topic",
  description: "A tide-kafka-topic module provisions an event topic.",
  match: { hclBlock: "module", files: ["**/*.tf"] },
  where: [{ value: "${attr.source}", matches: "tide-kafka-topic" }],
  emit: {
    kind: "Endpoint",
    id: "ep-${attr.owner_team}-topic-${attr.name|slug}",
    fields: {
      component: "${attr.owner_team}",
      endpointType: "event-topic",
      pathOrTopic: "${attr.name}",
    },
    evidence: { source: "infrastructure", side: "definition" },
  },
  confidence: "verified",
};

const infra = {
  "topics/main.tf": `variable "env" { default = "prod" }
locals { team = "cards" }

module "statements_topic" {
  source     = "git::https://git.tide.internal/platform/tide-kafka-topic.git?ref=v2"
  name       = "cards.statements.\${var.env}"
  owner_team = local.team
}

module "network" {
  source = "terraform-aws-modules/vpc/aws"
  name   = "core"
}

module "unknown_topic" {
  source     = "git::https://git.tide.internal/platform/tide-kafka-topic.git?ref=v2"
  name       = var.not_set
  owner_team = "cards"
}
`,
};

const dialect = (rules: unknown[], tests: unknown[]) =>
  Dialect.parse({
    schemaVersion: 1,
    name: "tide-infra",
    version: "0.1.0",
    appliesTo: {},
    rules,
    tests,
  });

async function scan(d: Dialect, files: Record<string, string>) {
  return scanRepo({
    repo: memoryRepo("tide-infra", SHA, files),
    extractors: [dialectExtractor(d)],
    dialects: [d.name],
    scannedAt: "2026-10-19T12:00:00Z",
  });
}

describe("dialect rules v2 (ADR 0056)", () => {
  it("reads house Terraform modules, only where the condition holds, resolving variables and locals", async () => {
    const s = await scan(dialect([topicRule], [{ name: "t", files: infra, expect: [] }]), infra);
    expect(s.rejected).toEqual([]);
    expect(
      s.records.map((r) => {
        const x = r as unknown as Record<string, unknown>;
        return `${r.id} ${String(x.component)} ${String(x.pathOrTopic)}`;
      }),
    ).toEqual(["ep-cards-topic-cards.statements.prod cards cards.statements.prod"]);
    // The module whose name can't be resolved is skipped with a warning, not emitted invalid.
    expect(s.warnings.map((w) => `${w.path}: ${w.message}`)).toEqual([
      "topics/main.tf: rule house-topic: the id template could not be filled",
    ]);
  });

  it("skips a record whose required field can't be filled, and says which", async () => {
    const rule = {
      ...topicRule,
      emit: { ...topicRule.emit, id: "ep-topic-${match.0}" },
    };
    const s = await scan(dialect([rule], [{ name: "t", files: infra, expect: [] }]), infra);
    expect(s.rejected).toEqual([]);
    expect(s.records.map((r) => r.id)).toEqual(["ep-topic-statements_topic"]);
    expect(s.warnings.map((w) => w.message)).toEqual([
      "rule house-topic: pathOrTopic could not be filled, so ep-topic-unknown_topic isn't emitted",
    ]);
  });

  it("applies receiverType: only calls on a receiver declared with that type match", async () => {
    const files = {
      "src/main/java/x/Audit.java": `package x;
class Audit {
  private final AuditPublisher publisher;
  private final Mailer mailer;
  void run(AuditPublisher p) {
    publisher.send("audit.events");
    mailer.send("ops@tide.example");
    p.send("audit.events.direct");
  }
}`,
    };
    const rule = {
      id: "audit-send",
      description: "AuditPublisher.send publishes to a topic.",
      match: { methodCall: "send", receiverType: "AuditPublisher", files: ["**/*.java"] },
      emit: {
        kind: "Unresolved",
        id: "ur-send-${file.line}",
        fields: { unresolvedKind: "event-publish", raw: "${attr.arg0}", owner: "x" },
      },
      confidence: "inferred",
    };
    const d = dialect([rule], [{ name: "t", files, expect: [] }]);
    const s = await scan(d, files);
    expect(s.records.map((r) => (r as unknown as { raw: string }).raw)).toEqual([
      "audit.events",
      "audit.events.direct",
    ]);
  });

  it("fails a dialect's tests when one of its rules is exercised by no test", async () => {
    const other = {
      ...topicRule,
      id: "house-queue",
      where: [{ value: "${attr.source}", matches: "tide-mq-queue" }],
    };
    const d = dialect(
      [topicRule, other],
      [
        {
          name: "topic",
          files: infra,
          expect: [{ kind: "Endpoint", id: "ep-cards-topic-cards.statements.prod" }],
        },
      ],
    );
    expect(await runDialectTests(d, ".")).toEqual([
      { test: "(coverage)", message: "rule house-queue produces nothing in any test" },
    ]);
  });
});
