import type { CatalogRecord, RecordOf } from "@maycombhq/core";
import { entryComponent, featureFlows, FlowGraph, type FeatureFlows } from "@maycombhq/features";
import type { CheckContext, GapDraft, KnowledgeCheck } from "./gaps.js";

/**
 * Knowledge gaps about features (ADR 0031). Each raises an owner question to the feature's
 * owner, else the owner of the system where its first entry point starts work: a flow that
 * ends in something Atticus can't follow; no name or owner confirmed by a person; no work
 * item linked; no tests found for its entry points; no alert or dashboard for any of its
 * components; described only by documents, or only by code.
 */

type Capability = RecordOf<"Capability">;

const CODE_SOURCES = new Set([
  "code",
  "config",
  "spec",
  "gateway",
  "event-config",
  "infrastructure",
  "pipeline",
  "migration",
]);
const DOC_SOURCES = new Set(["document", "diagram"]);
const TEST_FILE =
  /(^|\/)(src\/test|tests?|__tests__|spec|specs|e2e)\/|\.(test|spec)\.[a-z]+$|Tests?\.(java|kt|cs|py|go|scala)$/;

interface Facts {
  flows: FeatureFlows[];
  g: FlowGraph;
}

const cache = new WeakMap<CatalogRecord[], Facts>();

function facts(ctx: CheckContext): Facts {
  let f = cache.get(ctx.records);
  if (!f) {
    f = { flows: featureFlows(ctx.records), g: new FlowGraph(ctx.records) };
    cache.set(ctx.records, f);
  }
  return f;
}

const label = (f: Capability) => `${f.name} (${f.id})`;
const live = (ff: FeatureFlows) => ff.feature.status !== "retired";

/** The system a feature's question is filed under: where it starts, else what it spans. */
function systemFor(ff: FeatureFlows, ctx: CheckContext): string {
  if (ff.system) return ff.system;
  for (const id of ff.feature.records) {
    const s = ctx.systemOf(id);
    if (s) return s;
  }
  return ff.feature.id;
}

function draft(
  ff: FeatureFlows,
  ctx: CheckContext,
  question: string,
  neededFact: string,
  records: string[] = [ff.feature.id],
): GapDraft {
  return {
    system: systemFor(ff, ctx),
    records,
    question,
    neededFact,
    evidence: ff.feature.evidence,
    ...(ff.feature.owner ? { owner: ff.feature.owner } : {}),
  };
}

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const flowComplete: KnowledgeCheck = {
  id: "feature-flow-complete",
  description:
    "A feature's flows need both ends of every call and event: who starts each entry point's work and where its calls go.",
  needs: [
    { kind: "Interface", what: "both ends of every call and event in the feature's flows" },
    { kind: "Unresolved", what: "no loose end left in a component the flow passes" },
  ],
  run(ctx) {
    return facts(ctx)
      .flows.filter(live)
      .filter((ff) => ff.looseEnds.length > 0)
      .map((ff) => {
        const records = ff.looseEnds.map((e) => e.record);
        return draft(
          ff,
          ctx,
          `Where does ${label(ff.feature)} really start or end? ${sentence(ff.looseEnds.map((e) => e.text).join("; "))}.`,
          `what starts or ends the flow of ${ff.feature.id} at ${records.join(", ")}`,
          [ff.feature.id, ...records],
        );
      });
  },
};

const confirmed: KnowledgeCheck = {
  id: "feature-confirmed",
  description: "A feature needs a name and an owner confirmed by a person.",
  needs: [
    { kind: "Capability", field: "namedBy", what: "a name confirmed by a person" },
    { kind: "Capability", field: "owner", what: "the team that owns the feature" },
  ],
  run(ctx) {
    const out: GapDraft[] = [];
    for (const ff of facts(ctx).flows.filter(live)) {
      const f = ff.feature;
      const named = f.namedBy === "person";
      if (named && f.owner) continue;
      const how = f.namedBy === "ai" ? "Atticus's naming agent called" : "Atticus detected as";
      if (!named && !f.owner)
        out.push(
          draft(
            ff,
            ctx,
            `What do people call the feature ${how} "${f.name}" (${f.id}), and who owns it?`,
            `a confirmed name and an owner for ${f.id}`,
          ),
        );
      else if (!named)
        out.push(
          draft(
            ff,
            ctx,
            `What do people call the feature ${how} "${f.name}" (${f.id})?`,
            `a confirmed name for ${f.id}`,
          ),
        );
      else out.push(draft(ff, ctx, `Who owns ${label(f)}?`, `an owner for ${f.id}`));
    }
    return out;
  },
};

const workItemLinked: KnowledgeCheck = {
  id: "feature-work-item-linked",
  description: "A feature needs the epic or feature in the work tracker that built it.",
  needs: [{ kind: "Capability", field: "externalRefs", what: "a linked work item (ADO or Jira)" }],
  run(ctx) {
    return facts(ctx)
      .flows.filter(live)
      .filter(
        (ff) => !ff.feature.externalRefs.some((r) => r.system === "ado" || r.system === "jira"),
      )
      .map((ff) =>
        draft(
          ff,
          ctx,
          `Which epic or feature in the work tracker built ${label(ff.feature)}?`,
          `the work item that built ${ff.feature.id}`,
        ),
      );
  },
};

