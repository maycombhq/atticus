import { normalizePath, type CatalogRecord } from "@maycombhq/core";
import { defineExtractor, type RepoHandle, type ScanContext } from "@maycombhq/sdk";
import {
  callOf,
  callsIn,
  descendants,
  kids,
  lineOf,
  namePath,
  objectProperty,
  same,
  stringValue,
  withTree,
  type Node,
} from "../lang/code-tree.js";
import { syntaxLanguageOf } from "../lang/syntax.js";
import { topicName } from "../platform/gcp.js";
import { attrOf, child } from "../platform/hcl.js";
import { loadManifests, readYamlDocs, type YamlDoc } from "../platform/manifests.js";
import { loadTerraform, tfName, tfString } from "../platform/terraform.js";
import { arr, at, componentFor, deployment, envOf, isObj, str } from "../platform/util.js";
import { component, endpoint, ev, loose, own, read, setting, slug, sources } from "./common.js";

/**
 * Serverless functions (ADR 0040): Components of type `function`, a `function` Endpoint per
 * trigger, `schedule` Settings and Deployments.
 *
 * Templates in a repo describe that repo's function app, so the repo's component is the
 * function component (runtime and Deployment platform `lambda` or `azure-functions`) and each
 * function's triggers are its Endpoints, id `<component>.function.<function>.<kind>-<value>`,
 * pathOrTopic `<kind>:<value>` with kind http (method set), queue, topic, schedule, storage or
 * event. Queue and topic triggers are also event-subscribe loose ends, so merge links the
 * publishers. A schedule is a Setting `schedule.<function>` of kind schedule. An HTTP trigger
 * of a function (or a path) called a webhook or hook is a `webhook` Endpoint instead, id
 * `<component>.webhook.<path>`, method POST unless the trigger says one, pathOrTopic the path.
 * What a function publishes from its handler file (kafkajs `send`, Python Kafka `send` and
 * `produce`) is an event-publish loose end of the function app.
 *
 * - AWS SAM (`AWS::Serverless::Function` events Api, HttpApi, SQS, SNS, Schedule,
 *   ScheduleV2, S3) and CloudFormation as CDK synthesizes it (`AWS::Lambda::Function`, with
 *   `AWS::Events::Rule` schedules and `AWS::Lambda::EventSourceMapping` queues that target it).
 *   Intrinsic tags (!GetAtt, !Ref, ...) are read as their argument; queue names come from the
 *   referenced queue's QueueName, else its logical id.
 * - Serverless Framework `serverless.yml` (http, httpApi, sqs, sns, schedule, s3 events; the
 *   stage as environment when literal).
 * - Azure Functions: `function.json` bindings and isolated-worker attributes (`[Function]` with
 *   `[HttpTrigger]`, `[TimerTrigger]`, `[QueueTrigger]`, `[ServiceBusTrigger]`,
 *   `[BlobTrigger]`); HTTP routes get the default `/api` prefix.
 * - Infrastructure repos: Terraform `google_cloudfunctions2_function` (an event trigger's topic,
 *   else HTTP) and Knative `serving.knative.dev` Services, each its own component by name
 *   (platform `cloud-functions` or `knative`, environment from the folder or namespace).
 */

const YAML = ["**/*.yaml", "**/*.yml", "**/*.json"];
const CS = ["**/*.cs"];
const TF = ["**/*.tf"];

type Kind = "http" | "queue" | "topic" | "schedule" | "storage" | "event";

interface Trigger {
  fn: string;
  kind: Kind;
  value: string;
  method?: string;
  path: string;
  line?: number;
  /** Line of the schedule expression itself, for its Setting (of the route's path, for a webhook). */
  valueLine?: number;
}

interface Fn {
  name: string;
  platform: "lambda" | "azure-functions";
  env: string;
  path: string;
  line?: number;
  /** The code file the handler names (`src/handler.handle` → `src/handler`, no extension). */
  module?: string;
}

/** Attributes in C# are code; templates and bindings are infrastructure. */
const sourceOf = (path: string) =>
  path.endsWith(".cs") ? ("code" as const) : ("infrastructure" as const);
const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

/** `src/handler.handle` (with an optional CodeUri folder) → the module `src/handler`. */
function moduleOf(handler: string | undefined, codeUri?: string): { module?: string } {
  if (!handler || handler.includes("::") || !handler.includes(".")) return {};
  const mod = handler.slice(0, handler.lastIndexOf("."));
  const dir = codeUri && !/^s3:|^\.?\/?$/.test(codeUri) ? codeUri.replace(/^\.\/|\/$/g, "") : "";
  return { module: dir ? `${dir}/${mod}` : mod };
}

