/**
 * Files coverage and the estimate don't count by default, beyond tests and build wrappers (ADR
 * 0124 addendum A-big, from a first read of a large monorepo): translation bundles, and JSON or
 * XML files so big they are data, not code. Conservative: config, build, API and migration files
 * count whatever their size, and code in a locale folder counts. Folders of data, docs or
 * vendored code are left to the estimate's proposals (read-plan.ts), which a person accepts.
 */

/** A translation bundle: JSON, YAML or properties under a locale folder, or Android's strings. */
const LOCALE_BUNDLE =
  /(^|\/)(i18n|l10n|locales?|lang|langs|languages|translations?)\/(.+\/)?[^/]+\.(json|ya?ml|properties)$|(^|\/)res\/values[^/]*\/(strings|plurals|arrays)\.xml$/i;

export function isLocaleBundle(path: string): boolean {
  return LOCALE_BUNDLE.test(path);
}

/**
 * A JSON or XML file over either threshold is data, not code. 2,000 lines is well past any
 * hand-written config that isn't a build file (kept below); 200 KB catches minified data on a
 * line or a few. YAML isn't sized: a big one is usually a manifest or an API spec.
 */
export const DATA_FILE_LINES = 2_000;
export const DATA_FILE_CHARS = 200_000;

const DATA_EXT = /\.(json|xml)$/i;
/** Build, config, API and migration files, and MyBatis mappers: code whatever their size. */
const KEEP_BIG =
  /(^|\/)(pom\.xml|package\.json|composer\.json|angular\.json|project\.json|nx\.json|lerna\.json|workspace\.json|tsconfig[^/]*\.json|jsconfig\.json|appsettings[^/]*\.json|launchSettings\.json|[^/]*(openapi|swagger|asyncapi|api-docs)[^/]*\.(json|xml)|[^/]*mapper[^/]*\.xml)$|(^|\/)(config|configuration|migrations?|db|database|changelogs?|liquibase|flyway)\//i;

/** Whether a file is a big data file, from its lines (as read, without line breaks). */
export function isDataFile(path: string, lines: readonly string[]): boolean {
  if (!DATA_EXT.test(path) || KEEP_BIG.test(path)) return false;
  // a split that kept the last line break ends in "", which isn't a line
  if (lines.length - (lines[lines.length - 1] === "" ? 1 : 0) > DATA_FILE_LINES) return true;
  let chars = 0;
  for (const l of lines) if ((chars += l.length + 1) > DATA_FILE_CHARS) return true;
  return false;
}
