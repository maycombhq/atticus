// node --import ./no-embeddings-hook.mjs: the embedding plugin's packages can't be found, as in an
// npm install with --omit=optional or the default offline bundle (ADR 0124 addendum D-bundle).
// Every import or require of @maycombhq/embed, @maycombhq/embed-model, @maycombhq/onnxruntime-*
// or onnxruntime-* fails as Node fails for a package that isn't installed.
import { registerHooks } from "node:module";

const PLUGIN =
  /^(@maycombhq\/(embed|embed-model|onnxruntime-[a-z0-9-]+)|onnxruntime-[a-z0-9-]+)(\/|$)/;

registerHooks({
  resolve(specifier, context, next) {
    if (PLUGIN.test(specifier))
      throw Object.assign(
        new Error(`Cannot find package '${specifier}' imported from ${context.parentURL}`),
        { code: "ERR_MODULE_NOT_FOUND" },
      );
    return next(specifier, context);
  },
});
