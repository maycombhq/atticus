import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { parse } from "yaml";
import {
  ADAPTER_FIELDS,
  ADAPTER_KINDS,
  ADAPTER_TYPES,
  addManifestRepos,
  addPattern,
  Api,
  FileChangedError,
  loadOrgPack,
  ManifestEditError,
  manifestFiles,
  orgPackDirOf,
  orgPackFileProblems,
  readOrgPackFile,
  RepoDescription,
  setManifestField,
  setRuntimeAdapter,
  SetupEditError,
  writeOrgPackFile,
  type AdapterKind,
  type FileEdit,
} from "@maycombhq/core";
import { looksLikeKey } from "@maycombhq/model-providers";
import {
  badRequest,
  conflict,
  HttpError,
  notFound,
  requireConfirmation,
  type Router,
  type ServerContext,
} from "@maycombhq/server";
import { loadRepos } from "@maycombhq/workspace";
import type { Output } from "./commands.js";
import { isMetarepo } from "./metarepo-guard.js";
import { recordConfirmedAddress, whereKeyGoes, type ModelSetting } from "./model-address.js";
import { candidateOf, pastedUrls, planRepos, type Candidate } from "./setup-repos.js";

/**
 * ADR 0190: settings and setup in the app, "Edit, then Propose". Each route writes one file of
 * the metarepo through the code its command uses (init's, repos discover's, core's manifest and
 * runtime.yaml writers), shows the lines it would change first (`preview: true`), and leaves the
 * file for Propose for review, which has its own confirmation (ADR 0186). Writing the metarepo's
 * own files is local: no confirmation, no network. A secret is never taken: a token is kept in
 * the machine's credential store from the terminal (atticus secret set), never through this API.
 */

export interface SetupDeps {
  /**
   * Start the app for another folder and give its address (Open another folder). Default: a
   * second server in this process on a free port, for the same person.
   */
  openFolder?: (dir: string) => Promise<{ url: string }>;
}

const unprocessable = (detail: string) => new HttpError(422, "That can't be written", detail);

/**
 * A value that looks like a token or key: the model providers' shapes, and a Git host's own
 * (GitHub's ghp_/github_pat_, GitLab's glpat-, an Azure DevOps personal access token).
 */
