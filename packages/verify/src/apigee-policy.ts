/**
 * What kind of Apigee policy a citation attaches (ADR 0124 addendum A-gateway2).
 *
 * An entry's `authCite` names the policy attached on the cited line (`<Step><Name>`). The line
 * check proves the name is written there; it says nothing about what the policy does, so a
 * reader could claim `oauth2` on a line that attaches a `VerifyAPIKey`. In an Apigee bundle the
 * policy's own file says which it is: its root element. So the verifier reads that file and
 * refuses an auth the element cannot produce.
 *
 * Files only, and only inside the bundle the citation is in. A policy whose element this module
 * doesn't know is not judged: a custom or newer policy must not be called a lie.
 */

/** The auth schemes each Apigee policy element can produce. */
const MAKES: Record<string, readonly string[]> = {
  OAuthV1: ["oauth2"],
  OAuthV2: ["oauth2"],
  VerifyAccessToken: ["oauth2"],
  VerifyJWT: ["oauth2"],
  VerifyAPIKey: ["api-key"],
  BasicAuthentication: ["basic"],
};

/** What each of those checks, in the words a rejection uses. */
const CHECKS: Record<string, string> = {
  oauth2: "an OAuth token",
  "api-key": "an API key",
  basic: "a user name and password",
};

/** Policy elements that authenticate nobody: an `authCite` naming one claims an auth it can't set. */
const MAKES_NONE = new Set([
  "AccessControl",
  "AccessEntity",
  "AssignMessage",
  "ConcurrentRateLimit",
  "ExtractVariables",
  "GenerateJWT",
  "InvalidateCache",
  "JSONThreatProtection",
  "JSONToXML",
  "KeyValueMapOperations",
  "LookupCache",
  "MessageLogging",
  "PopulateCache",
  "Quota",
  "RaiseFault",
  "RegularExpressionProtection",
  "ResponseCache",
  "SpikeArrest",
  "StatisticsCollector",
  "XMLThreatProtection",
  "XMLToJSON",
  "XSL",
]);

/** The bundle a file sits in: everything up to and including its `apiproxy/` or `sharedflowbundle/`. */
export function bundleRootOf(file: string): string | undefined {
  const m = /^(.*(?:^|\/)(?:apiproxy|sharedflowbundle))\//.exec(file.replace(/\\/g, "/"));
  return m?.[1];
}

/** The root element of the named policy of the bundle the cited file is in, when it is there. */
export function policyElement(
  file: string,
  policy: string,
  lines: (path: string) => readonly string[] | undefined,
): { path: string; element: string } | undefined {
  const root = bundleRootOf(file);
  if (!root || !/^[A-Za-z0-9][\w.-]*$/.test(policy)) return undefined;
  const path = `${root}/policies/${policy}.xml`;
  const ls = lines(path);
  if (!ls) return undefined;
  for (const l of ls) {
    const m = /^\s*<([A-Za-z][\w.-]*)[\s/>]/.exec(l);
    if (m) return { path, element: m[1]! };
  }
  return undefined;
}

/**
 * Why the cited policy can't set the claimed auth, or undefined when it can, when the policy
 * isn't in the bundle, or when its element is one this module doesn't know.
 */
export function authPolicyMismatch(
  auth: string,
  file: string,
  policy: string,
  lines: (path: string) => readonly string[] | undefined,
): { path: string; element: string; makes?: readonly string[] } | undefined {
  const found = policyElement(file, policy, lines);
  if (!found) return undefined;
  const makes = MAKES[found.element];
  if (makes) return makes.includes(auth) ? undefined : { ...found, makes };
  return MAKES_NONE.has(found.element) ? found : undefined;
}

/** "an OAuth token", "an API key" …; the scheme's own name when there is no plainer phrase. */
export const authChecks = (auth: string) => CHECKS[auth] ?? auth;

/** A path with the trailing slashes dropped (`/forge/v1/` and `/` read as `/forge/v1` and ``). */
const bare = (p: string) => p.trim().replace(/\/+$/, "");

/**
 * Whether a pass-through path is written on the cited Apigee line (review round 49). A proxy with
 * no conditional flow passes everything under its base path to its target, so the map prompt asks
 * for one `ANY` entry at `<BasePath>/**`, cited on the `<BasePath>` line, and a forwarding call
 * whose path is what the target receives: `/**` (or `/`) after the target's own path, cited on
 * the target's `<URL>` or `<Path>` line or the proxy's `<RouteRule>` line. Neither `/**` is
 * written on those lines, so the route check can't find it; this reads the element instead.
 * Only inside a bundle (`apiproxy/`), and the entry and the call each only on their own lines.
 */
export function apigeePassThrough(
  o: { kind: "entry" | "call"; forwards: boolean },
  file: string,
  lines: readonly string[],
  line: number,
  path: string,
): boolean {
  if (!bundleRootOf(file)) return false;
  const p = path.trim();
  const under = p.endsWith("/**") ? bare(p.slice(0, -3)) : undefined;
  const near = lines.slice(Math.max(0, line - 2), line + 1);
  const element = (tag: string) =>
    near.flatMap((l) => {
      const m = new RegExp(`<${tag}>\\s*([^<]*?)\\s*</${tag}>`).exec(l);
      return m ? [m[1]!] : [];
    });
  if (o.kind === "entry")
    return under !== undefined && element("BasePath").some((b) => bare(b) === under);
  if (!o.forwards) return false;
  // what the target receives: everything (`/**`), or the target's path itself (`/`)
  const target = under ?? bare(p);
  const urlPath = (u: string) => bare(u.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, ""));
  return (
    element("URL").some((u) => urlPath(u) === target) ||
    element("Path").some((t) => bare(t) === target) ||
    (target === "" && near.some((l) => /<RouteRule[\s>]/.test(l)))
  );
}
