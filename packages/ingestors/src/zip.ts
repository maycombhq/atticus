// The safe ZIP reader lives in core (one reader for documents and JARs alike); re-exported here
// so ingestors' callers keep their imports.
export {
  peekZip,
  readZip,
  ZIP_LIMITS,
  ZipError,
  type ZipArchive,
  type ZipLimits,
} from "@maycombhq/core";
