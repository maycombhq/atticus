// node fixtures/messy/jars/build.mjs: rebuild tide-web-starter-3.2.0.jar from the starter's
// source in ../repos/tide-platform, as a Maven build would ship it (classes compiled with
// -parameters, as Spring Boot builds are, plus META-INF/maven/.../pom.properties). Spring's own
// annotation types come from the stand-ins in stubs/, which are not packed. Needs a JDK 17+.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const work = mkdtempSync(join(tmpdir(), "atticus-jar-"));
const sources = (dir) =>
  readdirSync(dir).flatMap((e) => {
    const f = join(dir, e);
    return statSync(f).isDirectory() ? sources(f) : f.endsWith(".java") ? [f] : [];
  });
const javac = (args) => execFileSync("javac", args, { stdio: "inherit" });

javac(["-d", join(work, "stubs"), ...sources(join(here, "stubs"))]);
const classes = join(work, "classes");
javac([
  "-parameters",
  "-g",
  "--release",
  "17",
  "-cp",
  join(work, "stubs"),
  "-d",
  classes,
  ...sources(join(here, "../repos/tide-platform/src/main/java")),
]);
const maven = join(classes, "META-INF/maven/tide.platform/tide-web-starter");
mkdirSync(maven, { recursive: true });
writeFileSync(
  join(maven, "pom.properties"),
  "groupId=tide.platform\nartifactId=tide-web-starter\nversion=3.2.0\n",
);
execFileSync(
  "jar",
  [
    "--create",
    "--file",
    join(here, "tide-web-starter-3.2.0.jar"),
    "--date",
    "2026-01-01T00:00:00Z",
    "--no-manifest",
    "-C",
    classes,
    ".",
  ],
  { stdio: "inherit" },
);
console.log("Wrote fixtures/messy/jars/tide-web-starter-3.2.0.jar");
