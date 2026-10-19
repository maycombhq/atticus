import type { FrameworkModel } from "@maycombhq/core";
import type { Annotation, Call, JavaFile } from "./lang/java.js";

/**
 * Reading house frameworks through their models (ADR 0054): a house annotation gets the
 * built-in annotations it stands for beside it, so an extractor reads a house controller like
 * a Spring one; a wrapper call is an HTTP call; model constants and service ids fill names.
 */

/** The models whose packages a file imports. */
export function modelsFor(
  file: JavaFile,
  models: readonly FrameworkModel[] = [],
): FrameworkModel[] {
  return models.filter((m) =>
    m.packages.some((p) => file.imports.some((i) => i === p || i.startsWith(`${p}.`))),
  );
}

/** Add, to each declaration, the built-in annotations its house annotations mean. */
export function applyAnnotations(file: JavaFile, models: readonly FrameworkModel[]): void {
  const defs = new Map(
    models.flatMap((m) => m.annotations.map((a) => [a.name, { ...a, model: m.name }] as const)),
  );
  if (defs.size === 0) return;
  for (const d of file.decls) {
    const added: Annotation[] = [];
    for (const a of d.annotations) {
      const def = defs.get(a.name);
      if (!def) continue;
      for (const means of def.means) {
        if (d.annotations.some((x) => x.name === means) || added.some((x) => x.name === means))
          continue;
        const attrs: Annotation["attrs"] = { ...def.fixed };
        const named: NonNullable<Annotation["named"]> = {};
        for (const [k, v] of Object.entries(a.attrs)) {
          const to = def.attributes[k] ?? (k === "value" ? "value" : undefined);
          if (!to) continue;
          attrs[to] = v;
          if (a.named?.[k] !== undefined) named[to] = a.named[k]!;
        }
        added.push({
          name: means,
          attrs,
          ...(Object.keys(named).length > 0 ? { named } : {}),
          from: {
            model: def.model,
            verified: def.source.kind === "code" || def.source.kind === "bytecode",
          },
          line: a.line,
        });
      }
    }
    d.annotations.push(...added);
  }
}

/** Constants and service ids the models give a value, and whether each came from code or bytecode. */
export function modelValues(
  models: readonly FrameworkModel[],
): Map<string, { value: string; verified: boolean }> {
  const out = new Map<string, { value: string; verified: boolean }>();
  for (const m of models)
    for (const [name, v] of [...Object.entries(m.constants), ...Object.entries(m.services)])
      out.set(name, {
        value: v.value,
        verified: v.source.kind === "code" || v.source.kind === "bytecode",
      });
  return out;
}

/** Wrapper calls in a file: each with its HTTP method and URL, as far as they can be read. */
export function wrapperCalls(
  file: JavaFile,
  src: string,
  models: readonly FrameworkModel[],
  fill: (shown: string) => string,
): { call: Call; method: string; url: string }[] {
  const out: { call: Call; method: string; url: string }[] = [];
  const values = modelValues(models);
  for (const m of models)
    for (const c of m.clients) {
      // Fields and variables declared with the wrapper's type are its receivers.
      const receivers = new Set(
        [...src.matchAll(new RegExp(`\\b${c.type}(?:<[^>]*>)?\\s+(\\w+)\\s*[;=,)]`, "g"))].map(
          (x) => x[1]!,
        ),
      );
      for (const call of file.calls) {
        if (call.method !== c.method || !call.receiver || !receivers.has(call.receiver)) continue;
        const part = (p: { arg: number } | { value: string }) =>
          "value" in p ? p.value : (call.args[p.arg] ?? fill(call.shown[p.arg] ?? ""));
        const method = part(c.httpMethod).replace(/^.*\./, "").toUpperCase() || "ANY";
        const path = part(c.path);
        let base = "";
        if (c.service) {
          // The id as written (Services.AUDIT), not filled: it is the key to look up.
          const s = c.service;
          const id = (
            "value" in s ? s.value : (call.args[s.arg] ?? call.shown[s.arg] ?? "")
          ).replace(/^\$\{(.*)\}$/, "$1");
          base = values.get(id)?.value ?? `\${${id}}`;
        }
        const url = base ? `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}` : path;
        if (url) out.push({ call, method, url });
      }
    }
  return out;
}
