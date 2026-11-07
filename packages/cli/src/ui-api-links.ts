import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  Api,
  answerQuestion,
  correctionLine,
  factsDirOf,
  factsRelOf,
  FactCorrection,
  inputsDirOf,
  isAdopted,
  parseCorrections,
  linkCandidates,
  listQuestions,
  loadOrgPack,
  orgPackDirOf,
  QuestionError,
  TARGETS_STEP_ID,
  writeFileAtomic,
  type CandidateApi,
  type Fact,
} from "@maycombhq/core";
import { readVendorSpec } from "@maycombhq/intake";
import { estateFacts, estateRepos, outsideProfileSystems } from "@maycombhq/scanner";
import {
  badRequest,
  conflict,
  HttpError,
  notFound,
  type Router,
  type ServerContext,
} from "@maycombhq/server";
import { estateJoinOnFile, stampOf } from "./contract-check-files.js";
import { appendLines, safeMessage, withFileLock } from "./file-lock.js";
import { intakeContext } from "./intake-commands.js";

/**
 * G1 (ADR 0174): connect two boxes call by call. Box A's calls that join nothing and box B's APIs,
 * paired by the person with a suggestion for each; each pair is one `link` line in A's
 * corrections file (the call's fact stays as read), and "all" answers A's open target question
 * with `/**` to B, so calls read later follow it too. A preview says what would be written and
 * what the next `atticus verify A --write` changes; nothing is written until the person confirms.
 */

const REPO = /^[A-Za-z0-9._-]{1,200}$/;
const SPECS = new Set(["openapi", "swagger"]);

const quiet = { out: () => undefined, err: () => undefined };

async function boxApis(
  root: string,
  op: Awaited<ReturnType<typeof loadOrgPack>>,
  estate: { repos: { repo: string; facts: readonly Fact[] }[]; unverified?: string[] },
  to: Api.LinkBoxT,
): Promise<{ name: string; apis: CandidateApi[]; noApis?: Api.LinkCandidatesViewT["noApis"] }> {
  if (to.repo) {
    const known = estateRepos(op).find((r) => r.id === to.repo);
    if (!known) throw notFound(`No repo of the manifest is ${to.repo}.`);
    const facts = estate.repos.find((r) => r.repo === to.repo)?.facts ?? [];
    const apis: CandidateApi[] = facts.flatMap((f) =>
      f.kind === "entry" && f.path
        ? [
            {
              id: f.id,
              kind: /gateway|proxy|apigee/i.test(known.type ?? "") ? "route" : "entry",
              ...(f.method ? { method: f.method.toUpperCase() } : {}),
              path: f.path,
              at: `${f.cite.file}:${f.cite.line}`,
            } satisfies CandidateApi,
          ]
        : [],
    );
    return {
      name: to.repo,
      apis,
      ...(apis.length
        ? {}
        : {
            noApis: estate.unverified?.includes(to.repo)
              ? { why: "unverified" as const, command: `atticus verify ${to.repo}` }
              : { why: "not-read" as const, command: `atticus map --all --repos ${to.repo}` },
          }),
    };
  }
  const system = outsideProfileSystems(op).find((s) => s.id === to.system);
  if (!system) throw notFound(`No outside system of the profile is ${to.system}.`);
  const { inputs } = await intakeContext(root, quiet);
  const doc = inputs.documents.find(
    (d) => d.id && !d.supersededBy && SPECS.has(d.classification) && d.systems[0] === system.id,
  );
  const spec = doc
    ? readVendorSpec(
        doc.path,
        await readFile(join(inputsDirOf(root), ...doc.path.split("/").slice(1)), "utf8"),
        system.id,
      )
    : undefined;
  const apis: CandidateApi[] = (spec?.operations ?? []).map((o) => ({
    id: o.id,
    kind: "operation",
    method: o.method.toUpperCase(),
    path: o.fullPath ?? o.path,
    ...(o.cite ? { at: o.cite } : {}),
  }));
  return {
    name: system.name || system.id,
    apis,
    ...(apis.length
      ? {}
      : {
          noApis: {
            why: "no-spec" as const,
            command: `atticus intake add <${system.id}'s OpenAPI file>`,
          },
        }),
  };
}

