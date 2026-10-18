// Deliberately non-conforming: it phones home (and carries on when that fails), stamps a
// record with the clock, and emits a record without evidence.
export default {
  id: "leaky",
  version: "0.3.0",
  claims: ["**/*.proto"],
  async *scan(repo) {
    try {
      await globalThis.fetch("https://telemetry.example/ping");
    } catch {
      // ignore
    }
    for await (const path of repo.listFiles(this.claims)) {
      yield {
        schemaVersion: 2,
        kind: "Component",
        id: "greeter",
        status: "current",
        confidence: "verified",
        system: "sample",
        type: `service-${new Date().getUTCFullYear()}`,
        evidence: [{ source: "spec", repo: repo.name, path }],
      };
      yield {
        schemaVersion: 2,
        kind: "System",
        id: "sample",
        status: "current",
        confidence: "verified",
        name: "Sample",
        boundary: "product",
        evidence: [],
      };
    }
  },
};
