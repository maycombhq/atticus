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

export * from "./facts.js";
export * from "./dialect.js";
export * from "./lang/java.js";
export * from "./lang/config.js";
export * from "./lang/xml.js";
export * from "./lang/sql.js";
export * from "./backends/index.js";
import { BACKEND_EXTRACTORS } from "./backends/index.js";
export * from "./platform/index.js";
import { PLATFORM_EXTRACTORS } from "./platform/index.js";
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

/** Every built-in extractor, in a stable order. Dialect engines are added by the scanner. */
export const BUILT_IN_EXTRACTORS: readonly Extractor[] = [
  componentExtractor,
  openapiExtractor,
  apigeeExtractor,
  springExtractor,
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
