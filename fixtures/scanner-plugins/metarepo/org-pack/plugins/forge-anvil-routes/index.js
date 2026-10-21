// Reads the Forge "Anvil" house web framework (invented): a class marked @AnvilService("<base>")
// whose methods are marked @Anvil.Get("/path"), @Anvil.Post("/path") and so on. Each route is
// an HTTP entry point at <base><path>. A rule file can't say this: the base path comes from the
// class annotation, which may be many lines above the method.
const ROUTE = /@Anvil\.(Get|Post|Put|Patch|Delete)\("([^"]*)"\)/;
const SERVICE = /@AnvilService\("([^"]*)"\)/;

function slug(s) {
  return s
    .toLowerCase()
    .replace(/[{}]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export default {
  id: "forge-anvil-routes",
  version: "1.0.0",
  claims: ["**/*.java"],
  async *scan(repo, ctx) {
    for await (const path of repo.listFiles(["**/*.java"])) {
      const lines = (await repo.readText(path)).split("\n");
      let base = "";
      for (let i = 0; i < lines.length; i++) {
        const service = SERVICE.exec(lines[i]);
        if (service) base = service[1].replace(/\/+$/, "");
        const route = ROUTE.exec(lines[i]);
        if (!route) continue;
        const method = route[1].toUpperCase();
        const full = base + route[2];
        const component = ctx.component ?? repo.name;
        yield {
          schemaVersion: 1,
          kind: "Endpoint",
          id: `${component}.${method.toLowerCase()}-${slug(full)}`,
          status: "current",
          confidence: "verified",
          evidence: [{ source: "code", path, line: i + 1 }],
          component,
          endpointType: "rest",
          method,
          pathOrTopic: full,
          normalizedPath: full.replace(/\{[^}]*\}/g, "{}"),
        };
      }
    }
  },
};
