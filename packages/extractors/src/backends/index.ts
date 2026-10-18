import type { Extractor } from "@maycombhq/sdk";
import { dotnetExtractor } from "./dotnet.js";
import { goExtractor } from "./go.js";
import { nodeExtractor } from "./node.js";
import { pythonExtractor } from "./python.js";

export { dotnetExtractor, goExtractor, nodeExtractor, pythonExtractor };
export { lexSource, type SourceLang, type SrcTok } from "../lang/lexer.js";

/** The generic-tier backend extractors (.NET, Go, Node, Python), in id order. */
export const BACKEND_EXTRACTORS: readonly Extractor[] = [
  dotnetExtractor,
  goExtractor,
  nodeExtractor,
  pythonExtractor,
];
