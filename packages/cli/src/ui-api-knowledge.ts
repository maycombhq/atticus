import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import {
  Api,
  changesRelOf,
  KNOWLEDGE_KINDS,
  KNOWLEDGE_RECORD_KIND,
  knowledgeDirOf,
  knowledgeKindOf,
  knowledgeRelOf,
  loadOrgPack,
  orgPackDirOf,
  proposalsDirOf,
  proposalsRelOf,
  RecordId,
  SOURCE_KIND_SUGGESTIONS,
  type KnowledgeKind,
} from "@maycombhq/core";
import { changeFolder } from "@maycombhq/changes";
import {
  acceptOrgPackDraft,
  correctableFields,
  draftOrgPack,
  filterItems,
  itemTitle,
  keepCandidate,
  OrgPackProposal,
  readFind,
  readFinds,
  readKnowledge,
  readReviews,
  readSnapshot,
  reviewItem,
  searchPages,
  SNAPSHOT_FILE,
  snapshotDates,
  SnapshotManifest,
  snapshotSources,
  writeReview,
  type FindCandidate,
  type KnowledgeRecord,
  type ReviewSummary,
  type SavedFind,
  type Snapshot,
} from "@maycombhq/knowledge";
import { markNeed, NEEDS_FILE, readNeeds, type Need } from "@maycombhq/planner";
import {
  badRequest,
  HttpError,
  notFound,
  strParam,
  type Router,
  type ServerContext,
} from "@maycombhq/server";
import { sourcesAdd, sourcesSync } from "./knowledge-commands.js";
import { INPUTS_SOURCE_ID } from "./inputs-knowledge.js";

/**
 * Knowledge in the app (ADR 0102, C4 2.7.0): everything ADR 0101 put on the command line, for
 * a person to see and act on. Each write runs the code its command runs, as the signed-in
 * person (`/api/me`): adding and syncing a source (`sources add --save`, `sources sync`), a
 * review of an item (`knowledge verify|correct|reject`), keeping a search's candidate
 * (`knowledge keep`), marking a change's need (`needs done|skip|reopen`), and drafting and
 * accepting the org pack from the wikis (`orgpack draft|accept`). The AI steps (`knowledge
 * scan`, `knowledge find`, `change needs`) need a model, so the app gives their commands and
 * slash commands to copy; the plain page search runs here, since it reads files only.
 */

/** A snapshot older than this is synced again (the same as atticus next). */
export const STALE_DAYS = 14;

const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const DAY = 86_400_000;
const stamp = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

const idOf = (v: string, what: string) => {
  if (!RecordId.safeParse(v).success)
    throw badRequest(`${v} isn't a ${what} id. Ids are lowercase: a-z, 0-9, '.', '_' and '-'.`);
  return v;
};

const invalid = (what: string, e: { issues: { path: PropertyKey[]; message: string }[] }) =>
  badRequest(what, {
    errors: e.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
  });

type FieldValue = string | string[] | { url: string; label?: string }[];

/** A value as reviewItem takes it: a list as its strings, a link as label=address. */
function asSet(
  set: Record<string, FieldValue> | undefined,
): Record<string, string | string[]> | undefined {
  if (!set) return undefined;
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(set))
    out[k] =
      typeof v === "string"
        ? v
        : v.map((x) =>
            typeof x === "string" ? x : x.label?.trim() ? `${x.label.trim()}=${x.url}` : x.url,
          );
  return out;
}

const keepAs = (recordKind: string): KnowledgeKind[] =>
  KNOWLEDGE_KINDS.filter((k) => KNOWLEDGE_RECORD_KIND[k] === recordKind);

function itemView(r: KnowledgeRecord, review: ReviewSummary | undefined): Api.KnowledgeItemViewT {
  return {
    id: r.id,
    kind: knowledgeKindOf(r) ?? keepAs(r.kind)[0]!,
    recordKind: r.kind,
    title: itemTitle(r),
    record: r as unknown as Record<string, unknown>,
    ...(review ? { review } : {}),
    fields: correctableFields(r),
    conflict: !!r.flags?.some((f) => f.startsWith("conflict:")),
  };
}

function candidateView(c: FindCandidate): Api.FindCandidateViewT {
  const r = c.record;
  return {
    id: r.id,
    kind: knowledgeKindOf(r) ?? keepAs(r.kind)[0]!,
    recordKind: r.kind,
    title: itemTitle(r),
    record: r as unknown as Record<string, unknown>,
    ...(c.known ? { known: c.known } : {}),
    ...(c.kept ? { kept: c.kept } : {}),
    keepAs: keepAs(r.kind),
  };
}

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

