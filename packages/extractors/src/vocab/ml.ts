import { normalizePath, type CatalogRecord } from "@maycombhq/core";
import { defineExtractor } from "@maycombhq/sdk";
import { attrOf } from "../platform/hcl.js";
import { loadManifests, readYamlDocs } from "../platform/manifests.js";
import { loadTerraform, tfString } from "../platform/terraform.js";
import { at, componentFor, deployment, envOf, str } from "../platform/util.js";
import {
  component,
  endpoint,
  ev,
  lineAt,
  loose,
  own,
  read,
  slug,
  sources,
  stripComments,
} from "./common.js";

/**
 * Machine-learning models and feature stores (ADR 0040).
 *
 * - MLflow `MLproject`: the repo's component is an `ml-model` (runtime mlflow).
 * - Model serving: KServe `InferenceService` manifests and SageMaker endpoints in Terraform
 *   (`aws_sagemaker_endpoint`) are `ml-model` components by name (runtime and Deployment
 *   platform kserve or sagemaker), each with its inference route as a REST Endpoint: KServe
 *   `POST /v1/models/<name>:predict` (or `POST /v2/models/<name>/infer` for protocol v2),
 *   SageMaker `POST /endpoints/<name>/invocations`.
 * - Feast: `feature_store.yaml` is a `feature-store` DataStore `<project>-feature-store` owned by
 *   the repo's component; each `FeatureView(name="x")` is a Table of it; features read with
 *   `get_online_features`/`get_historical_features` (`"view:feature"` strings) are db-access
 *   read loose ends of the reading component.
 */

const MLPROJECT = ["**/MLproject"];
const MANIFESTS = ["**/*.yaml", "**/*.yml"];
const FEAST = ["**/feature_store.yaml"];
const PY = ["**/*.py"];

export const mlExtractor = defineExtractor({
  id: "ml",
  version: "0.1.0",
  claims: [...MLPROJECT, ...MANIFESTS, ...PY, "**/*.tf"],
  async *scan(repo, ctx) {
    const self = own(repo, ctx);
    const components = new Map<string, CatalogRecord>();
    const addComponent = (
      id: string,
      runtime: string,
      source: "config" | "infrastructure",
      path: string,
      line?: number,
    ) => {
      const cur = components.get(id);
      if (cur) {
        (cur as unknown as Record<string, unknown>).runtime = runtime; // serving says where it runs
        cur.evidence.push(ev(repo, source, path, line));
      } else
        components.set(
          id,
          component({
            repo,
            ctx,
            id,
            type: "ml-model",
            runtime,
            source,
            path,
            ...(line ? { line } : {}),
          }),
        );
    };
    const rest: CatalogRecord[] = [];

    for (const path of await sources(repo, MLPROJECT)) {
      const text = await read(repo, ctx, path);
      if (text !== undefined && /^name\s*:/m.test(text))
        addComponent(self, "mlflow", "config", path, lineAt(text, text.search(/^name\s*:/m)));
    }

    const set = await loadManifests(repo, ctx, /InferenceService/, MANIFESTS);
    for (const o of set.objects) {
      if (o.kind !== "InferenceService" || !o.apiVersion.startsWith("serving.kserve.io/")) continue;
      const comp = componentFor(ctx, [o.labels.app, o.name]);
      const env = envOf({ namespace: o.namespace, path: o.file, name: o.name }) ?? "default";
      addComponent(comp, "kserve", "infrastructure", o.file, o.line());
      rest.push(
        deployment({
          component: comp,
          env,
          platform: "kserve",
          evidence: [ev(repo, "infrastructure", o.file, o.line())],
        }),
      );
      const v2 = str(at(o.obj, "spec", "predictor", "model", "protocolVersion")) === "v2";
      const path = v2 ? `/v2/models/${o.name}/infer` : `/v1/models/${o.name}:predict`;
      rest.push(
        endpoint({
          repo,
          component: comp,
          endpointType: "rest",
          prefix: "inference",
          name: v2 ? "infer" : "predict",
          method: "POST",
          pathOrTopic: path,
          normalizedPath: normalizePath(path),
          source: "infrastructure",
          path: o.file,
          line: o.line(),
        }),
      );
    }

    for (const mod of await loadTerraform(repo, ctx, /\baws_sagemaker_endpoint\b/)) {
      for (const r of mod.resources) {
        if (r.type !== "aws_sagemaker_endpoint") continue;
        const name = tfString(mod, attrOf(r.block, "name")) ?? r.name;
        const comp = componentFor(ctx, [name]);
        addComponent(comp, "sagemaker", "infrastructure", r.file, r.block.line);
        const env = envOf({ path: r.file, name }) ?? "default";
        rest.push(
          deployment({
            component: comp,
            env,
            platform: "sagemaker",
            evidence: [ev(repo, "infrastructure", r.file, r.block.line)],
          }),
        );
        const path = `/endpoints/${name}/invocations`;
        rest.push(
          endpoint({
            repo,
            component: comp,
            endpointType: "rest",
            prefix: "inference",
            name: "invocations",
            method: "POST",
            pathOrTopic: path,
            normalizedPath: normalizePath(path),
            source: "infrastructure",
            path: r.file,
            line: r.block.line,
          }),
        );
      }
    }

    // Feast
    let store: string | undefined;
    for (const path of await sources(repo, FEAST)) {
      const text = await read(repo, ctx, path);
      const doc = text !== undefined ? readYamlDocs(text)?.[0] : undefined;
      const project = str(at(doc?.value, "project"));
      if (!doc || !project) continue;
      store = `${slug(project)}-feature-store`;
      rest.push({
        schemaVersion: 2,
        kind: "DataStore",
        id: store,
        status: "current",
        confidence: "verified",
        storeType: "feature-store",
        ownerComponent: self,
        entitiesHeld: [],
        evidence: [ev(repo, "config", path, doc.line(["project"]))],
      } as unknown as CatalogRecord);
    }
    for (const path of await sources(repo, PY)) {
      const text = await read(repo, ctx, path);
      if (text === undefined || !/\bfeast\b/.test(text)) continue;
      const clean = stripComments(text, "hash");
      if (store)
        for (const m of clean.matchAll(/\bFeatureView\s*\(\s*name\s*=\s*["']([\w-]+)["']/g))
          rest.push({
            schemaVersion: 2,
            kind: "Table",
            id: `${store}.${slug(m[1]!)}`,
            status: "current",
            confidence: "verified",
            dataStore: store,
            name: m[1]!,
            tableKind: "table",
            ownerComponent: self,
            readers: [],
            writers: [self],
            evidence: [ev(repo, "code", path, lineAt(clean, m.index))],
          } as unknown as CatalogRecord);
      for (const m of clean.matchAll(/\bget_(?:online|historical)_features\s*\(/g)) {
        const args = clean.slice(
          m.index,
          clean.indexOf(")", m.index + m[0].length) + 1 || undefined,
        );
        const views = new Set([...args.matchAll(/["']([\w-]+):[\w-]+["']/g)].map((x) => x[1]!));
        for (const v of views)
          rest.push(loose(repo, self, "db-access", `read ${v}`, path, lineAt(clean, m.index)));
      }
    }

    yield* components.values();
    yield* rest;
  },
});
