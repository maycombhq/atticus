import type { AnnotationSurvey, RepoSurvey, SurveyValue } from "./survey.js";

/**
 * Turn a survey into a starting dialect file: header, appliesTo and layout filled from what
 * every repo shares, empty rules and tests, and one commented candidate rule per house
 * annotation. It is deliberately not valid C2 yet (no rules, no tests): a scaffold that
 * passed would invite shipping it unfinished.
 */

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** ForgeEndpoint → forge-endpoint. */
export function kebab(name: string): string {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
}

const values = (vs: SurveyValue[]) =>
  vs
    .slice(0, 3)
    .map((v) => `${v.value} (${v.repo})`)
    .join("; ") + (vs.length > 3 ? `; and ${vs.length - 3} more` : "");

/** House annotations other house annotations sit inside: hints, not rules of their own. */
function containers(anns: AnnotationSurvey[]): Set<string> {
  return new Set(anns.filter((a) => !a.known).flatMap((a) => a.enclosing));
}

/** House annotations that get a candidate rule. */
export function candidateAnnotations(survey: RepoSurvey): AnnotationSurvey[] {
  const inside = containers(survey.annotations);
  return survey.annotations.filter((a) => !a.known && !inside.has(a.name));
}

function candidate(a: AnnotationSurvey, survey: RepoSurvey): string[] {
  const target = a.targets.length === 1 ? a.targets[0]! : "any";
  const what = target === "any" ? "anything" : `a ${target}`;
  const files =
    survey.sourceRoots.length > 0 ? survey.sourceRoots.map((s) => `${s}/**/*.java`) : ["**/*.java"];
  const name = survey.descriptor?.nameKey
    ? `\${yaml:${survey.descriptor.file}#${survey.descriptor.nameKey}}.TODO`
    : "TODO";
  const example =
    a.attributes.length > 0
      ? `\${attr.${a.attributes[0]}}`
      : target === "class"
        ? "${class.name}"
        : "${member.name}";
  const hints = [
    ...(a.attributes.length > 0 ? [`attributes: ${a.attributes.join(", ")}`] : []),
    ...a.enclosing.map((e) => `enclosing type: \${annotation.${e}.<attribute>}`),
  ];
  return [
    `- id: ${kebab(a.name)}`,
    `  description: TODO what ${what} annotated @${a.name} means.`,
    `  match:`,
    `    annotation: ${a.name}`,
    `    target: ${target}`,
    `    files: [${files.map((f) => `"${f}"`).join(", ")}]`,
    `  emit:`,
    `    kind: TODO # a record kind from kit/c1-kinds.md`,
    `    id: "${name}" # leave id out for an Interface`,
    `    fields:`,
    `      TODO: "${example}"${hints.length > 0 ? ` # ${hints.join("; ")}` : ""}`,
    `  confidence: inferred # verified when this code alone proves the record`,
  ];
}

/** The scaffold file's text for a dialect name and a survey. Deterministic. */
export function scaffoldDialect(name: string, survey: RepoSurvey): string {
  const n = survey.repos.length;
  const L: string[] = [
    `# Dialect ${name}, scaffolded by \`atticus dialect new\` from ${plural(n, "repo")}: ${survey.repos.join(", ")}.`,
    `# A starting point, not a working dialect: it has no rules and no tests yet.`,
    `#   1. Read kit/README.md and kit/c2-reference.md.`,
    `#   2. Turn the candidate rules under \`rules:\` into real rules, finishing every TODO.`,
    `#   3. Write tests, then run \`atticus dialect test ${name}\` until it passes.`,
    `#      \`atticus dialect run ${name} <repo>\` prints what the rules produce.`,
    `schemaVersion: 1`,
    `name: ${name}`,
    `version: 0.1.0`,
    `description: TODO say which framework this dialect teaches the scanner.`,
    `extends: []`,
    `appliesTo:`,
    `  repoTypes: []`,
  ];
  if (survey.marker) L.push(`  marker: ${survey.marker} # in ${n} of ${n} repos`);
  else {
    const seen = survey.markerCandidates
      .slice(0, 3)
      .map((c) => `${c.path} is in ${c.repos} of ${n}`)
      .join(", ");
    L.push(`  # marker: TODO no file is in every repo${seen ? ` (${seen})` : ""}`);
  }
  L.push(
    `layout:`,
    `  sourceRoots: [${survey.sourceRoots.join(", ")}]`,
    `  configFiles: [${survey.configFiles.join(", ")}]`,
    `rules:`,
  );
  const cands = candidateAnnotations(survey);
  if (cands.length > 0) {
    L.push(
      `  # Candidate rules, one per framework annotation. Uncomment one, finish its TODOs,`,
      `  # and delete the [] below once the list has a rule. Delete candidates you don't need.`,
    );
    for (const a of cands) {
      L.push(`  #`);
      for (const line of candidate(a, survey)) L.push(`  # ${line}`);
    }
  } else {
    L.push(
      `  # No framework annotations found. Write rules from the descriptor or config instead:`,
      `  # kit/c2-reference.md lists every kind of match. Delete the [] below once you have one.`,
    );
  }
  L.push(
    `  []`,
    `tests: []`,
    ``,
    `# ------------------------------------------------------------------ survey`,
  );

  const sections: string[][] = [];
  if (survey.descriptor) {
    const d = survey.descriptor;
    sections.push([
      `# Descriptor ${d.file} (read a key with \${yaml:${d.file}#<key>}):`,
      ...d.keys.map((k) => `#   ${k.key}: ${values(k.values)}`),
    ]);
  }
  const house = survey.annotations.filter((a) => !a.known);
  const known = survey.annotations.filter((a) => a.known);
  if (survey.annotations.length > 0) {
    const where = survey.sourceRoots.length > 0 ? survey.sourceRoots.join(", ") : "Java files";
    const s = [`# Annotations in ${where}:`];
    for (const a of house) {
      const parts = [
        `@${a.name} on ${a.targets.join(", ")}: ${a.count} in ${plural(a.repos.length, "repo")}`,
        ...(a.attributes.length > 0 ? [`attributes: ${a.attributes.join(", ")}`] : []),
        ...(a.enclosing.length > 0 ? [`inside ${a.enclosing.map((e) => `@${e}`).join(", ")}`] : []),
      ];
      s.push(`#   ${parts.join("; ")}`);
      s.push(`#     ${a.sample.repo}/${a.sample.path}:${a.sample.line}  ${a.sample.text}`);
    }
    if (known.length > 0)
      s.push(
        `#   Also seen (well-known, not part of a house framework): ${known.map((a) => `@${a.name} (${a.count})`).join(", ")}`,
      );
    sections.push(s);
  }
  if (survey.configKeys.length > 0) {
    const max = 40;
    sections.push([
      `# Config keys in ${survey.configFiles.join(", ")} (read one with \${config:<key>}):`,
      ...survey.configKeys.slice(0, max).map((k) => `#   ${k.key}: ${values(k.values)}`),
      ...(survey.configKeys.length > max
        ? [`#   ... and ${survey.configKeys.length - max} more`]
        : []),
    ]);
  }
  sections.forEach((s, i) => {
    if (i > 0) L.push(`#`);
    L.push(...s);
  });
  return L.join("\n") + "\n";
}
