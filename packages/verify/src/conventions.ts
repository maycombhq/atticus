import {
  DEFAULT_CONVENTIONS,
  gatewayBundleTest,
  underFolders,
  type ConventionFramework,
  type Conventions,
} from "@maycombhq/core";

/**
 * The org pack's conventions (ADR 0147, `conventions.yaml`) as verify reads with them: the
 * folder lists made into tests once per pack. Every function that takes them defaults to the
 * built-in lists, which are what verify had in its code before.
 */
export interface ReadRules {
  /** An API spec: a name with the word in it, a `.oas.yaml`, or YAML or JSON in a spec folder. */
  apiSpec: RegExp;
  /** A file under a folder coverage doesn't count (tests, mocks, fixtures). */
  notProduct: RegExp;
  /** A file under a folder the skipped-lines note doesn't look in (generated, built, vendored). */
  notRead: RegExp;
  /** A file of a gateway's proxy bundle: its entries are routes, which forward. */
  gatewayBundle: RegExp;
  /** The house's own framework entries, looked at before the built-in table. */
  frameworks: readonly ConventionFramework[];
}

const SPEC_NAME =
  /(^|\/)[^/]*(openapi|swagger|asyncapi|api-docs)[^/]*\.(ya?ml|json|xml)$|\.oas\.(ya?ml|json)$/i;

function rulesOf(c: Conventions): ReadRules {
  const folders = underFolders(c.apiSpecFolders, { tail: "(.+/)?[^/]+\\.(ya?ml|json)$" });
  return {
    apiSpec: new RegExp(`${SPEC_NAME.source}|${folders.source}`, "i"),
    notProduct: underFolders(c.notProductFolders),
    notRead: underFolders(c.notReadFolders),
    gatewayBundle: gatewayBundleTest(c.gatewayBundleFolders),
    frameworks: c.frameworks,
  };
}

export const DEFAULT_READ_RULES: ReadRules = rulesOf(DEFAULT_CONVENTIONS);

const made = new WeakMap<Conventions, ReadRules>();

/** The read rules of a pack's conventions; the built-in ones when there are none. */
export function readRulesOf(c: Conventions | undefined): ReadRules {
  if (!c || c === DEFAULT_CONVENTIONS) return DEFAULT_READ_RULES;
  let r = made.get(c);
  if (!r) made.set(c, (r = rulesOf(c)));
  return r;
}
