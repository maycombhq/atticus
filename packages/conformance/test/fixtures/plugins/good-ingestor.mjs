// A conforming ingestor: reads a CSV of systems and owners into System records.
/* global TextDecoder */
export const systemsCsv = {
  id: "systems-csv",
  version: "1.0.0",
  sniff(fileName) {
    return fileName.endsWith(".csv") ? 1 : 0;
  },
  async *ingest(fileName, content) {
    const lines = new TextDecoder().decode(content).trim().split("\n").slice(1);
    for (const [i, line] of lines.entries()) {
      const [id, owner] = line.split(",");
      yield {
        schemaVersion: 2,
        kind: "System",
        id,
        status: "current",
        confidence: "inferred",
        name: id,
        boundary: "internal",
        owner,
        evidence: [{ source: "export", path: fileName, line: i + 2 }],
      };
    }
  },
};
