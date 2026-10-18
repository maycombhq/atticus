import type { Extractor } from "@maycombhq/sdk";
import { asyncapiExtractor } from "./asyncapi.js";
import { mainframeExtractor } from "./mainframe.js";
import { observabilityExtractor } from "./observability.js";
import { ormExtractor } from "./orm.js";

export { asyncapiExtractor, mainframeExtractor, observabilityExtractor, ormExtractor };
export { observabilityAssetId } from "./observability.js";
export { springName } from "./orm-jpa.js";
export { listShippedDialects, loadShippedDialects, SHIPPED_DIALECTS_DIR } from "./shipped.js";

/** The extractors of this module, in a stable order, for the lead to add to BUILT_IN_EXTRACTORS. */
export const DATA_EXTRACTORS: readonly Extractor[] = [
  ormExtractor,
  observabilityExtractor,
  asyncapiExtractor,
  mainframeExtractor,
];