/** What a test would mention to show it exercises an entry point. */
function entryText(g: FlowGraph, id: string): string | undefined {
  const e = g.endpoints.get(id);
  if (e) return e.pathOrTopic;
  const i = g.interfaces.get(id);
  if (i) return i.normalizedPath;
  const s = g.settings.get(id);
  if (s) return s.key;
  return undefined;
}

function isTested(g: FlowGraph, records: CatalogRecord[], id: string): boolean {
  const component = entryComponent(g, id);
  if (
    records.some(
      (r) => r.kind === "QualityAsset" && r.assetKind === "test-suite" && r.component === component,
    )
  )
    return true;
  const text = entryText(g, id);
  return records.some((r) => {
    if (!r.evidence.some((e) => e.path && TEST_FILE.test(e.path))) return false;
    if (r.id === id) return true;
    if (!text) return false;
    const x = r as unknown as Record<string, unknown>;
    return ["raw", "normalizedPath", "pathOrTopic"].some(
      (k) => typeof x[k] === "string" && (x[k] as string).includes(text),
    );
  });
}

const tested: KnowledgeCheck = {
  id: "feature-tested",
  description:
    "A feature's entry points need tests: a test suite for the component, or test files that exercise the entry point.",
  needs: [
    {
      kind: "QualityAsset",
      field: "assetKind",
      what: "a test suite for each entry point's component",
    },
  ],
  run(ctx) {
    const { g } = facts(ctx);
    const out: GapDraft[] = [];
    for (const ff of facts(ctx).flows.filter(live)) {
      const untested = ff.feature.entryPoints.filter((e) => !isTested(g, ctx.records, e));
      if (!untested.length) continue;
      out.push(
        draft(
          ff,
          ctx,
          `Which tests cover ${label(ff.feature)}? Atticus found none for ${untested.join(", ")}.`,
          `tests for ${untested.join(", ")}`,
        ),
      );
    }
    return out;
  },
};

const monitored: KnowledgeCheck = {
  id: "feature-monitored",
  description: "A feature needs an alert or a dashboard on at least one of its components.",
  needs: [
    {
      kind: "ObservabilityAsset",
      field: "assetKind",
      what: "an alert or dashboard for its components",
    },
  ],
  run(ctx) {
    const { g } = facts(ctx);
    const out: GapDraft[] = [];
    for (const ff of facts(ctx).flows.filter(live)) {
      const comps = ff.feature.records.filter((id) => g.isOwn(id)).sort();
      if (!comps.length) continue;
      const watched = ctx.records.some(
        (r) =>
          r.kind === "ObservabilityAsset" &&
          (r.assetKind === "alert" || r.assetKind === "dashboard") &&
          comps.includes(r.component) &&
          !ctx.isStale(r),
      );
      if (watched) continue;
      out.push(
        draft(
          ff,
          ctx,
          `Which alert or dashboard watches ${label(ff.feature)}? None of its components (${comps.join(", ")}) has one.`,
          `an alert or dashboard for ${comps.join(", ")}`,
        ),
      );
    }
    return out;
  },
};

const described: KnowledgeCheck = {
  id: "feature-described",
  description:
    "A feature needs both: code that implements it and a document or spec that describes it.",
  needs: [
    { kind: "SourceDocument", what: "a spec, wiki page or document that describes the feature" },
    { kind: "Capability", field: "evidence", what: "code that implements the feature" },
  ],
  run(ctx) {
    const out: GapDraft[] = [];
    const sourceDocs = ctx.records.filter(
      (r): r is RecordOf<"SourceDocument"> => r.kind === "SourceDocument",
    );
    for (const ff of facts(ctx).flows.filter(live)) {
      const f = ff.feature;
      const mine = new Set([f.id, ...f.records]);
      const docs =
        f.externalRefs.some((r) => r.system === "wiki" || r.system === "openspec") ||
        f.evidence.some((e) => DOC_SOURCES.has(e.source)) ||
        sourceDocs.some((d) => d.recordsProduced.some((id) => mine.has(id)));
      const code = f.evidence.some((e) => CODE_SOURCES.has(e.source));
      if (code && !docs)
        out.push(
          draft(
            ff,
            ctx,
            `Is there a spec or wiki page that describes ${label(f)}? Only its code shows it.`,
            `a document that describes ${f.id}`,
          ),
        );
      else if (docs && !code)
        out.push(
          draft(
            ff,
            ctx,
            `Which code implements ${label(f)}? Only documents describe it.`,
            `the code that implements ${f.id}`,
          ),
        );
    }
    return out;
  },
};

/** The feature checks, in the order their gaps are listed. */
export const FEATURE_CHECKS: KnowledgeCheck[] = [
  flowComplete,
  confirmed,
  workItemLinked,
  tested,
  monitored,
  described,
];
