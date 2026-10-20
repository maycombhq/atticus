import type { Extractor } from "@maycombhq/sdk";
import { dotnetExtractor } from "./dotnet.js";
import { goExtractor } from "./go.js";
import { nodeExtractor } from "./node.js";
import { pythonExtractor } from "./python.js";

export { dotnetExtractor, goExtractor, nodeExtractor, pythonExtractor };
export { type ImportDecl, type SourceLang, type SrcTok } from "../lang/source-tree.js";
export { SourceFile, Evaluator, type Arg, type SrcCall } from "./shared.js";

/** The generic-tier backend extractors (.NET, Go, Node, Python), in id order. */
export const BACKEND_EXTRACTORS: readonly Extractor[] = [
  dotnetExtractor,
  goExtractor,
  nodeExtractor,
  pythonExtractor,
];