const looksLikeSecret = (v: string) =>
  looksLikeKey(v) ||
  // An address with a user name, a token or a password in it (`https://<token>@host`,
  // `https://oauth2:<token>@host`): Git's credential helper or an environment variable gives them.
  /^https?:\/\/[^/?#\s]*@/i.test(v.trim()) ||
  /^(gh[pousr]_|github_pat_|glpat-)[A-Za-z0-9_-]{16,}$/.test(v.trim()) ||
  /^[a-z2-7]{52}$/.test(v.trim());

/** A command run here, its printed lines kept. */
async function run(f: (io: Output) => Promise<number>) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await f({ out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err };
}

function parseBody<T extends import("zod").ZodType>(
  schema: T,
  body: unknown,
): import("zod").infer<T> {
  const r = schema.safeParse(body ?? {});
  if (!r.success)
    throw badRequest("Some fields aren't right.", {
      errors: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  return r.data;
}

/** A setup edit's refusal as problem details: its own words. */
function refusal(e: unknown): never {
  if (e instanceof SetupEditError)
    throw e.code === "not-found"
      ? notFound(e.message)
      : e.code === "exists"
        ? conflict(e.message)
        : unprocessable(e.message);
  if (e instanceof ManifestEditError)
    throw e.code === "not-found" ? notFound(e.message) : unprocessable(e.message);
  if (e instanceof FileChangedError)
    throw conflict("The file changed since it was read (another window or the CLI): look again.");
  throw e;
}

/** A folder's name as an org pack's name: a lowercase slug. */
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** origin's URL in a folder, asked of Git (local, no network); undefined when there is none. */
const originOf = (dir: string) =>
  new Promise<string | undefined>((done) =>
    execFile(
      "git",
      ["config", "--get", "remote.origin.url"],
      { cwd: dir, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (e, out) => done(e ? undefined : String(out).trim() || undefined),
    ),
  );

const noteOf = (path: string, written: boolean) =>
  written
    ? `${path} changed: propose it for review. A person merges it on the Git host.`
    : `Nothing written yet: this is what ${path} would change.`;

const editBody = (e: FileEdit, extra: Record<string, unknown> = {}) => ({
  ...e,
  note: noteOf(e.path, e.written),
  ...extra,
});

export function uiSetupRoutes(r: Router, ctx: ServerContext, deps: SetupDeps = {}): Router {
  const root = ctx.root;
  const user = ctx.user;
  const changed = (path: string) => ctx.events.publish({ type: "file.changed", path });
  const needMetarepo = () => {
    if (!isMetarepo(root))
      throw conflict(`${root} isn't a metarepo yet: create it first (Create the metarepo here).`);
  };
  return (
    r
      // 1. Create the metarepo from the app (init's own code).
      .add("GET", "/api/setup/metarepo", async () => {
        const origin = await originOf(root);
        const { metarepoIdFromUrl } = await import("@maycombhq/adopt");
        const folder = basename(root);
        const body: Api.SetupMetarepoViewT = {
          metarepo: isMetarepo(root),
          root,
          folder,
          suggested: {
            name: slug(folder) || "metarepo",
            platform: slug(folder.replace(/[-_. ]?meta-?repo$/i, "")) || "default",
          },
          ...(origin ? { origin: origin.replace(/^(https?:\/\/)[^/@]*@/i, "$1") } : {}),
          ...(origin && metarepoIdFromUrl(origin)
            ? { metarepoId: metarepoIdFromUrl(origin)! }
            : {}),
        };
        return { status: 200, body };
      })
      .add("POST", "/api/setup/metarepo", async ({ body }) => {
        const b = parseBody(Api.CreateMetarepoRequest, body);
        if (isMetarepo(root)) throw conflict(`${root} is a metarepo already.`);
        const { initCommand } = await import("./setup-commands.js");
        const res = await run((io) =>
          initCommand(
            root,
            {
              name: b.name,
              platform: b.platform,
              ...(b.owner ? { owner: b.owner } : {}),
              ...(b.metarepo ? { metarepo: b.metarepo } : {}),
              by: b.owner || user,
            },
            io,
          ),
        );
        if (res.code === 2) throw badRequest([...res.err, ...res.out].join("\n"));
        if (!isMetarepo(root)) throw unprocessable([...res.err, ...res.out].join("\n"));
        changed(".");
        return {
          status: 201,
          body: { ok: res.code === 0, lines: [...res.out, ...res.err] },
        };
      })
      .add("POST", "/api/setup/open", async ({ body }) => {
        const b = parseBody(Api.OpenFolderRequest, body);
        const dir = resolve(b.path.trim());
        if (!isAbsolute(b.path.trim()))
          throw badRequest("Give the folder's full path, such as C:\\work\\forge-metarepo.");
        if (
          !(await stat(dir).then(
            (s) => s.isDirectory(),
            () => false,
          ))
        )
          throw notFound(`There is no folder ${dir} on this machine.`);
        const open =
          deps.openFolder ??
          (async (d: string) => {
            const { startUi } = await import("./ui-commands.js");
            const srv = await startUi(d, {
              port: 0,
              user,
              ...(ctx.version ? { version: ctx.version } : {}),
            });
            ctx.onClose?.add(() => void srv.close());
            return { url: srv.url };
          });
        const { url } = await open(dir);
        return { status: 200, body: { url, root: dir, metarepo: isMetarepo(dir) } };
      })

      // 2. Add repos: paste clone URLs, or discover a folder of clones (repos discover's code).
      .add("POST", "/api/setup/repos/plan", async ({ body }) => {
        needMetarepo();
        const b = parseBody(Api.ReposPlanRequest, body);
        const listed = await loadRepos(root).catch(() => []);
        const platforms = (await manifestFiles(root)).map((f) => f.platform);
        let candidates: Candidate[] = [];
        let skipped: { path: string; reason: string }[] = [];
        if (b.dir) {
          const dir = resolve(b.dir.trim());
          if (
            !(await stat(dir).then(
              (s) => s.isDirectory(),
              () => false,
            ))
          )
            throw notFound(`There is no folder ${dir} on this machine.`);
          // With several platforms the repos are one platform's, and only the person knows
          // which: the platforms come back to choose from, before the folder is read.
          if (!b.platform && platforms.length > 1) {
            const ask: Api.ReposPlanViewT = {
              platforms,
              repos: [],
              listed: [],
              refused: [],
              skipped: [],
            };
            return { status: 200, body: ask };
          }
          const { reposDiscover, AdoptError } = await import("@maycombhq/adopt");
          const found = await reposDiscover(
            root,
            { dir },
            { dryRun: true, ...(b.platform ? { platform: b.platform } : {}) },
          ).catch((e: unknown) => {
            // discover's words name its CLI flags; the app has a field for each.
            if (e instanceof AdoptError)
              throw unprocessable(
                e.message.replace(/ with --platform\b/g, " (choose the platform)"),
              );
            throw e;
          });
          skipped = found.skipped;
          candidates = found.repos.map((f) => ({
            given: f.dir ?? f.entry.url,
            url: f.entry.url,
            // Two clones of one name in the folder are -2 already (discover's own ids).
            id: f.entry.id,
            type: f.entry.type,
            defaultBranch: f.entry.defaultBranch,
            detected: { signals: f.detection.signals, confidence: f.detection.confidence },
          }));
        } else {
          const { cloneAt, typeOf } = await import("./repo-commands.js");
          for (const given of pastedUrls(b.urls ?? "").slice(0, 500)) {
            const c = candidateOf(given);
            // A clone on this machine: its origin and branch, and its type from its own files.
            const clone = await cloneAt(c.url);
            if (clone?.origin) {
              const t = await typeOf(c.url, undefined);
              candidates.push({
                given,
                url: candidateOf(clone.origin).url,
                id: c.id,
                ...(clone.branch ? { defaultBranch: clone.branch } : {}),
                ...(t
                  ? { type: t.type, detected: { signals: t.signals, confidence: t.confidence } }
                  : {}),
              });
            } else candidates.push(c);
          }
          if (!candidates.length)
            throw badRequest(
              "Paste one clone URL a line (or several), or give a folder of clones.",
            );
        }
        const plan = planRepos(
          candidates,
          listed.map((x) => ({ id: x.id, url: x.url })),
        );
        const body2: Api.ReposPlanViewT = {
          platforms,
          ...(b.platform
            ? { platform: b.platform }
            : platforms.length === 1
              ? { platform: platforms[0]! }
              : {}),
          ...plan,
          skipped,
        };
        return { status: 200, body: body2 };
      })
      .add("POST", "/api/setup/repos", async ({ body }) => {
        needMetarepo();
        const b = parseBody(Api.AddReposRequest, body);
        const files = await manifestFiles(root);
        const platform = b.platform ?? (files.length === 1 ? files[0]!.platform : undefined);
        if (!platform)
          throw badRequest(
            files.length
              ? `There are ${files.length} platforms (${files.map((f) => f.platform).join(", ")}): say which.`
              : "The org pack has no platform profile yet: create the metarepo first.",
          );
        const at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
        try {
          const e = await addManifestRepos(
            root,
            platform,
            b.repos.map((x) => ({
              id: x.id,
              url: x.url,
              type: x.type?.trim() || "unknown",
              owner: x.owner?.trim() || "unassigned",
              ...(x.defaultBranch ? { defaultBranch: x.defaultBranch } : {}),
              ...(x.description?.trim()
                ? {
                    description: RepoDescription.parse({
                      text: x.description.trim(),
                      trust: "verified",
                      by: user,
                      at,
                    }),
                  }
                : {}),
            })),
            { preview: b.preview === true },
          );
          const path = e.file.rel;
          if (e.written) changed(path);
          return {
            status: 200,
            body: {
              path,
              changes: e.changes,
              written: e.written,
              note: e.written
                ? `Added ${b.repos.length} repo${b.repos.length === 1 ? "" : "s"} to ${path}: propose it for review. Then clone them (Sync on Onboarding) and read each.`
                : noteOf(path, false),
            },
          };
        } catch (e) {
          return refusal(e);
        }
      })
      .add("POST", "/api/repos/{repoId}/type/detect", async ({ params }) => {
        needMetarepo();
        const id = params.repoId!;
        if (!(await loadRepos(root).catch(() => [])).some((x) => x.id === id))
          throw notFound(`There is no repo ${id} in any manifest.`);
        const { repoFor } = await import("./repo-for.js");
        const repo = await repoFor(root, id);
        if (!repo)
          throw conflict(
            `${id} isn't cloned here yet, so there are no files to read its type from: clone it first (Sync on Onboarding, or atticus workspace sync).`,
          );
        const op = await loadOrgPack(orgPackDirOf(root));
        // The org pack's own repo types (atticus repo-type detect, ADR 0077) when it has any;
        // else the type repo add reads from the files.
        if (op.repoTypes.length) {
          const { repoTypeDetect } = await import("./repo-type-commands.js");
          const res = await run((io) => repoTypeDetect(root, id, { json: true }, io));
          if (res.code !== 0) throw unprocessable([...res.err, ...res.out].join("\n"));
          const m = JSON.parse(res.out.join("\n")) as {
            verdict: string;
            best?: string;
            matches: { type: string; name: string; score: number }[];
          };
          const body: Api.RepoTypeDetectViewT = {
            repo: id,
            from: "repo-types",
            verdict: m.verdict,
            ...(m.best && (m.verdict === "clear" || m.verdict === "partial")
              ? { type: m.best }
              : {}),
            matches: m.matches.map((x) => ({ type: x.type, name: x.name, score: x.score })),
          };
          return { status: 200, body };
        }
        const { typeOf } = await import("./repo-commands.js");
        const t = await typeOf(repo.dir, undefined);
        const body: Api.RepoTypeDetectViewT = {
          repo: id,
          from: "files",
          verdict: t ? "clear" : "none",
          ...(t ? { type: t.type, signals: t.signals, confidence: t.confidence } : {}),
          matches: [],
        };
        return { status: 200, body };
      })
      .add("PUT", "/api/repos/{repoId}/type", async ({ params, body }) => {
        needMetarepo();
        const b = parseBody(Api.RepoTypeRequest, body);
        try {
          const e = await setManifestField(root, params.repoId!, "type", b.type, {
            preview: b.preview === true,
          });
          if (e.written) changed(e.file.rel);
          return {
            status: 200,
            body: {
              path: e.file.rel,
              changes: e.changes,
              written: e.written,
              note: noteOf(e.file.rel, e.written),
            },
          };
        } catch (e) {
          return refusal(e);
        }
      })

      // 3. The outside systems in runtime.yaml.
      .add("GET", "/api/setup/adapters", async () => {
        needMetarepo();
        const file = await readOrgPackFile(root, "runtime.yaml");
        const op = await loadOrgPack(orgPackDirOf(root));
        const body: Api.AdaptersViewT = {
          path: file.path,
          sha256: file.sha256,
          kinds: ADAPTER_KINDS.map((kind) => {
            const c = op.runtime.adapters[kind];
            return {
              kind,
              types: [...ADAPTER_TYPES[kind]],
              fields: ADAPTER_FIELDS[kind].map((f) => ({ name: f.name, list: f.list === true })),
              current: c ? { type: c.type, settings: c.settings } : null,
            };
          }),
          problems: op.problems
            .filter((p) => p.file.endsWith("runtime.yaml"))
            .map((p) => `${p.file}: ${p.path ? `${p.path}: ` : ""}${p.message}`),
        };
        return { status: 200, body };
      })
      .add("PUT", "/api/setup/adapters/{kind}", async ({ params, body }) => {
        needMetarepo();
        const kind = params.kind as AdapterKind;
        if (!(ADAPTER_KINDS as readonly string[]).includes(kind))
          throw notFound(`${kind} isn't an outside system: one of ${ADAPTER_KINDS.join(", ")}.`);
        const b = parseBody(Api.AdapterRequest, body);
        for (const [name, v] of Object.entries(b.value?.settings ?? {}))
          for (const one of Array.isArray(v) ? v : [v])
            if (typeof one === "string" && looksLikeSecret(one))
              throw unprocessable(
                `${name} looks like a token or key. A secret never goes in runtime.yaml: keep it in this machine's credential store from your terminal (atticus secret set <NAME>), under the name the adapter's plugin reads.`,
              );
        try {
          const e = await setRuntimeAdapter(root, kind, b.value, {
            preview: b.preview === true,
            ...(b.baseSha256 ? { baseSha256: b.baseSha256 } : {}),
          });
          if (e.written) changed(e.path);
          return { status: 200, body: editBody(e) };
        } catch (e) {
          return refusal(e);
        }
      })

      // 4 and 6. The raw editor (the fallback), and the simple forms.
      .add("GET", "/api/setup/file", async ({ query }) => {
        needMetarepo();
        try {
          const body: Api.OrgPackFileViewT = await readOrgPackFile(root, query.get("path") ?? "");
          return { status: 200, body };
        } catch (e) {
          return refusal(e);
        }
      })
      .add("PUT", "/api/setup/file", async ({ body }) => {
        needMetarepo();
        const b = parseBody(Api.OrgPackFileRequest, body);
        try {
          const was = await readOrgPackFile(root, b.path);
          // runtime.yaml: where the model's key goes is the person's to confirm (ADR 0186), and
          // no value that looks like a key is written, as in the AI settings.
          let model: ModelSetting;
          let ask = false;
          // The name as Atticus reads it: readOrgPackFile refuses another case (`Runtime.yaml`).
          if (was.rel.toLowerCase() === "runtime.yaml") {
            // New content that doesn't read is refused first, in the schema's words (never a 500).
            const problems = orgPackFileProblems(was.rel, b.content);
            if (problems.length) throw unprocessable(problems.join("; "));
            // A file on disk that doesn't parse (the one being fixed) has no model to compare.
            const before = (() => {
              try {
                return (parse(was.content) ?? {}) as { adapters?: { model?: ModelSetting } };
              } catch {
                return {};
              }
            })();
            const after = (parse(b.content) ?? {}) as {
              adapters?: Record<string, { settings?: Record<string, unknown> } | string | null>;
            };
            for (const a of Object.values(after.adapters ?? {}))
              for (const v of Object.values(a && typeof a === "object" ? (a.settings ?? {}) : {}))
                for (const one of Array.isArray(v) ? v : [v])
                  if (typeof one === "string" && looksLikeSecret(one))
                    throw unprocessable(
                      "A setting in runtime.yaml looks like a token or key: a secret never goes in the org pack (atticus secret set <NAME> keeps it in this machine's credential store).",
                    );
            model = after.adapters?.model as ModelSetting;
            ask =
              model !== undefined && whereKeyGoes(before.adapters?.model) !== whereKeyGoes(model);
          }
          if (ask && b.preview !== true)
            requireConfirmation(ctx.confirmations, "ai-model", "model", b.confirmation);
          const e = await writeOrgPackFile(root, b.path, b.content, {
            baseSha256: b.baseSha256,
            preview: b.preview === true,
          });
          if (e.written) {
            if (ask) await recordConfirmedAddress(root, model);
            changed(e.path);
          }
          return {
            status: 200,
            body: editBody(e, ask ? { confirm: "ai-model" } : {}),
          };
        } catch (e) {
          return refusal(e);
        }
      })
      .add("POST", "/api/setup/patterns", async ({ body }) => {
        needMetarepo();
        const b = parseBody(Api.PatternRequest, body);
        try {
          const { preview, ...p } = b;
          const e = await addPattern(root, p, { preview: preview === true });
          if (e.written) changed(e.path);
          return { status: 200, body: editBody(e) };
        } catch (e) {
          return refusal(e);
        }
      })
      .add("POST", "/api/setup/sources", async ({ body }) => {
        needMetarepo();
        const b = parseBody(Api.SourceRequest, body);
        const file = join(orgPackDirOf(root), "sources.yaml");
        const before = await readFile(file, "utf8").catch(() => "");
        const { sourcesAdd } = await import("./knowledge-commands.js");
        // sources add's own write: onto sources.yaml as it read it, so an edit meanwhile is 409.
        const res = await run((io) =>
          sourcesAdd(root, b.type, b.location.trim(), io, {
            ...(b.id ? { id: b.id } : {}),
            ...(b.path ? { path: b.path } : {}),
            ...(b.ref ? { ref: b.ref } : {}),
            save: b.preview !== true,
          }),
        ).catch(refusal);
        if (res.code !== 0) throw unprocessable([...res.err, ...res.out].join("\n"));
        const path = (await readOrgPackFile(root, "sources.yaml")).path;
        if (b.preview === true) {
          // What sources add prints is the entry to add under wikis:.
          const entry = res.out.filter((l) => l.startsWith("  - "));
          return {
            status: 200,
            body: {
              path,
              changes: entry.map((now) => ({ now })),
              written: false,
              note: noteOf(path, false),
            },
          };
        }
        const after = await readFile(file, "utf8").catch(() => "");
        const { changedLines, lfOnly } = await import("@maycombhq/core");
        changed(path);
        return {
          status: 200,
          body: {
            path,
            changes: changedLines(lfOnly(before), lfOnly(after)),
            written: true,
            note: `${noteOf(path, true)} Then sync it on Knowledge › Sources.`,
          },
        };
      })
  );
}