/** Capture what a command prints. */
function capture() {
  const lines: string[] = [];
  const problems: string[] = [];
  return {
    io: { out: (l: string) => lines.push(l), err: (l: string) => problems.push(l) },
    lines,
    problems,
  };
}

export function uiKnowledgeRoutes(
  r: Router,
  ctx: ServerContext,
  deps: { now?: () => Date } = {},
): Router {
  const root = ctx.root;
  const now = deps.now ?? (() => new Date());
  const changed = (path: string) => ctx.events.publish({ type: "file.changed", path });

  /** One item as people reviewed it now (rejected ones included). */
  const reviewed = async (id: string) => {
    const k = await readKnowledge(root);
    const item = [...k.items, ...k.rejected].find((i) => i.id === id);
    return item ? itemView(item, k.reviews[id]) : undefined;
  };

  const findView = (f: SavedFind): Api.SavedFindViewT => ({
    slug: f.slug,
    phrase: f.phrase,
    at: f.at,
    file: `${knowledgeRelOf(root)}/finds/${f.slug}.yaml`,
    matches: f.matches,
    candidates: f.candidates.map(candidateView),
  });

  const draftView = async (): Promise<Api.OrgPackDraftViewT> => {
    const op = await loadOrgPack(orgPackDirOf(root));
    const platforms: Api.OrgPackDraftViewT["platforms"] = [];
    for (const { platform } of op.profiles) {
      const text = await readFile(
        join(proposalsDirOf(root), "orgpack", `${platform}.yaml`),
        "utf8",
      ).catch(() => undefined);
      const data = text === undefined ? undefined : (parse(text) as Record<string, unknown> | null);
      const proposals = Array.isArray(data?.proposals)
        ? data.proposals.flatMap((p) => {
            const x = OrgPackProposal.safeParse(p);
            return x.success ? [x.data] : [];
          })
        : [];
      platforms.push({
        platform,
        file: `${proposalsRelOf(root)}/orgpack/${platform}.yaml`,
        present: text !== undefined,
        ...(typeof data?.at === "string" ? { at: data.at } : {}),
        proposals,
        command: `atticus orgpack draft --platform ${platform}`,
      });
    }
    return { platforms };
  };

  return (
    r
      // ------------------------------------------------------------ sources
      .add("GET", "/api/knowledge/sources", async () => {
        const op = await loadOrgPack(orgPackDirOf(root));
        const problems = op.problems
          .filter((p) => p.file === "sources.yaml")
          .map((p) => ({
            file: `org-pack/${p.file}`,
            message: `${p.path ? `${p.path}: ` : ""}${p.message}`,
          }));
        const k = await readKnowledge(root, { raw: true });
        const scanned = new Map((k.report?.snapshots ?? []).map((s) => [s.source, s]));
        const today = now().getTime();
        const sources: Api.KnowledgeSourceT[] = [];
        for (const w of op.sources.wikis) {
          const date = (await snapshotDates(root, w.id))[0];
          let snapshot: Api.KnowledgeSourceT["snapshot"];
          if (date) {
            const file = join(knowledgeDirOf(root), "snapshots", w.id, date, SNAPSHOT_FILE);
            const text = await readFile(file, "utf8").catch(() => undefined);
            const m = text === undefined ? undefined : SnapshotManifest.safeParse(parse(text));
            if (m?.success)
              snapshot = {
                date,
                takenAt: m.data.takenAt,
                ...(m.data.commit ? { commit: m.data.commit } : {}),
                pages: m.data.pages.length,
                skipped: m.data.skipped.length,
                ageDays: Math.max(0, Math.floor((today - Date.parse(`${date}T00:00:00Z`)) / DAY)),
              };
            else
              problems.push({
                file: `${knowledgeRelOf(root)}/snapshots/${w.id}/${date}/${SNAPSHOT_FILE}`,
                message: "not a snapshot manifest",
              });
          }
          const s = scanned.get(w.id);
          sources.push({
            id: w.id,
            type: w.type,
            location: w.location,
            ...(w.ref ? { ref: w.ref } : {}),
            ...(w.path ? { path: w.path } : {}),
            ...(w.checkout ? { checkout: w.checkout } : {}),
            ...(w.owner ? { owner: w.owner } : {}),
            tags: { kinds: w.tags?.kinds ?? [], frameworks: w.tags?.frameworks ?? [] },
            ...(snapshot ? { snapshot } : {}),
            ...(s ? { scanned: { date: s.date, pages: s.pages } } : {}),
            stale: !snapshot || snapshot.ageDays > STALE_DAYS,
            commands: {
              sync: `atticus sources sync --source ${w.id}`,
              scan: `atticus knowledge scan --source ${w.id}`,
              slash: `/atticus-knowledge ${w.id}`,
            },
          });
        }
        const body: Api.KnowledgeSourceListT = {
          file: "org-pack/sources.yaml",
          types: [...Api.WIKI_TYPES],
          kindSuggestions: [...SOURCE_KIND_SUGGESTIONS],
          staleDays: STALE_DAYS,
          sources,
          problems,
        };
        return { status: 200, body };
      })
      .add("POST", "/api/knowledge/sources", async ({ body }) => {
        const b = Api.AddSourceRequest.safeParse(body ?? {});
        if (!b.success) throw invalid("Some fields aren't right.", b.error);
        const { type, location, kinds, frameworks, ...o } = b.data;
        const c = capture();
        const code = await sourcesAdd(root, type, location, c.io, {
          ...(o.id ? { id: o.id } : {}),
          ...(o.path ? { path: o.path } : {}),
          ...(o.ref ? { ref: o.ref } : {}),
          ...(o.submodule ? { submodule: true } : {}),
          ...(kinds?.length ? { kinds } : {}),
          ...(frameworks?.length ? { frameworks } : {}),
          ...(o.owner ? { owner: o.owner } : {}),
          save: o.save,
        });
        const words = [...c.problems, ...c.lines].join("\n") || "Atticus refused.";
        if (code === 2) throw badRequest(words);
        if (code !== 0) throw new HttpError(422, "Atticus refused", words);
        if (o.save) changed("org-pack/sources.yaml");
        return { status: 200, body: { code, lines: c.lines, problems: c.problems } };
      })
      .add("POST", "/api/knowledge/sources/{sourceId}/sync", async ({ params }) => {
        const id = idOf(params.sourceId!, "source");
        const op = await loadOrgPack(orgPackDirOf(root));
        // ADR 0122: inputs is the metarepo's own inputs/ folder, a source not in sources.yaml.
        if (id !== INPUTS_SOURCE_ID && !op.sources.wikis.some((w) => w.id === id))
          throw notFound(`There is no source ${id} in org-pack/sources.yaml.`);
        const c = capture();
        const code = await sourcesSync(root, c.io, { source: id, now: stamp(now()) });
        if (code === 2)
          throw new HttpError(422, "Atticus refused", c.problems.join("\n") || "Nothing to sync.");
        changed(`${knowledgeRelOf(root)}/snapshots/${id}`);
        return { status: 200, body: { code, lines: c.lines, problems: c.problems } };
      })

      // ------------------------------------------------------------ the last scan and the items
      .add("GET", "/api/knowledge/scan", async () => {
        const k = await readKnowledge(root);
        const r = k.report;
        const body: Api.KnowledgeScanViewT = {
          ...(r ? { scannedAt: r.scannedAt } : {}),
          snapshots: (r?.snapshots ?? []).map((s) => ({
            source: s.source,
            date: s.date,
            pages: s.pages,
          })),
          ...(r?.changes ? { changes: r.changes } : {}),
          checkAgain: [...k.items, ...k.rejected]
            .filter((i) => k.reviews[i.id]?.state === "stale")
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((i) => ({
              id: i.id,
              kind: knowledgeKindOf(i) ?? keepAs(i.kind)[0]!,
              title: itemTitle(i),
              by: k.reviews[i.id]!.by,
            })),
          conflicts: r?.conflicts.length ?? 0,
          injections: r?.injections.length ?? 0,
          failed: r?.failed.length ?? 0,
          command: "atticus knowledge scan",
          slash: "/atticus-knowledge",
        };
        return { status: 200, body };
      })
      .add("GET", "/api/knowledge/items", async ({ query }) => {
        const kind = strParam(query, "kind");
        if (kind !== undefined && !(KNOWLEDGE_KINDS as readonly string[]).includes(kind))
          throw badRequest(
            `There is no knowledge kind ${kind}. Use one of: ${KNOWLEDGE_KINDS.join(", ")}.`,
          );
        const tag = strParam(query, "tag");
        const k = await readKnowledge(root);
        // Rejected items are listed too, marked: a person said why, and the next one reads it.
        const items = filterItems([...k.items, ...k.rejected], {
          ...(kind ? { kind: kind as KnowledgeKind } : {}),
          ...(tag ? { tag } : {}),
        }).sort((a, b) => a.id.localeCompare(b.id));
        const body: Api.KnowledgeItemListT = {
          items: items.map((i) => itemView(i, k.reviews[i.id])),
          problems: k.problems.map((p) => ({
            file: `${knowledgeRelOf(root)}/${p.file.startsWith("reviews/") || p.file === "scan.yaml" ? "" : "items/"}${p.file}`,
            message: p.message,
          })),
        };
        return { status: 200, body };
      })
      .add("POST", "/api/knowledge/items/{itemId}/review", async ({ params, body }) => {
        const id = idOf(params.itemId!, "knowledge item");
        const b = Api.ReviewItemRequest.safeParse(body ?? {});
        if (!b.success) throw invalid("Say verified, corrected or rejected.", b.error);
        const raw = await readKnowledge(root, { raw: true });
        const item = raw.items.find((i) => i.id === id);
        if (!item) throw notFound(`There is no knowledge item ${id}.`);
        let set = asSet(b.data.set);
        // Correcting again keeps what an earlier correction set, unless it is set again.
        if (b.data.verdict === "corrected") {
          const before = (await readReviews(root)).reviews.get(id);
          if (before?.corrections)
            set = { ...asSet(before.corrections as Record<string, FieldValue>), ...set };
        }
        const res = reviewItem(item, {
          verdict: b.data.verdict,
          by: ctx.user,
          at: stamp(now()),
          ...(b.data.note ? { note: b.data.note } : {}),
          ...(set && Object.keys(set).length ? { set } : {}),
        });
        if ("error" in res) throw badRequest(res.error);
        const file = await writeReview(root, res.review);
        changed(`${knowledgeRelOf(root)}/${file}`);
        return {
          status: 200,
          body: { item: (await reviewed(id))!, file: `${knowledgeRelOf(root)}/${file}` },
        };
      })

      // ------------------------------------------------------------ searching the wikis
      .add("GET", "/api/knowledge/search", async ({ query }) => {
        const phrase = strParam(query, "q")?.trim();
        if (!phrase) throw badRequest("Say what to look for: ?q=<a term or phrase>.");
        if (phrase.length > 200)
          throw badRequest("Search for a term or phrase of up to 200 characters.");
        const source = strParam(query, "source");
        if (source !== undefined) idOf(source, "source");
        const ids = await snapshotSources(root);
        if (source && !ids.includes(source))
          throw notFound(`${source} has no snapshot yet: atticus sources sync --source ${source}.`);
        const snapshots: Snapshot[] = [];
        for (const s of source ? [source] : ids) {
          const snap = await readSnapshot(root, s).catch(() => undefined);
          if (snap) snapshots.push(snap);
        }
        const matches = searchPages(snapshots, phrase);
        const body: Api.WikiSearchResultT = {
          phrase,
          sources: snapshots.length,
          matches,
          pages: [...new Set(matches.map((m) => `${m.source}/${m.page}`))],
          command: `atticus knowledge find ${JSON.stringify(phrase)}${source ? ` --source ${source}` : ""}`,
          slash: `/atticus-find ${phrase}`,
        };
        return { status: 200, body };
      })
      .add("GET", "/api/knowledge/finds", async () => {
        const finds: Api.SavedFindViewT[] = [];
        for (const f of await readFinds(root)) {
          const s = await readFind(root, f.slug);
          if (s) finds.push(findView(s));
        }
        return { status: 200, body: { finds } satisfies Api.SavedFindListT };
      })
      .add("GET", "/api/knowledge/finds/{slug}", async ({ params }) => {
        const slug = params.slug!;
        if (!SLUG.test(slug)) throw badRequest(`${slug} isn't a saved search.`);
        const f = await readFind(root, slug);
        if (!f) throw notFound(`There is no saved search ${slug}.`);
        return { status: 200, body: findView(f) };
      })
      .add("POST", "/api/knowledge/finds/{slug}/keep", async ({ params, body }) => {
        const slug = params.slug!;
        if (!SLUG.test(slug)) throw badRequest(`${slug} isn't a saved search.`);
        const b = Api.KeepCandidateRequest.safeParse(body ?? {});
        if (!b.success) throw invalid("Say which candidate to keep: { item }.", b.error);
        const f = await readFind(root, slug);
        if (!f) throw notFound(`There is no saved search ${slug}.`);
        if (!f.candidates.some((c) => c.record.id === b.data.item))
          throw notFound(`The search ${slug} has no candidate ${b.data.item}.`);
        const set = asSet(b.data.set);
        const res = await keepCandidate(root, slug, b.data.item, {
          ...(b.data.as ? { as: b.data.as } : {}),
          by: ctx.user,
          at: stamp(now()),
          ...(b.data.note ? { note: b.data.note } : {}),
          ...(set && Object.keys(set).length ? { set } : {}),
        });
        if ("error" in res) throw new HttpError(422, "Atticus refused", res.error);
        changed(`${knowledgeRelOf(root)}/items`);
        const item = (await reviewed(b.data.item)) ?? itemView(res.item, undefined);
        return { status: 200, body: { item, as: res.as } };
      })

      // ------------------------------------------------------------ a change's needs
      .add("GET", "/api/changes/{changeId}/needs", async ({ params }) => {
        const change = idOf(params.changeId!, "change");
        if (!(await exists(changeFolder(root, change))))
          throw notFound(`There is no change ${change}.`);
        const fileExists = await exists(join(changeFolder(root, change), NEEDS_FILE));
        const f = await readNeeds(root, change);
        if (fileExists && !f)
          throw new HttpError(
            422,
            "Atticus can't read that file",
            `${changesRelOf(root)}/${change}/${NEEDS_FILE} isn't a valid needs file.`,
          );
        const k = f ? await readKnowledge(root) : undefined;
        const view = (n: Need): Api.NeedViewT => ({
          ...n,
          ...(k?.reviews[n.item] ? { review: k.reviews[n.item] } : {}),
        });
        const body: Api.ChangeNeedsViewT = {
          change,
          file: `${changesRelOf(root)}/${change}/${NEEDS_FILE}`,
          present: !!f,
          ...(f ? { updatedAt: f.updatedAt } : {}),
          needs: (f?.needs ?? []).map(view),
          considered: f?.considered ?? [],
          command: `atticus change needs ${change}`,
          slash: `/atticus-needs ${change}`,
        };
        return { status: 200, body };
      })
      .add("POST", "/api/changes/{changeId}/needs/{itemId}", async ({ params, body }) => {
        const change = idOf(params.changeId!, "change");
        const item = idOf(params.itemId!, "knowledge item");
        const b = Api.MarkNeedRequest.safeParse(body ?? {});
        if (!b.success) throw invalid("Say done, not-needed or open.", b.error);
        if (!(await exists(changeFolder(root, change))))
          throw notFound(`There is no change ${change}.`);
        const res = await markNeed(root, change, item, {
          status: b.data.status,
          by: ctx.user,
          at: stamp(now()),
          ...(b.data.note ? { note: b.data.note } : {}),
          ...(b.data.for ? { for: b.data.for } : {}),
        });
        if ("error" in res) {
          if (/has no need /.test(res.error)) throw notFound(res.error);
          if (/has no needs yet/.test(res.error))
            throw new HttpError(422, "Atticus can't do that yet", res.error);
          throw badRequest(res.error);
        }
        const file = `${changesRelOf(root)}/${change}/${NEEDS_FILE}`;
        changed(file);
        const k = await readKnowledge(root);
        return {
          status: 200,
          body: {
            need: { ...res.need, ...(k.reviews[item] ? { review: k.reviews[item] } : {}) },
            file,
          },
        };
      })

      // ------------------------------------------------------------ the org pack from the wikis
      .add("GET", "/api/orgpack/draft", async () => ({ status: 200, body: await draftView() }))
      .add("POST", "/api/orgpack/draft", async ({ body }) => {
        const b = Api.DraftOrgPackRequest.safeParse(body ?? {});
        if (!b.success) throw invalid("Say which platform: { platform }.", b.error);
        try {
          await draftOrgPack(root, {
            ...(b.data.platform ? { platform: b.data.platform } : {}),
            now: now(),
          });
        } catch (e) {
          throw new HttpError(422, "Atticus refused", (e as Error).message);
        }
        changed(`${proposalsRelOf(root)}/orgpack`);
        return { status: 200, body: await draftView() };
      })
      .add("POST", "/api/orgpack/draft/{platform}/accept", async ({ params, body }) => {
        const platform = idOf(params.platform!, "platform");
        const b = Api.AcceptOrgPackRequest.safeParse(body ?? {});
        if (!b.success) throw invalid("Pick the systems to accept: { only: [ids] }.", b.error);
        try {
          const res = await acceptOrgPackDraft(root, platform, { only: b.data.only });
          changed(res.file);
          return { status: 200, body: res satisfies Api.AcceptedOrgPackT };
        } catch (e) {
          const words = (e as Error).message;
          if (/There is no draft/.test(words)) throw notFound(words);
          throw new HttpError(422, "Atticus refused", words);
        }
      })
  );
}
