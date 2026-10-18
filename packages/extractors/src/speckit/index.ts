import type { Extractor } from "@maycombhq/sdk";
import { speckitExtractor } from "./extractor.js";

export {
  readSpecKitFeatures,
  speckitExtractor,
  SPECKIT_EXTRACTOR_VERSION,
  type SpecKitFeature,
  type SpecKitTask,
} from "./extractor.js";
export { parseMd, type MdDoc } from "./markdown.js";

/** For the lead to append to BUILT_IN_EXTRACTORS (ADR 0030: it runs in every scan). */
export const SPECKIT_EXTRACTORS: readonly Extractor[] = [speckitExtractor];