async function context(root: string, from: string, to: Api.LinkBoxT) {
  if (!REPO.test(from)) throw badRequest(`${JSON.stringify(from)} isn't a repo name.`);
  if (to.repo && to.repo === from)
    throw badRequest("Pick another box: a box can't call itself here.");
  const op = await loadOrgPack(orgPackDirOf(root));
  if (!estateRepos(op).some((r) => r.id === from))
    throw notFound(`No repo of the manifest is ${from}.`);
  // The stamp before the files are read: a write landing meanwhile can't save an old join new.
  const stamp = await stampOf(root);
  const estate = await estateFacts(root, op, "");
  const join0 = await estateJoinOnFile(root, op, estate, stamp);
  const facts = estate.repos.find((r) => r.repo === from)?.facts ?? [];
  const b = await boxApis(root, op, estate, to);
  return { op, estate, join: join0, facts, b, pairs: estate.pairs[from] ?? {} };
}

async function openRuleQuestion(root: string, from: string) {
  const qs = (await listQuestions(root, { step: TARGETS_STEP_ID }).catch(() => ({ questions: [] })))
    .questions;
  return qs.find((q) => q.repo === from && q.state === "open");
}

export function uiLinkRoutes(
  r: Router,
  ctx: ServerContext,
  deps: { now?: () => Date } = {},
): Router {
  const now = deps.now ?? (() => new Date());
  return (
    r
      .add("GET", "/api/links/candidates", async ({ query }) => {
        const from = query.get("from") ?? "";
        const to: Api.LinkBoxT = query.get("system")
          ? { system: query.get("system")! }
          : { repo: query.get("to") ?? "" };
        if (!from || (!to.repo && !to.system))
          throw badRequest("Say both boxes: from=<repo> and to=<repo> (or system=<id>).");
        const c = await context(ctx.root, from, to);
        const cands = linkCandidates({
          from,
          facts: c.facts,
          join: c.join,
          apis: c.b.apis,
          pairs: c.pairs,
          to,
        });
        const q = await openRuleQuestion(ctx.root, from);
        const loose = cands.calls.filter((x) => x.status !== "paired").length;
        const view: Api.LinkCandidatesViewT = {
          from,
          to,
          toName: c.b.name,
          calls: cands.calls,
          apis: cands.apis,
          ...(c.facts.some((f) => f.kind === "call")
            ? {}
            : c.estate.unverified.includes(from)
              ? { noCalls: { why: "unverified" as const, command: `atticus verify ${from}` } }
              : { noCalls: { command: `atticus map --all --gaps --repos ${from}` } }),
          ...(c.b.noApis ? { noApis: c.b.noApis } : {}),
          ...(q && loose ? { rule: { question: q.id, calls: loose } } : {}),
        };
        return { status: 200, body: view };
      })
      .add("POST", "/api/links/connect", async ({ body }) => {
        const b = Api.ConnectLinksRequest.safeParse(body ?? {});
        if (!b.success)
          throw badRequest(
            "Say from, to and the pairs: { from, to: { repo }, pairs: [{ call, api }] }.",
            {
              errors: b.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
            },
          );
        const { from, to, pairs, rule, preview } = b.data;
        if (!pairs.length && !rule)
          throw badRequest("Pick at least one pair, or the rule for all.");
        const c = await context(ctx.root, from, to);
        const calls = new Map(c.facts.filter((f) => f.kind === "call").map((f) => [f.id, f]));
        const apis = new Map(c.b.apis.map((a) => [a.id, a]));
        const at = now().toISOString();
        const corrections: FactCorrection[] = [];
        for (const p of pairs) {
          const f = calls.get(p.call);
          if (!f)
            throw c.estate.unverified.includes(from)
              ? conflict(`${from}'s facts aren't all verified yet: atticus verify ${from} first.`)
              : notFound(`${from} has no call ${p.call} on record.`);
          const api = apis.get(p.api);
          if (!api) throw notFound(`${c.b.name} has no API ${p.api} on record.`);
          corrections.push(
            FactCorrection.parse({
              schemaVersion: 1,
              fact: f.id,
              target: { kind: "call", file: f.cite.file, line: f.cite.line, value: f.cite.value },
              action: "link",
              link: {
                ...(to.repo ? { repo: to.repo } : { system: to.system }),
                ...(api.kind !== "operation" ? { entry: api.id } : {}),
                ...(api.method ? { method: api.method } : {}),
                path: api.path,
              },
              by: ctx.user,
              at,
            }),
          );
        }
        let ruleOut: Api.ConnectLinksResultT["rule"];
        const q = rule ? await openRuleQuestion(ctx.root, from) : undefined;
        if (rule && !q)
          throw conflict(
            `${from} has no open target question to answer for all its calls: pair them one by one.`,
          );
        const target = to.repo ?? to.system!;
        if (q) ruleOut = { question: q.id, match: "/**", target };
        const rel = `${factsRelOf(ctx.root)}/${from}.corrections.jsonl`;
        const lines = corrections.map(correctionLine);
        const verify = `atticus verify ${from} --write`;
        const commit = `git add ${rel}${q ? ` questions/` : ""} && git commit -m "${safeMessage(`${from}: calls paired with ${target} on the canvas`)}"`;
        // The rule's answer is worked out before anything is previewed or written: a problem with it refuses
        // the whole request, never leaving the pairings written and the person told it failed.
        let answer: { text: string } | undefined;
        if (q) {
          const { targetAnswerOf } = await import("./target-answer.js");
          const t = await targetAnswerOf(ctx.root, q, target);
          if ("problem" in t) throw new HttpError(422, "Atticus can't do that yet", t.problem);
          answer = t;
        }
        if (preview) {
          const { verifyWritePreview } = await import("./verify-preview.js");
          const v = await verifyWritePreview(ctx.root, from, { extra: corrections });
          return {
            status: 200,
            body: {
              written: false,
              file: rel,
              lines,
              ...(ruleOut ? { rule: ruleOut } : {}),
              ...(v ? { preview: v } : {}),
              verify,
              commit,
            } satisfies Api.ConnectLinksResultT,
          };
        }
        if (lines.length) {
          await mkdir(factsDirOf(ctx.root), { recursive: true });
          const file = join(factsDirOf(ctx.root), `${from}.corrections.jsonl`);
          await appendLines(file, lines);
          ctx.events.publish({ type: "file.changed", path: rel });
        }
        if (q && answer) {
          try {
            await answerQuestion(ctx.root, q.id, {
              text: answer.text,
              match: "/**",
              by: ctx.user,
              at,
            });
            ctx.events.publish({ type: "file.changed", path: "questions" });
          } catch (e) {
            if (e instanceof QuestionError)
              throw new HttpError(422, "Atticus can't do that yet", e.message);
            throw e;
          }
        }
        return {
          status: 200,
          body: {
            written: true,
            file: rel,
            lines,
            ...(ruleOut ? { rule: ruleOut } : {}),
            verify,
            commit,
          } satisfies Api.ConnectLinksResultT,
        };
      })
      // G4 (ADR 0176): "Make this a rule for every repo of this type?" after a pairing.
      .add("POST", "/api/reading-rules/from-pairing", async ({ body }) => {
        const b = Api.RuleFromPairingRequest.safeParse(body ?? {});
        if (!b.success) throw badRequest("Say the repo and the pairing's line: { repo, line }.");
        if (!REPO.test(b.data.repo))
          throw badRequest(`${JSON.stringify(b.data.repo)} isn't a repo name.`);
        // Only a pairing on file in this repo's corrections, as it is written there.
        const onFile = await readFile(
          join(factsDirOf(ctx.root), `${b.data.repo}.corrections.jsonl`),
          "utf8",
        ).catch(() => "");
        if (!onFile.split(/\r?\n/).some((l) => l.trim() === b.data.line.trim()))
          throw notFound(`${b.data.repo}'s corrections have no such pairing.`);
        const c = parseCorrections(b.data.line).corrections[0];
        if (!c || c.action !== "link" || !c.link)
          throw badRequest("That line isn't a pairing (a link correction).");
        const op = await loadOrgPack(orgPackDirOf(ctx.root));
        const type = estateRepos(op).find((x) => x.id === b.data.repo)?.type;
        if (!type) throw notFound(`No repo of the manifest is ${b.data.repo}.`);
        const { ruleFromPairing } = await import("./reading-rules.js");
        const { rulesAddCommand } = await import("./rules-commands.js");
        const rule = ruleFromPairing({
          type,
          to: c.link.repo ?? c.link.system ?? "it",
          file: c.target.file,
          line: c.target.line,
          value: c.target.value,
          ...(c.link.method ? { method: c.link.method } : {}),
          path: c.link.path,
          by: c.by,
          drafter: ctx.user,
        });
        const said: string[] = [];
        const code = await rulesAddCommand(
          ctx.root,
          { type },
          {
            key: rule.key,
            rule: rule.rule,
            files: (rule.files ?? []).join(","),
            ...(rule.example ? { example: rule.example } : {}),
            draft: true,
            ...(rule.by ? { by: rule.by } : {}),
          },
          { out: (l) => said.push(l), err: (l) => said.push(l) },
        );
        if (code !== 0) throw conflict(said.join(" "));
        const rel = `${isAdopted(ctx.root) ? ".atticus/org-pack" : "org-pack"}/reading-rules/types/${type}.yaml`;
        ctx.events.publish({ type: "file.changed", path: rel });
        return {
          status: 200,
          body: {
            file: rel,
            key: rule.key,
            rule: rule.rule,
            activate: `atticus rules activate ${rule.key} --type ${type}`,
          } satisfies Api.RuleFromPairingResultT,
        };
      })
      .add("POST", "/api/facts/{repo}/corrections/undo", async ({ params, body }) => {
        const repo = params.repo!;
        if (!REPO.test(repo)) throw badRequest(`${JSON.stringify(repo)} isn't a repo name.`);
        const b = Api.UndoCorrectionRequest.safeParse(body ?? {});
        if (!b.success) throw badRequest("Say which line to remove: { line }.");
        const file = join(factsDirOf(ctx.root), `${repo}.corrections.jsonl`);
        const rel = `${factsRelOf(ctx.root)}/${repo}.corrections.jsonl`;
        await withFileLock(file, async () => {
          const text = await readFile(file, "utf8").catch(() => undefined);
          if (text === undefined) throw notFound(`There is no ${rel}.`);
          const lines = text.split(/\r?\n/);
          const i = lines.findIndex((l) => l.trim() === b.data.line.trim());
          if (i < 0) throw notFound(`${rel} has no such line (it may be removed already).`);
          lines.splice(i, 1);
          // In the file's own line endings (a Windows checkout's CRLF), so only that line changes.
          await writeFileAtomic(file, lines.join(/\r\n/.test(text) ? "\r\n" : "\n"));
        });
        ctx.events.publish({ type: "file.changed", path: rel });
        return {
          status: 200,
          body: {
            removed: b.data.line,
            file: rel,
            verify: `atticus verify ${repo} --write`,
            commit: `git add ${rel} && git commit -m "${safeMessage(`${repo}: a correction undone`)}"`,
          },
        };
      })
  );
}
