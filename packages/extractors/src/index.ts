import type { Extractor } from "@maycombhq/sdk";
import { apigeeExtractor } from "./apigee.js";
import {
  componentExtractor,
  frontendExtractor,
  infraExtractor,
  migrationsExtractor,
  topicsExtractor,
} from "./more.js";
import { openapiExtractor } from "./openapi.js";
import { springExtractor } from "./spring.js";
import { houseExtractor } from "./house.js";

export * from "./facts.js";
export * from "./dialect.js";
export * from "./lang/java.js";
export * from "./lang/config.js";
export * from "./lang/xml.js";
export * from "./lang/sql.js";
export * from "./lang/syntax.js";
export * from "./lang/java-tree.js";
export * from "./lang/groovy.js";
export * from "./backends/index.js";
import { BACKEND_EXTRACTORS } from "./backends/index.js";
export * from "./platform/index.js";
import { PLATFORM_EXTRACTORS, pipelinesExtractor } from "./platform/index.js";
export * from "./data/index.js";
import { DATA_EXTRACTORS } from "./data/index.js";
export * from "./speckit/index.js";
import { SPECKIT_EXTRACTORS } from "./speckit/index.js";
export * from "./vocab/index.js";
import { VOCAB_EXTRACTORS } from "./vocab/index.js";
export {
  apigeeExtractor,
  componentExtractor,
  frontendExtractor,
  infraExtractor,
  migrationsExtractor,
  openapiExtractor,
  springExtractor,
  topicsExtractor,
};
export { CLIENT_PACKAGES, READ_ANNOTATIONS, settingSlug } from "./spring.js";
export * from "./frameworks.js";
export * from "./learn-framework.js";
export * from "./learn-js-framework.js";
export * from "./modules.js";
export * from "./dependencies.js";
export * from "./framework-tests.js";
export * from "./pipeline-models.js";
export * from "./house-imports.js";
export { houseExtractor };

/**
 * The built-in extractors that read framework models (ADR 0054, 0055, 0062): a model changes
 * what these give and nothing else, so onboarding and the scan compare a repo read with and
 * without a model through these alone (ADR 0066).
 */
export const MODEL_READERS: readonly Extractor[] = [
  springExtractor,
  houseExtractor,
  pipelinesExtractor,
];

/** Every built-in extractor, in a stable order. Dialect engines are added by the scanner. */
export const BUILT_IN_EXTRACTORS: readonly Extractor[] = [
  componentExtractor,
  openapiExtractor,
  apigeeExtractor,
  springExtractor,
  houseExtractor,
  frontendExtractor,
  topicsExtractor,
  migrationsExtractor,
  infraExtractor,
  ...BACKEND_EXTRACTORS,
  ...PLATFORM_EXTRACTORS,
  ...DATA_EXTRACTORS,
  ...SPECKIT_EXTRACTORS,
  ...VOCAB_EXTRACTORS,
];
export * from "./prefix-conventions.js";
