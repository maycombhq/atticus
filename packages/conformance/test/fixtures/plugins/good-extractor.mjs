// A conforming extractor: reads GraphQL schema files only and emits one valid record per file.
export const greetings = {
  id: "greetings",
  version: "1.0.0",
  claims: ["**/*.graphql"],
  async *scan(repo) {
    for await (const path of repo.listFiles(this.claims)) {
      const text = await repo.readText(path);
      if (!/type Query/.test(text)) continue;
      yield {
        schemaVersion: 2,
        kind: "Component",
        id: "greeter",
        status: "current",
        confidence: "verified",
        system: "sample",
        type: "service",
        evidence: [{ source: "spec", repo: repo.name, path }],
      };
    }
  },
};