/**
 * An HTTP trigger that receives another system's callbacks: the function is called a webhook
 * (`tidewaterWebhook`, `stripe-hook-receiver`) or its path has a `webhook(s)` or `hook(s)` segment.
 */
const isWebhook = (fn: string, path: string) =>
  /(^|[^a-z])hooks?([^a-z]|$)|webhook/i.test(kebab(fn)) ||
  /(^|\/)(web)?hooks?(\/|$)/i.test(path.replace(/\{[^}]*\}/g, ""));
const INTRINSIC = /!(Ref|GetAtt|Sub|Join|Select|ImportValue|FindInMap|If|Split|Base64)\b[ \t]*/g;

export const serverlessExtractor = defineExtractor({
  id: "serverless",
  version: "0.1.1",
  claims: [...YAML, ...CS, ...TF],
  async *scan(repo, ctx) {
    const comp = own(repo, ctx);
    const fns: Fn[] = [];
    const triggers: Trigger[] = [];

    for (const path of await sources(repo, YAML)) {
      const text = await read(repo, ctx, path);
      if (text === undefined) continue;
      const name = path.split("/").pop()!;
      if (/AWS::(Serverless|Lambda)::Function/.test(text)) {
        const doc = readYamlDocs(text.replace(INTRINSIC, ""))?.[0];
        if (doc) cloudFormation(doc, path, fns, triggers);
        else ctx.warn("Could not read this file as YAML; skipped it.", path);
      } else if (/^serverless\.ya?ml$/.test(name) && /^functions\s*:/m.test(text)) {
        const doc = readYamlDocs(text, { cache: repo.parseCache, path })?.[0];
        if (doc) serverlessFramework(doc, path, fns, triggers);
        else ctx.warn("Could not read this file as YAML; skipped it.", path);
      } else if (name === "function.json" && /Trigger"/.test(text)) {
        const doc = readYamlDocs(text, { cache: repo.parseCache, path })?.[0];
        if (doc) azureFunctionJson(doc, path, fns, triggers);
      }
    }
    for (const path of await sources(repo, CS)) {
      const text = await read(repo, ctx, path);
      if (text !== undefined && /\[Function\s*\(/.test(text))
        await withTree("c_sharp", text, (root) => azureIsolated(root, path, fns, triggers), {
          cache: repo.parseCache,
          path,
        });
    }

    // The repo's function app.
    if (fns.length > 0) {
      const evOf = (f: Fn) => ev(repo, sourceOf(f.path), f.path, f.line);
      const c = component({
        repo,
        ctx,
        id: comp,
        type: "function",
        runtime: fns[0]!.platform,
        source: "infrastructure",
        path: fns[0]!.path,
      });
      c.evidence = fns.map(evOf);
      yield c;
      const byEnv = new Map<string, Fn[]>();
      for (const f of fns) byEnv.set(f.env, [...(byEnv.get(f.env) ?? []), f]);
      for (const [env, list] of byEnv)
        yield deployment({
          component: comp,
          env,
          platform: list[0]!.platform,
          evidence: list.map(evOf),
        });
    }
    yield* emitTriggers(repo, comp, fns, triggers);
    yield* handlerEvents(repo, ctx, comp, fns);
    yield* infraFunctions(repo, ctx);
  },
});

function* emitTriggers(
  repo: RepoHandle,
  comp: string,
  fns: Fn[],
  triggers: Trigger[],
): Generator<CatalogRecord> {
  const envOfFn = new Map(fns.map((f) => [f.name, f.env]));
  const seen = new Set<string>();
  for (const t of triggers) {
    const source = t.path.endsWith(".cs") ? "code" : "infrastructure";
    // An HTTP trigger that receives another system's callbacks is a webhook endpoint of the
    // component (like a registered callback), not a plain function trigger.
    const hook = t.kind === "http" && isWebhook(t.fn, t.value);
    const e = hook
      ? endpoint({
          repo,
          component: comp,
          endpointType: "webhook",
          prefix: "webhook",
          name: t.value,
          method: t.method && t.method !== "ANY" ? t.method : "POST",
          pathOrTopic: t.value,
          normalizedPath: normalizePath(t.value),
          source,
          path: t.path,
          // The route's path is what defines the webhook endpoint.
          ...((t.valueLine ?? t.line) ? { line: t.valueLine ?? t.line } : {}),
        })
      : endpoint({
          repo,
          component: comp,
          endpointType: "function",
          prefix: `function.${slug(t.fn)}`,
          name: `${t.kind}-${t.value}`,
          ...(t.method ? { method: t.method } : {}),
          pathOrTopic: `${t.kind}:${t.value}`,
          source,
          path: t.path,
          ...(t.line ? { line: t.line } : {}),
        });
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    yield e;
    if (t.kind === "schedule")
      yield setting({
        repo,
        component: comp,
        env: envOfFn.get(t.fn),
        settingKind: "schedule",
        key: `schedule.${t.fn}`,
        value: t.value,
        source: t.path.endsWith(".cs") ? "code" : "infrastructure",
        path: t.path,
        line: t.valueLine ?? t.line,
      });
    if (t.kind === "queue" || t.kind === "topic")
      yield loose(
        repo,
        comp,
        "event-subscribe",
        t.value,
        t.path,
        t.valueLine ?? t.line,
        t.path.endsWith(".cs") ? "code" : "infrastructure",
      );
  }
}

/**
 * Events a function publishes from its own code: the handler file the template names (a
 * function package has no server framework, so no backend extractor reads it). kafkajs
 * `producer.send({ topic: "x", ... })` and Python `producer.send("x", ...)` / `.produce("x", ...)`
 * in a file that uses Kafka become event-publish loose ends of the function app.
 */
async function* handlerEvents(
  repo: RepoHandle,
  ctx: ScanContext,
  comp: string,
  fns: Fn[],
): AsyncGenerator<CatalogRecord> {
  const modules = [...new Set(fns.flatMap((f) => (f.module ? [f.module] : [])))];
  if (modules.length === 0) return;
  const files = await sources(repo, ["**/*.ts", "**/*.js", "**/*.mjs", "**/*.cjs", "**/*.py"]);
  const seen = new Set<string>();
  for (const mod of modules) {
    for (const path of files.filter((p) => p.replace(/\.\w+$/, "") === mod.replace(/^\.\//, ""))) {
      const text = await read(repo, ctx, path);
      const lang = syntaxLanguageOf(path);
      if (text === undefined || !lang || !/kafka/i.test(text)) continue;
      const python = lang === "python";
      const topics = await withTree(
        lang,
        text,
        (root) =>
          callsIn(root).flatMap((c) => {
            if (!c.receiver) return [];
            // Python producer.send("x", ...) / .produce(topic="x"); kafkajs producer.send({ topic: "x" }).
            const node = python
              ? c.name === "send" || c.name === "produce"
                ? (c.args[0] ?? c.kwargs.get("topic"))
                : undefined
              : c.name === "send"
                ? objectProperty(c.args[0], "topic")
                : undefined;
            const topic = stringValue(node, !python);
            return node && topic && /^\S+$/.test(topic) ? [{ topic, line: lineOf(node) }] : [];
          }),
        { cache: repo.parseCache, path },
      );
      for (const { topic, line } of topics) {
        const key = `${topic}|${path}|${line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        yield loose(repo, comp, "event-publish", topic, path, line);
      }
    }
  }
}

// ------------------------------------------------------------------ AWS

function cloudFormation(doc: YamlDoc, path: string, fns: Fn[], triggers: Trigger[]) {
  const resources = at(doc.value, "Resources");
  if (!isObj(resources)) return;
  const queueName = (ref: string | undefined) => {
    if (!ref) return undefined;
    if (/^arn:/.test(ref)) return ref.split(":").pop();
    const id = ref.split(".")[0]!;
    return (
      str(at(resources, id, "Properties", "QueueName")) ??
      str(at(resources, id, "Properties", "TopicName")) ??
      kebab(id)
    );
  };
  const refOf = (v: unknown): string | undefined =>
    str(v) ?? str(at(v, "Fn::GetAtt", 0)) ?? str(at(v, "Ref"));
  const fnName = new Map<string, string>();
  for (const [id, r] of Object.entries(resources)) {
    const type = str(at(r, "Type"));
    if (type !== "AWS::Serverless::Function" && type !== "AWS::Lambda::Function") continue;
    const name = str(at(r, "Properties", "FunctionName")) ?? kebab(id);
    fnName.set(id, name);
    fns.push({
      name,
      platform: "lambda",
      env: "default",
      path,
      line: doc.line(["Resources", id, "Type"]),
      ...moduleOf(str(at(r, "Properties", "Handler")), str(at(r, "Properties", "CodeUri"))),
    });
    const events = at(r, "Properties", "Events");
    if (!isObj(events)) continue;
    for (const [ev, e] of Object.entries(events)) {
      const et = str(at(e, "Type"));
      const p = at(e, "Properties");
      const line = doc.line(["Resources", id, "Properties", "Events", ev]);
      const valueLine = (k: string) =>
        doc.line(["Resources", id, "Properties", "Events", ev, "Properties", k]);
      if ((et === "Api" || et === "HttpApi") && str(at(p, "Path")))
        triggers.push({
          fn: name,
          kind: "http",
          value: str(at(p, "Path"))!,
          method: (str(at(p, "Method")) ?? "ANY").toUpperCase(),
          path,
          line,
        });
      else if (et === "SQS" && queueName(refOf(at(p, "Queue"))))
        triggers.push({
          fn: name,
          kind: "queue",
          value: queueName(refOf(at(p, "Queue")))!,
          path,
          line,
          valueLine: valueLine("Queue"),
        });
      else if (et === "SNS" && queueName(refOf(at(p, "Topic"))))
        triggers.push({
          fn: name,
          kind: "topic",
          value: queueName(refOf(at(p, "Topic")))!,
          path,
          line,
          valueLine: valueLine("Topic"),
        });
      else if (
        (et === "Schedule" || et === "ScheduleV2") &&
        str(at(p, "Schedule") ?? at(p, "ScheduleExpression"))
      )
        triggers.push({
          fn: name,
          kind: "schedule",
          value: str(at(p, "Schedule") ?? at(p, "ScheduleExpression"))!,
          path,
          line,
          valueLine: valueLine(at(p, "Schedule") !== undefined ? "Schedule" : "ScheduleExpression"),
        });
      else if (et === "S3" && refOf(at(p, "Bucket")))
        triggers.push({
          fn: name,
          kind: "storage",
          value: kebab(refOf(at(p, "Bucket"))!),
          path,
          line,
        });
    }
  }
  // CDK and plain CloudFormation: rules and event source mappings that target a function.
  for (const [id, r] of Object.entries(resources)) {
    const type = str(at(r, "Type"));
    const p = at(r, "Properties");
    if (type === "AWS::Events::Rule" && str(at(p, "ScheduleExpression"))) {
      for (const t of arr(at(p, "Targets"))) {
        const name = fnName.get(refOf(at(t, "Arn"))?.split(".")[0] ?? "");
        if (name)
          triggers.push({
            fn: name,
            kind: "schedule",
            value: str(at(p, "ScheduleExpression"))!,
            path,
            line: doc.line(["Resources", id]),
            valueLine: doc.line(["Resources", id, "Properties", "ScheduleExpression"]),
          });
      }
    } else if (type === "AWS::Lambda::EventSourceMapping") {
      const name = fnName.get(refOf(at(p, "FunctionName"))?.split(".")[0] ?? "");
      const q = queueName(refOf(at(p, "EventSourceArn")));
      if (name && q)
        triggers.push({
          fn: name,
          kind: "queue",
          value: q,
          path,
          line: doc.line(["Resources", id]),
        });
    }
  }
}

function serverlessFramework(doc: YamlDoc, path: string, fns: Fn[], triggers: Trigger[]) {
  const stage = str(at(doc.value, "provider", "stage"));
  const env = stage && !stage.includes("${") ? stage : "default";
  const functions = at(doc.value, "functions");
  if (!isObj(functions)) return;
  for (const [name, f] of Object.entries(functions)) {
    fns.push({
      name,
      platform: "lambda",
      env,
      path,
      line: doc.line(["functions", name]),
      ...moduleOf(str(at(f, "handler"))),
    });
    arr(at(f, "events")).forEach((e, i) => {
      const line = doc.line(["functions", name, "events", i]);
      const http = at(e, "http") ?? at(e, "httpApi");
      if (isObj(http) && str(http.path)) {
        const p = str(http.path)!;
        triggers.push({
          fn: name,
          kind: "http",
          value: p.startsWith("/") ? p : `/${p}`,
          method: (str(http.method) ?? "ANY").toUpperCase(),
          path,
          line,
          valueLine: doc.line([
            "functions",
            name,
            "events",
            i,
            at(e, "http") !== undefined ? "http" : "httpApi",
            "path",
          ]),
        });
      }
      const sqs = str(at(e, "sqs")) ?? str(at(e, "sqs", "arn"));
      if (sqs) triggers.push({ fn: name, kind: "queue", value: sqs.split(":").pop()!, path, line });
      const sns = str(at(e, "sns")) ?? str(at(e, "sns", "topicName"));
      if (sns) triggers.push({ fn: name, kind: "topic", value: sns.split(":").pop()!, path, line });
      const schedule = str(at(e, "schedule")) ?? str(at(e, "schedule", "rate"));
      if (schedule) triggers.push({ fn: name, kind: "schedule", value: schedule, path, line });
      const s3 = str(at(e, "s3")) ?? str(at(e, "s3", "bucket"));
      if (s3) triggers.push({ fn: name, kind: "storage", value: s3, path, line });
    });
  }
}

// ------------------------------------------------------------------ Azure

const AZ_ROUTE = (route: string) => `/api/${route.replace(/^\/+/, "")}`;

function azureFunctionJson(doc: YamlDoc, path: string, fns: Fn[], triggers: Trigger[]) {
  const name = path.split("/").slice(-2)[0] ?? "function";
  const bindings = arr(at(doc.value, "bindings"));
  if (!bindings.some((b) => /Trigger$/.test(str(at(b, "type")) ?? ""))) return;
  fns.push({
    name,
    platform: "azure-functions",
    env: "default",
    path,
    line: doc.line(["bindings"]),
  });
  bindings.forEach((b, i) => {
    const type = str(at(b, "type"));
    const line = doc.line(["bindings", i]);
    if (type === "httpTrigger")
      for (const m of arr(at(b, "methods")).length ? arr(at(b, "methods")) : ["any"])
        triggers.push({
          fn: name,
          kind: "http",
          value: AZ_ROUTE(str(at(b, "route")) ?? name),
          method: String(m).toUpperCase(),
          path,
          line,
        });
    else if (type === "timerTrigger" && str(at(b, "schedule")))
      triggers.push({ fn: name, kind: "schedule", value: str(at(b, "schedule"))!, path, line });
    else if (
      (type === "queueTrigger" || type === "serviceBusTrigger") &&
      str(at(b, "queueName") ?? at(b, "topicName"))
    )
      triggers.push({
        fn: name,
        kind: at(b, "topicName") ? "topic" : "queue",
        value: str(at(b, "queueName") ?? at(b, "topicName"))!,
        path,
        line,
      });
    else if (type === "blobTrigger" && str(at(b, "path")))
      triggers.push({
        fn: name,
        kind: "storage",
        value: str(at(b, "path"))!.split("/")[0]!,
        path,
        line,
      });
    else if (type === "eventHubTrigger" && str(at(b, "eventHubName")))
      triggers.push({ fn: name, kind: "topic", value: str(at(b, "eventHubName"))!, path, line });
  });
}

/** Attributes of a C# declaration: name (without the Attribute suffix), arguments and line. */
function csAttributes(
  decl: Node,
): { name: string; args: Node[]; named: Map<string, Node>; line: number }[] {
  const out: { name: string; args: Node[]; named: Map<string, Node>; line: number }[] = [];
  for (const list of kids(decl).filter((c) => c.type === "attribute_list"))
    for (const a of kids(list).filter((c) => c.type === "attribute")) {
      const name = namePath(a.childForFieldName("name"))
        ?.at(-1)
        ?.replace(/Attribute$/, "");
      if (!name) continue;
      const args: Node[] = [];
      const named = new Map<string, Node>();
      for (const arg of kids(kids(a).find((c) => c.type === "attribute_argument_list"))) {
        const key = kids(arg).find((c) => c.type === "name_equals" || c.type === "name_colon");
        const value = kids(arg)
          .filter((c) => !same(c, key))
          .at(-1);
        if (!value) continue;
        if (key) named.set(kids(key)[0]?.text ?? "", value);
        else args.push(value);
      }
      out.push({ name, args, named, line: lineOf(list) });
    }
  return out;
}

/** Isolated-worker functions: methods with [Function("name")] and a trigger on a parameter. */
function azureIsolated(root: Node, path: string, fns: Fn[], triggers: Trigger[]) {
  for (const m of descendants(root)) {
    if (m.type !== "method_declaration") continue;
    const mark = csAttributes(m).find((a) => a.name === "Function");
    if (!mark) continue;
    const first = mark.args[0];
    const nameofArg = first ? callOf(first) : undefined;
    const name =
      stringValue(first) ??
      (nameofArg?.name === "nameof" ? namePath(nameofArg.args[0])?.at(-1) : undefined);
    if (!name) continue;
    fns.push({ name, platform: "azure-functions", env: "default", path, line: mark.line });
    const params = kids(m.childForFieldName("parameters")).filter((p) => p.type === "parameter");
    const attrs = params.flatMap(csAttributes);
    const firstOf = (...names: string[]) => attrs.find((a) => names.includes(a.name));
    const strs = (a: { args: Node[] }) => a.args.map((x) => stringValue(x));
    const http = firstOf("HttpTrigger");
    if (http) {
      const route = stringValue(http.named.get("Route")) ?? name;
      const methods = strs(http)
        .filter((s): s is string => !!s && /^\w+$/.test(s))
        .map((s) => s.toUpperCase());
      for (const meth of methods.length ? methods : ["ANY"])
        triggers.push({
          fn: name,
          kind: "http",
          value: AZ_ROUTE(route),
          method: meth,
          path,
          line: http.line,
        });
    }
    const timer = firstOf("TimerTrigger");
    const schedule = timer && strs(timer)[0];
    if (timer && schedule)
      triggers.push({ fn: name, kind: "schedule", value: schedule, path, line: timer.line });
    const queue = firstOf("QueueTrigger", "ServiceBusTrigger");
    const q = queue && strs(queue);
    if (queue && q?.[0])
      triggers.push({
        fn: name,
        kind: queue.name === "ServiceBusTrigger" && q[1] ? "topic" : "queue",
        value: q[0],
        path,
        line: queue.line,
      });
    const blob = firstOf("BlobTrigger");
    const container = blob && strs(blob)[0]?.split("/")[0];
    if (blob && container)
      triggers.push({ fn: name, kind: "storage", value: container, path, line: blob.line });
  }
}

// ------------------------------------------------------------------ infrastructure repos

async function* infraFunctions(repo: RepoHandle, ctx: ScanContext): AsyncGenerator<CatalogRecord> {
  for (const mod of await loadTerraform(repo, ctx, /\bgoogle_cloudfunctions2?_function\b/)) {
    for (const r of mod.resources) {
      if (
        r.type !== "google_cloudfunctions2_function" &&
        r.type !== "google_cloudfunctions_function"
      )
        continue;
      const name = tfName(mod, r, "name");
      if (!name) continue;
      const comp = componentFor(ctx, [name]);
      const env = envOf({ path: r.file, name }) ?? "default";
      yield component({
        repo,
        ctx,
        id: comp,
        type: "function",
        runtime: "cloud-functions",
        source: "infrastructure",
        path: r.file,
        line: r.block.line,
      });
      yield deployment({
        component: comp,
        env,
        platform: "cloud-functions",
        evidence: [ev(repo, "infrastructure", r.file, r.block.line)],
      });
      const trigger = child(r.block, "event_trigger");
      const topic = trigger ? topicName(mod, attrOf(trigger, "pubsub_topic")) : undefined;
      const kind: Kind = trigger ? (topic ? "topic" : "event") : "http";
      const value =
        topic ?? (trigger ? (tfString(mod, attrOf(trigger, "event_type")) ?? "event") : "/");
      yield endpoint({
        repo,
        component: comp,
        endpointType: "function",
        prefix: `function.${slug(name)}`,
        name: `${kind}-${value}`,
        ...(kind === "http" ? { method: "ANY" } : {}),
        pathOrTopic: `${kind}:${value}`,
        source: "infrastructure",
        path: r.file,
        line: (trigger ?? r.block).line,
      });
      if (topic)
        yield loose(repo, comp, "event-subscribe", topic, r.file, trigger!.line, "infrastructure");
    }
  }
  const set = await loadManifests(repo, ctx, /serving\.knative\.dev/);
  for (const o of set.objects) {
    if (o.kind !== "Service" || !o.apiVersion.startsWith("serving.knative.dev/")) continue;
    const comp = componentFor(ctx, [o.labels.app, o.name]);
    const env = envOf({ namespace: o.namespace, path: o.file, name: o.name }) ?? "default";
    yield component({
      repo,
      ctx,
      id: comp,
      type: "function",
      runtime: "knative",
      source: "infrastructure",
      path: o.file,
      line: o.line(),
    });
    yield deployment({
      component: comp,
      env,
      platform: "knative",
      evidence: [ev(repo, "infrastructure", o.file, o.line())],
    });
    yield endpoint({
      repo,
      component: comp,
      endpointType: "function",
      prefix: `function.${slug(o.name)}`,
      name: "http-/",
      method: "ANY",
      pathOrTopic: "http:/",
      source: "infrastructure",
      path: o.file,
      line: o.line(),
    });
  }
}
