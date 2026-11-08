import {
  Api,
  factsRelOf,
  type AuditAnswer,
  type AuditFileT,
  type AuditItemT,
} from "@maycombhq/core";
import {
  badRequest,
  HttpError,
  notFound,
  type Router,
  type ServerContext,
} from "@maycombhq/server";
import {
  answerAudit,
  auditLines,
  defaultAuditSeed,
  precisionOf,
  prepareAudit,
  writeAudit,
} from "./audit-commands.js";

/**
 * A sample audit answered in the app (P3's follow-up, ADR 0149): Map › Trust's Sample audit draws
 * the sample as `atticus verify audit <repo>` draws it (`prepareAudit`: the same seed, size and
 * candidates, so the same items) and writes the answers to `facts/<repo>.audit.yaml` with the
 * CLI's own `answerAudit` and `writeAudit`. GET writes nothing; POST writes only the audit file
 * (a person's record, committed in a pull request; nothing is sent anywhere, no git runs).
 */

const REPO = /^[a-z0-9][a-z0-9._-]{0,99}$/i;
const repoOf = (v: string) => {
  if (!REPO.test(v)) throw badRequest(`${JSON.stringify(v)} isn't a repo name.`);
  return v;
};

async function itemsWithLines(
  root: string,
  repo: string,
  items: readonly AuditItemT[],
): Promise<Api.AuditItemViewT[]> {
  const text = await auditLines(root, repo, items);
  return items.map((i) => ({
    ...i,
    lines: i.cites.map((c) => {
      const t = text.get(c);
      return { cite: c, ...(t ? { text: t.length > 300 ? `${t.slice(0, 297)}...` : t } : {}) };
    }),
  }));
}

/** This draw's items as the merged file has them (answers on file included), in draw order. */
const ofDraw = (audit: AuditFileT, drawn: readonly AuditItemT[]) => {
  const byId = new Map(audit.items.map((i) => [i.id, i] as const));
  return drawn.map((d) => byId.get(d.id) ?? d);
};

export function uiAuditRoutes(
  r: Router,
  ctx: ServerContext,
  deps: { now?: () => Date } = {},
): Router {
  const now = deps.now ?? (() => new Date());
  return r
    .add("GET", "/api/facts/{repo}/audit", async ({ params, query }) => {
      const repo = repoOf(params.repo!);
      const seed = query.get("seed") || undefined;
      const sizeText = query.get("size");
      const size = sizeText ? Number(sizeText) : undefined;
      if (size !== undefined && (!Number.isInteger(size) || size < 1 || size > 100))
        throw badRequest("size is a whole number from 1 to 100.");
      const p = await prepareAudit(ctx.root, repo, {
        ...(seed ? { seed } : {}),
        ...(size ? { size } : {}),
        now,
      });
      const command = (s: string, n: number) =>
        `atticus verify audit ${repo} --seed ${s} --size ${n}`;
      if ("refused" in p) {
        const body: Api.AuditSampleViewT = {
          repo,
          file: `${factsRelOf(ctx.root)}/${repo}.audit.yaml`,
          seed: seed ?? "",
          size: size ?? 10,
          items: [],
          refused: p.refused,
          ...(p.unverified ? { unverified: p.unverified } : {}),
          command: `atticus verify audit ${repo}`,
        };
        return { status: 200, body };
      }
      const precision = await precisionOf(ctx.root, repo, p.audit, p.facts);
      const commit = [...new Set(p.facts.map((f) => f.commit))].sort()[0];
      const body: Api.AuditSampleViewT = {
        repo,
        file: p.fileRel,
        seed: p.seed,
        size: p.size,
        defaultSeed: defaultAuditSeed(repo, commit),
        items: await itemsWithLines(ctx.root, repo, ofDraw(p.audit, p.drawn)),
        precision: { facts: precision.facts, links: precision.links },
        command: command(p.seed, p.size),
      };
      return { status: 200, body };
    })
    .add("POST", "/api/facts/{repo}/audit", async ({ params, body }) => {
      const repo = repoOf(params.repo!);
      const b = Api.AuditAnswerRequest.safeParse(body ?? {});
      if (!b.success)
        throw badRequest(
          "Say the draw and the answers: { seed, size, answers: [{ id, answer, note }] }.",
          {
            errors: b.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
          },
        );
      const p = await prepareAudit(ctx.root, repo, {
        seed: b.data.seed,
        size: b.data.size,
        now,
      });
      if ("refused" in p) {
        if (p.refused === "no-facts") throw notFound(p.lines.join(" "));
        throw new HttpError(422, "Atticus can't audit this repo yet", p.lines.join(" "));
      }
      // Only this draw's items are answered here, as the CLI refuses an id not in its sample.
      const inDraw = new Set(p.drawn.map((d) => d.id));
      const outside = b.data.answers.filter((a) => !inDraw.has(a.id)).map((a) => a.id);
      if (outside.length)
        throw new HttpError(
          422,
          "Not in this sample",
          `Not in this sample: ${outside.join(", ")}. Answer the items the draw lists.`,
        );
      const answers = new Map<string, { answer: AuditAnswer; note?: string }>(
        b.data.answers.map((a) => [
          a.id,
          { answer: a.answer, ...(a.note ? { note: a.note } : {}) },
        ]),
      );
      answerAudit(p.audit, answers, ctx.user, p.now);
      await writeAudit(ctx.root, repo, p.audit);
      ctx.events.publish({ type: "file.changed", path: p.fileRel });
      const precision = await precisionOf(ctx.root, repo, p.audit, p.facts);
      const result: Api.AuditAnswerResultT = {
        file: p.fileRel,
        answered: p.audit.items.filter((i) => i.answer).length,
        open: p.audit.items.filter((i) => !i.answer).length,
        items: await itemsWithLines(ctx.root, repo, ofDraw(p.audit, p.drawn)),
        precision: { facts: precision.facts, links: precision.links },
        commit: `git add ${p.fileRel}\ngit commit -m "${repo}: a person's sample audit answers"`,
      };
      return { status: 200, body: result };
    });
}
