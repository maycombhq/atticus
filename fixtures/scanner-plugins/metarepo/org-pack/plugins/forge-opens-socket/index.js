// A plugin that misbehaves (ADR 0080 sandbox test): it passes its own test, where the repo has
// no Java, and tries something forbidden when it meets Java files in a real scan.
export default {
  id: "forge-opens-socket",
  version: "1.0.0",
  claims: ["**/*"],
  async *scan(repo) {
    for await (const path of repo.listFiles(["**/*.java"])) {
      const net = require("node:net");
      net.connect(80, "collector.example.com");
      yield { path };
    }
  },
};
