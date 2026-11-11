import { z } from "zod";
import { Auth, FLOW_STEP_KINDS } from "./kinds.js";
import { hasSecretShape } from "../cite.js";

/**
 * The facts file: what the assistant writes when it reads a repo (ADR 0124). One JSON line
 * per fact, in seven kinds plus flows, every one with a citation. It is the assistant's input
 * format, projected into catalog C1 by `projectFacts`; it is not a catalog contract of its own.
 *
 * A fact without a citation is not a fact; it is a question.
 */

const str = () => z.string().min(1);

export const FACT_KINDS = [
  "entry",
  "call",
  "store",
  "field",
  "deploy",
  "config",
  "framework",
  "flow",
  "term",
  "component",
  // ADR 0192: what a component's build publishes, and what it builds on.
  "artifact",
  "dependency",
] as const;
export type FactKind = (typeof FACT_KINDS)[number];

/** A fact's id: any slug the assistant chooses; the projection makes catalog ids from the claim. */
export const FactId = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "fact ids are lowercase slugs: a-z, 0-9, '.', '_' and '-'");

/**
 * Another line that holds part of a claim built in code: a base URL, a class-level or group
 * prefix, a context path, a gateway's route, a proto's package and service, an MVC route
 * template. `value` is the part as written there.
 */
export const CitePart = z.strictObject({
  file: str(),
  line: z.number().int().positive(),
  value: str(),
});

/**
 * The line a call's `auth` or `tls` rests on (ADR 0163), with the other lines it is set from
 * (`with`, as a claim's): the line that builds the client certificate's context the cited line
 * passes. Each part names its own value, as a `cite.with` part does.
 */
export const SecurityCite = CitePart.extend({ with: z.array(CitePart).max(6).optional() });

/**
 * Where a fact rests. `value` is what the verifier looks for on the line (the route, the topic,
 * the table, the field, the host or the key); `quote` is the line's text, or enough of it, as a
 * second anchor. The verifier normalises the quote and never requires it from a binary,
 * notebook or minified file.
 */
export const Cite = z.strictObject({
  file: str(),
  line: z.number().int().positive(),
  value: str(),
  quote: z.string().max(200).optional(),
  /**
   * The other lines a claim is put together from (ADR 0124 addendum A4): every plain part of a
   * path must be written on the cited line or one of these, each part on its own line. A
   * framework fact's version, where the declaring line doesn't write it, is such a part too
   * (addendum A-framework).
   */
  with: z.array(CitePart).max(6).optional(),
});
export type Cite = z.infer<typeof Cite>;

/** Who confirmed the fact: the line check, a sample session, a person, or nobody yet. */
export const FactVerified = z.enum(["line", "sample", "person", "none"]);
/** Who produced it. */
export const FactBy = z.enum(["assistant", "reader", "person"]);
/** declared: the code states it; inferred: the assistant concluded it. */
export const FactConf = z.enum(["declared", "inferred"]);

const common = {
  id: FactId,
  repo: str(),
  commit: z.string().regex(/^[0-9a-f]{7,64}$/),
  /** The module in the repo the fact belongs to; the repo itself when left out. */
  component: z.string().optional(),
  cite: Cite,
  verified: FactVerified.default("none"),
  by: FactBy.default("assistant"),
  conf: FactConf.default("declared"),
};

export const ENTRY_TYPES = [
  "rest",
  "grpc",
  "soap",
  "graphql",
  "event-topic",
  "mq-queue",
  "batch-job",
  "function",
  "webhook",
  "websocket",
  "sse",
  "file-drop",
  "transaction",
  "screen",
] as const;

/**
 * What identifies a consumer a gateway route names (ADR 0124 addendum A-callers): a developer
 * `app` subscribed to the route's API product or admitted by a condition, the API `product` the
 * route belongs to, a `client-id` a condition or an allowlist admits, or a certificate `subject`
 * an mTLS check admits.
 */
export const CALLER_KINDS = ["app", "product", "client-id", "subject"] as const;
export type CallerKind = (typeof CALLER_KINDS)[number];

/** A consumer a route names: the identity as written (`value`), cited on the line that names it. */
export const CallerCite = Cite.extend({ as: z.enum(CALLER_KINDS) });
export type CallerCite = z.infer<typeof CallerCite>;

export const EntryFact = z.strictObject({
  kind: z.literal("entry"),
  ...common,
  entryType: z.enum(ENTRY_TYPES),
  method: z.string().optional(),
  /** The path, topic, queue, schedule, screen route or transaction id. */
  path: str(),
  handler: z.string().optional(),
  auth: Auth.optional(),
  /**
   * The line that sets `auth` (an annotation, a middleware, a policy, a security setting) and
   * what it writes there (ADR 0124 addendum A-read). The verifier checks it as it checks a part;
   * an `auth` without it is left out of the kept fact, so the catalog never says it.
   */
  authCite: CitePart.optional(),
  /**
   * The scopes a caller's token must hold to be let in (ADR 0124 addendum A-gateway2): an
   * Apigee `OAuthV2`'s `<Scope>`, a `VerifyJWT` or `VerifyAccessToken` scope claim check, a
   * scope a `Condition` asserts on the token's claims, or one a shared flow checks; and, for a
   * service's own entry, the scope its annotation or middleware requires, though only a gateway
   * batch's rules ask for scopes (the prompt budget: see the addendum).
   *
   * One citation per scope: `value` is the scope as written, on the line that names it, with
   * the other lines a scope built from parts comes from in `with`, as for any other claim. The
   * verifier checks each like a part, so an invented scope, or one cited on a line that doesn't
   * name it, rejects the entry. A field on the entry, not a fact kind of its own: a scope has no
   * identity apart from the entry that demands it (see the addendum for why).
   */
  scopes: z.array(Cite).max(12).optional(),
  /**
   * The consumers the route lets in, as its own files name them (ADR 0124 addendum A-callers):
   * the API product it belongs to, the developer apps subscribed to that product, a client id or
   * app name a `Condition` or allowlist admits, a certificate subject an mTLS check admits. One
   * citation per consumer, `value` the identity as written, on the line that names it, with the
   * line that ties it to the route (the product's proxy list, the app's product list) in `with`.
   * The verifier checks each like a scope, so an invented consumer rejects the entry. Additive
   * and optional, as `scopes` is; only a gateway batch's rules ask for it.
   */
  callers: z.array(CallerCite).max(24).optional(),
});

export const CALL_TYPES = [
  "rest",
  "grpc",
  "soap",
  "graphql",
  "event-topic",
  "mq-queue",
  "sftp",
  "webhook",
] as const;

/** A call's transport security (ADR 0163). */
export const CALL_TLS = ["mtls", "tls", "none"] as const;
export type CallTls = (typeof CALL_TLS)[number];

export const CallFact = z.strictObject({
  kind: z.literal("call"),
  ...common,
  callType: z.enum(CALL_TYPES),
  method: z.string().optional(),
  path: str(),
  /** The host the call goes to, when the code names one. */
  host: z.string().optional(),
  /** The config key or constant the base URL comes from (ADR 0076). */
  base: z.string().optional(),
  /** The target component or system, when the assistant can name it; else the call stays unresolved. */
  to: z.string().optional(),
  /** The entry this call is made from. */
  from: FactId.optional(),
  sync: z.enum(["sync", "async"]).optional(),
  /**
   * The auth the call presents (ADR 0163): a token it fetches or attaches, a key header, a
   * client certificate it signs in with. Goes with `authCite`, the line that sets it and what it
   * writes there; the verifier checks it there, and rejects an `auth` with no line. The line, or
   * a line in its `with`, must also write the kind of thing claimed (review 5): a token, a key, a
   * password or a client certificate.
   */
  auth: Auth.optional(),
  authCite: SecurityCite.optional(),
  /**
   * The transport security the call uses (ADR 0163): `mtls` (it presents a client
   * certificate), `tls` (an https URL, a TLS setting, no client certificate), `none` (plain).
   * Goes with `tlsCite`, as `auth` goes with `authCite`: `mtls` needs a client certificate, a key
   * store or an SSL bundle written on the line or a line in its `with` (the line that builds the
   * context the cited line passes), `tls` https, SSL or TLS, `none` a plain http URL or a switch
   * set off.
   */
  tls: z.enum(CALL_TLS).optional(),
  tlsCite: SecurityCite.optional(),
});

export const StoreFact = z.strictObject({
  kind: z.literal("store"),
  ...common,
  /** The data store's name or id (a database, a bucket, a cache). */
  store: str(),
  storeType: z.string().optional(),
  /** The table, collection, key pattern, bucket path or queue. */
  name: str(),
  op: z.enum(["read", "write", "delete"]),
  tableKind: z.enum(["table", "view", "collection", "key-pattern"]).optional(),
  /** The entry under which the access happens. */
  under: FactId.optional(),
  columns: z.array(str()).optional(),
});

export const FieldFact = z.strictObject({
  kind: z.literal("field"),
  ...common,
  /** The entry, call or store fact the field belongs to. */
  owner: FactId,
  side: z.enum(["request", "response", "column", "screen", "message"]).optional(),
  name: str(),
  type: z.string().optional(),
  /**
   * A column's: not null. A request, response or message field's: it must be present, kept on
   * the Schema field (ADR 0125). Left out when the code doesn't say.
   */
  required: z.boolean().optional(),
  default: z.string().optional(),
  classification: z.string().optional(),
  /** Another field fact this one maps to (a request field to a column, say). */
  mappedTo: FactId.optional(),
  transform: z.string().optional(),
});

export const DeployFact = z.strictObject({
  kind: z.literal("deploy"),
  ...common,
  env: z.string().optional(),
  /** kubernetes, openshift, cloud-run, lambda, vm, ... */
  platform: str(),
  cloud: z.string().optional(),
  resourceType: z.string().optional(),
  resourceName: z.string().optional(),
  region: z.string().optional(),
  pipeline: z.string().optional(),
  replicas: z.number().int().nonnegative().optional(),
  /**
   * Where the component is reached (ADR 0143): the host an OpenShift Route, an Ingress rule or a
   * Helm value gives it, as served, never a template. Written on the cited line or one of its
   * `cite.with` parts: a templated host (`{{ .Values.route.host }}`) cites the values file's line
   * that sets it there.
   */
  host: z.string().min(1).max(253).optional(),
  /**
   * The path its routes sit under on that host (ADR 0143): a Route's `path`, an Ingress rule's,
   * a gateway proxy's `BasePath`. Plain segments from a leading `/`; written on the cited line or
   * a `cite.with` part, as `host` is.
   */
  basePath: z
    .string()
    .max(200)
    .regex(/^\/[^\s]*$/, "a path after the host, starting with /")
    .optional(),
  /**
   * The component the host and base path reach, when the fact is read in another repo (a deploy
   * or config repo's Route): a component or repo of the estate, which the verifier resolves
   * (ADR 0143). Left out, it is the fact's own component.
   */
  exposes: z.string().min(1).optional(),
});

/**
 * The facts file's shape version (ADR 0143). No line carries it: a file written before has no
 * number, reads as version 1 and parses unchanged, every field added since being optional.
 * 1: the shapes of ADR 0124 and its addenda. 2: a deploy fact's `host`, `basePath` and `exposes`.
 * 3 (ADR 0163): the `term` kind, and a call's `auth`, `authCite`, `tls` and `tlsCite`.
 * 4 (ADR 0180): the `component` kind, what a component is.
 * 5 (ADR 0192): the `artifact` and `dependency` kinds, a component's build coordinates and what
 * it builds on. A version-4 file reads unchanged: both are new kinds, nothing else moved.
 */
export const FACTS_SCHEMA_VERSION = 5 as const;

export const SETTING_KINDS = [
  "timeout",
  "retry",
  "circuit-breaker",
  "rate-limit",
  "pool",
  "cache-ttl",
  "feature-flag",
  "config",
  "schedule",
] as const;

/** Values that are secrets, or look like them, are never facts. */
/** A key whose last part ends in a secret word (`ClientSecret`, `db.password`), not one that only mentions it (`TokenUrl`, `AccessTokenLifetime`). */
const SECRET_KEY =
  /(password|passwd|pwd|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|credentials?)$/i;
const SECRET_SOURCE = /^(env:|vault:|secret:|ref:|\$\{|\{\{)/;
/** A flag or a mode (`withCredentials: true`, `credentials: "include"`) is not a secret. */
const NOT_A_SECRET = /^(true|false|yes|no|on|off|include|omit|same-origin|none|null|\d+)$/i;

/**
 * The names a key gives what it sets (beta.24 review): its last part, split on any character
 * that is no letter, digit, `_` or `-` (`db.password`, `Db__Password`, an XPath's last element
 * `KeyStorePassword`), and each name in brackets, by its own last part (an XPath's
 * `Header[@name='x-api-key']`, `AssignVariable[Name='private.clientSecret']`).
 */
function namesOfKey(key: string): string[] {
  const lastOf = (k: string) =>
    k
      .split(/[^A-Za-z0-9_-]+|__/)
      .filter(Boolean)
      .pop() ?? "";
  const bracketed = [...key.matchAll(/\[[^\]]*?["']([^"']+)["'][^\]]*\]/g)].map((m) => m[1]!);
  const bare = key.replace(/\[[^\]]*\]/g, "").trim();
  return [lastOf(bare), ...bracketed.map(lastOf)].filter(Boolean);
}

/**
 * Whether a key and its value look like a secret: a name the key gives (its last part, a
 * bracketed name) ends in a secret word, and the value is neither a reference to where the
 * secret lives nor a flag or a mode.
 */
export function looksLikeSecret(key: string, value: string | undefined): boolean {
  return (
    value !== undefined &&
    namesOfKey(key).some((n) => SECRET_KEY.test(n)) &&
    !SECRET_SOURCE.test(value) &&
    !NOT_A_SECRET.test(value.trim())
  );
}

/**
 * A literal that reads as a credential, not a name: one run of letters and digits (`-_+/=.~`
 * allowed), six characters or more, with both, that is no file name or URL (`AM-Key.xml`,
 * `config/app.yml`, `prod` and `v1` are names).
 */
const tokenLike = (t: string) =>
  /^[A-Za-z0-9+/=_.~-]{6,}$/.test(t) &&
  /[0-9]/.test(t) &&
  /[A-Za-z]/.test(t) &&
  !/\.[a-z]{2,5}$/i.test(t) &&
  !pathOfNames(t);

/**
 * A path of names (`kv/forge/ledger`, `/run/secrets/db`), not a credential with a `/` in it
 * (beta.25 review: an AWS secret access key, `wJalrXUtnFEMI/K7MDENG/…`): it starts with `/`, or
 * each of its segments is a name as people write one (`NAME_LIKE`, `identifierName`).
 */
const pathOfNames = (t: string) =>
  t.startsWith("/") ||
  (t.includes("/") &&
    t
      .split("/")
      .every(
        (s) => s === "" || NAME_LIKE.some((r) => r.test(s)) || identifierName(s) || fileName(s),
      ));

/** A file's name with its extension (`application.yml`, `Creds.java`). */
const fileName = (t: string) => /^[A-Za-z][\w.-]*\.[A-Za-z]{2,5}$/.test(t);

/**
 * A name as people write them, digits and all (beta.25 review): UPPER_SNAKE (`DB2_PASSWORD`,
 * `OAUTH2_CLIENT_SECRET`) or lower-kebab, snake or dotted (`northwind-oauth2`, `db2-credentials`,
 * `forge-secrets-v2`, `secret1`), each word letters with at most three digits after, or a number.
 */
const NAME_LIKE = [
  /^[A-Z]+[0-9]{0,3}(?:_(?:[A-Z]+[0-9]{0,3}|[0-9]{1,4}))*$/,
  /^[a-z]+[0-9]{0,3}(?:[-_.](?:[a-z]+[0-9]{0,3}|[0-9]{1,4}))*$/,
];

/**
 * A name as code writes one, stricter than `NAME_LIKE` (beta.25 review, second round): one a
 * source under a secret's key may be, where a word with digits (`hunter22`, `changeme123`) is
 * the password itself. UPPER_SNAKE with an underscore or no digit (`DB2_PASSWORD`, `PASSWORD`,
 * not `HUNTER22`), two lower words or more joined by `-`, `_` or `.` (`forge-secrets-v2`,
 * `ledger.db.password`), or camelCase or PascalCase of two words or more (`clientSecretV2`,
 * `Db2Credentials`, not `Password1`).
 */
function identifierName(t: string): boolean {
  return (
    (NAME_LIKE[0]!.test(t) && (t.includes("_") || !/[0-9]/.test(t))) ||
    (NAME_LIKE[1]!.test(t) && t.split(/[-_.]/).filter((w) => /[a-z]/.test(w)).length >= 2) ||
    /^[A-Za-z][a-z]+[0-9]{0,3}(?:[A-Z][a-z]+[0-9]{0,3}|[A-Z][0-9]{1,3})+$/.test(t)
  );
}

/** A default that names no value (`${X:none}`), as a flag or a mode does. */
const NO_DEFAULT = /^(true|false|yes|no|on|off|none|null)$/i;

/**
 * Whether a text's placeholder has a literal default (`${DB_PASSWORD:hunter22}`,
 * `${DB_PASSWORD:-changeme}`, the inner one of `${A:${B:x}}`): under a secret's key, that
 * default is the secret (beta.25 review, second round). An empty default, or one that is
 * itself a placeholder (`${A:${B}}`), is none.
 */
function literalDefault(t: string): boolean {
  for (const m of t.matchAll(/\$\{[^}:$]*:-?([^}$]*)/g)) {
    const d = m[1]!.trim();
    if (d && !NO_DEFAULT.test(d)) return true;
  }
  return false;
}

/** The schemes a source names where a secret lives by (the assistant's rules give these). */
const REFERENCE_SCHEMES = new Set([
  "env",
  "vault",
  "secret",
  "ref",
  "secretkeyref",
  "configmapkeyref",
  "file",
  "kvm",
]);

/**
 * Whether a source refers to where its secret lives rather than holding it: a placeholder with
 * no literal default and nothing beside it (`${DB_PASSWORD}`, `{{ db_password }}`), or a
 * scheme and what it names: one of `REFERENCE_SCHEMES` (`env:X`, `secretKeyRef:name/key`), or
 * any scheme then a path, a resource name or a name (`aws-sm:arn:…`, `ssm:/forge/db`), never a
 * word with digits (`admin:hunter22`).
 */
function isReference(t: string): boolean {
  if (/^(\$\{|\{\{)/.test(t)) {
    if (literalDefault(t)) return false;
    let rest = t;
    for (let was = ""; was !== rest;) {
      was = rest;
      rest = rest.replace(/\$\{[^{}]*\}|\{\{[^{}]*\}\}/g, "");
    }
    return rest.trim() === "";
  }
  const m = /^([A-Za-z][A-Za-z0-9-]*):(.+)$/.exec(t);
  if (!m) return false;
  const rest = m[2]!.trim();
  return (
    REFERENCE_SCHEMES.has(m[1]!.toLowerCase()) ||
    /[/:]/.test(rest) ||
    identifierName(rest) ||
    (/^(\$\{|\{\{)/.test(rest) && isReference(rest))
  );
}

/** Shannon entropy of a text, in bits per character. */
const entropy = (t: string) => {
  const n = new Map<string, number>();
  for (const ch of t) n.set(ch, (n.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of n.values()) h -= (c / t.length) * Math.log2(c / t.length);
  return h;
};

/**
 * Whether a literal is strong enough to be a credential rather than a word: 16 characters or more
 * of two kinds (lower, upper, digit, symbol), 8 or more of three, or 12 or more spread wide (3.5
 * bits a character or more).
 */
const credentialStrength = (t: string) => {
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(t)).length;
  return (
    (t.length >= 16 && kinds >= 2) ||
    (t.length >= 8 && kinds >= 3) ||
    (t.length >= 12 && entropy(t) >= 3.5)
  );
};

/**
 * Whether a literal under a secret's key reads as a credential (`configSecretField`): token-like,
 * no name as people write them (`NAME_LIKE`), and strong enough (`credentialStrength`).
 */
export function credentialLike(t: string): boolean {
  return tokenLike(t) && !NAME_LIKE.some((r) => r.test(t)) && credentialStrength(t);
}

/**
 * Beta.25 review: where a config fact carries its setting's secret, the field that does
 * (`value`, `source` or `cite.with`), or undefined. The verifier refuses such a fact
 * (`secret-value`); the schema keeps only beta.24's value check, as released, so a facts file
 * read before is read the same (ADR 0124 addendum A-gateway-outside-2).
 *
 * A value is one when its key names a secret (`looksLikeSecret`) or it is shaped like one
 * (`hasSecretShape`, a Basic token too). A source or a part is one when it is shaped like a
 * secret whatever the key. Under a key that names a secret, a value, a source or a part with a
 * placeholder whose default is a literal (`${DB_PASSWORD:hunter22}`) is one; a source is one
 * when it is no reference (`isReference`), no name as code writes one (`identifierName`) and no
 * name of the fact's own, however weak (`hunter22`, `Summer2024!`); and a part is one when it
 * is a literal that reads as a credential (`credentialLike`) or a password by its marks
 * (`Summer2024!`; a weak word with digits, `hunter22`, is shaped as a hash or a version is, so
 * a part like it is not refused here, and the verifier's messages never quote it) and is no
 * name of the fact's own:
 * its key or a name in it, its target with or without its extension, its env, or a name its
 * source gives (the part `northwind-oauth2` of `secretKeyRef:northwind-oauth2/client-secret`).
 * A quote is the verifier's to redact, as it always was. The answer never repeats the value.
 */
export function configSecretField(c: {
  key: string;
  value?: string | undefined;
  source?: string | undefined;
  target?: string | undefined;
  env?: string | undefined;
  cite: { with?: readonly { value: string }[] | undefined };
}): "value" | "source" | "cite.with" | undefined {
  // a key that names a secret (`looksLikeSecret` of a value that is none of its exceptions)
  const secretKey = looksLikeSecret(c.key, "x");
  if (
    c.value !== undefined &&
    (looksLikeSecret(c.key, c.value) ||
      hasSecretShape(c.value) ||
      (secretKey && literalDefault(c.value)))
  )
    return "value";
  const target = c.target?.trim();
  const own = new Set(
    [c.key, c.env, target, target?.replace(/\.[^.]*$/, "")]
      .filter((x): x is string => !!x)
      .map((x) => x.trim()),
  );
  const keyText = c.key.toLowerCase();
  const source = c.source?.trim();
  const ownName = (t: string) => own.has(t) || keyText.includes(t.toLowerCase());
  const secret = (v: string, isSource: boolean) => {
    const t = v.trim();
    if (!t) return false;
    if (hasSecretShape(t)) return true;
    if (secretKey && literalDefault(t)) return true;
    // Beta.25 review, second round: under a secret's key a source is a reference or a name;
    // any other literal is the secret, however weak (`hunter22`, `Summer2024!`).
    if (isSource)
      return (
        secretKey &&
        !isReference(t) &&
        !identifierName(t) &&
        // the file it is read from (`config/app.yml`, `src/Creds.java`)
        !pathOfNames(t) &&
        !fileName(t) &&
        !NOT_A_SECRET.test(t) &&
        !ownName(t) &&
        // where it lives said in words (`the Kubernetes Secret forge-db`)
        t.split(/\s+/).filter((w) => /^[A-Za-z]{2,}$/.test(w)).length < 2
      );
    return (
      looksLikeSecret(c.key, t) &&
      // a credential, or a password by its marks (`Summer2024!`): no name, version or hash has one
      (credentialLike(t) ||
        (/^\S+$/.test(t) && /[A-Za-z]/.test(t) && /[0-9]/.test(t) && /[!#%^&*?]/.test(t))) &&
      !ownName(t) &&
      (!source || !source.includes(t))
    );
  };
  if (source !== undefined && secret(source, true)) return "source";
  if ((c.cite.with ?? []).some((w) => typeof w?.value === "string" && secret(w.value, false)))
    return "cite.with";
  return undefined;
}

export const ConfigFact = z
  .strictObject({
    kind: z.literal("config"),
    ...common,
    settingKind: z.enum(SETTING_KINDS).default("config"),
    key: str(),
    /** The literal value, when it is not a secret. */
    value: z.string().optional(),
    /** Where the value comes from instead (env:NAME, vault:path, a placeholder). */
    source: z.string().optional(),
    /** The component or system the setting is about (a client's timeout names its target). */
    target: z.string().optional(),
    /** The environment the value is for (`prod`, `Local`), when the file is one environment's (A4). */
    env: z.string().optional(),
  })
  .superRefine((c, ctx) => {
    if (looksLikeSecret(c.key, c.value)) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: `"${c.key}" looks like a secret: give its source (env:NAME, vault:path), never its value`,
      });
    } else if (c.value !== undefined && hasSecretShape(c.value, { basic: false })) {
      // Beta.24 review: a value shaped like a secret (an access key id, a URL's password, a
      // bearer token) is refused whatever its key, and the message never repeats it.
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: `"${c.key}" has a value shaped like a secret: give its source (env:NAME, vault:path), never its value`,
      });
    }
    // Beta.25 review: a source's, a part's and a Basic token's checks (`configSecretField`) are
    // the verifier's (`secret-value`), never the schema's: refusing them here would read a
    // verified beta.24 facts file as not read, a contract change without a version.
  });

/**
 * What a repo or one of its modules is built on (ADR 0124 addendum A-framework): a framework the
 * build file declares, cited on the line that declares it. A kind of its own, not a field on
 * another kind: its subject is the repo or the module (`repo` and `component`, which `common`
 * already carries), no other fact owns it, and it is read first and on its own — the rules a
 * batch's prompt carries are chosen from it before any entry is read. See the addendum for the
 * decision.
 *
 * Nothing is projected into catalog C1 from it: there is no field there to hold it, and a C1
 * field would be a schema bump with a migration. The views read the facts (`map.md`, the Map's
 * repo page, the Trust tab) as the gateway join's hops do.
 */
export const FrameworkFact = z.strictObject({
  kind: z.literal("framework"),
  ...common,
  /**
   * The framework's name as Atticus knows it (`spring-boot`, `asp.net`, `express`, `angular`,
   * `react`, `quarkus`, `django`, `rails`), or, for a house starter or platform library Atticus
   * doesn't know, the artifact or package as the build file declares it. The verifier checks the
   * name against the declaration on the cited line, so a name no declaration gives is rejected.
   */
  name: str(),
  /**
   * The version as declared, when the build file says. Left out when it doesn't (a BOM, a parent
   * pom or a lock file manages it and no line here names a version).
   *
   * Where the version is not written on the cited line — a `<properties>` entry, a parent pom's
   * `<version>`, a `<TargetFramework>`, a dependency-management block — that line goes in
   * `cite.with`, as any other part of a claim built across lines does (ADR 0124 addendum A4),
   * and the verifier checks it there. No field of its own: the version is part of this claim,
   * not a claim about something else, and `cite.with` is already the place a claim's other
   * lines go.
   */
  version: z.string().optional(),
});

/**
 * What a term the organisation uses says about the repo that writes it (ADR 0163): `owner`, the
 * value names this repo's own system (an owner block, an `appId` of its own); `consumer`, it names
 * a system let in or served (an entry of a `consumers` list); `none`, it names neither (a
 * cost centre, a support group); `unknown`, nothing says yet, which becomes a question.
 */
export const TERM_ROLES = ["owner", "consumer", "none", "unknown"] as const;
export type TermRole = (typeof TERM_ROLES)[number];

/**
 * A term of the organisation's, as a repo writes it (ADR 0163): an identifier such as an
 * application id in an access list, a CMDB id, a cost centre. Atticus knows no term itself: what
 * one means comes from the notes the organisation writes on a repo type (or org-wide), in its own
 * words, which the reader is handed; with no note, the reader records the identifiers it meets
 * with `role: unknown`, and they are asked about once per term and repo type.
 *
 * `cite` is the value's line (the verifier looks for `value` there). `meaning` is the line that
 * gives it its role (the `"consumers": [` line, an owner block's key), in the same file, at or
 * above the value's line; an owner or consumer needs one. A kind of its own: its subject is an
 * identifier no other kind holds, and the joins read it across repos.
 */
export const TermFact = z
  .strictObject({
    kind: z.literal("term"),
    ...common,
    /** The term as the organisation names it (`cmdb`, `cost-centre`, `appId`): any word. */
    term: z.string().min(1).max(80),
    /** The value as written on the cited line (`APP000123`). */
    value: z.string().min(1).max(200),
    role: z.enum(TERM_ROLES),
    /**
     * The note the role rests on: its key as the prompt lists it (`note 3f9a2c1b`, a short hash
     * of the note's words, so a reorder of the notes changes nothing), or at least four of its
     * words quoted. Left out when no note says (a role read from the file's own words, or
     * unknown). A key no note given has now (the note was changed or removed) is flagged at
     * verify and the term read again.
     */
    note: z.string().min(1).max(300).optional(),
    /** The line that gives the value its role, and what it writes there. */
    meaning: CitePart.optional(),
  })
  .superRefine((t, ctx) => {
    if (looksLikeSecret(t.term, t.value))
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: `"${t.term}" looks like a secret: a secret is never a term`,
      });
    if ((t.role === "owner" || t.role === "consumer") && !t.meaning)
      ctx.addIssue({
        code: "custom",
        path: ["meaning"],
        message: `a term with role ${t.role} cites the line that gives it that meaning in meaning`,
      });
  });

export const FlowFactStep = z.strictObject({
  kind: z.enum(FLOW_STEP_KINDS),
  what: str(),
  /** The entry, call, store or field fact the step touches. */
  ref: FactId.optional(),
  cite: Cite,
});

export const FlowFactError = z.strictObject({
  when: str(),
  then: str(),
  cite: Cite,
});

export const FlowFact = z.strictObject({
  kind: z.literal("flow"),
  ...common,
  name: str(),
  /** The entry fact that starts the flow. */
  entry: FactId,
  steps: z.array(FlowFactStep).min(1),
  outcome: z.string().optional(),
  errors: z.array(FlowFactError).default([]),
});

/**
 * What a component is (ADR 0180): its type, from the organisation's component types (the set
 * `atticus map <repo> --estimate` lists, data) or Atticus's own. `cite` is the line that shows the
 * signal the type rests on (the annotation, the dependency, the file's first line); `value` is
 * the signal as written there. `type` is the type's id; one the set doesn't have is kept as
 * written and flagged at verify, so a person adds the type or corrects the fact. One per
 * component; a second is refused at verify.
 */
export const ComponentFact = z.strictObject({
  kind: z.literal("component"),
  ...common,
  /** The type's id (service, bff, gateway, or one of the organisation's). */
  type: z.string().min(1).max(80),
  /** Why it is of that type, in a few words (optional). */
  why: z.string().max(300).optional(),
});

/**
 * A Maven `groupId` or Gradle `group`, and an `artifactId` or project name, as a build file
 * writes them: letters, digits, `.`, `_` and `-`, never a placeholder (`${project.groupId}`): a
 * coordinate set from a property is cited where the property writes it, in `cite.with`.
 */
const Coordinate = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9._-]*$/, "a coordinate as the build file writes it, resolved");

/**
 * What a component's build publishes (ADR 0192): its own coordinates, `group` and `name` (a
 * pom's project `<groupId>` and `<artifactId>`, a Gradle project's `group` and name). `cite` is the
 * line that writes the name (the project's own `<artifactId>`, `rootProject.name`); the line that
 * writes the group, when it is another (the project's `<groupId>`, the `<parent>`'s when the
 * project inherits it, `group = '...'` in build.gradle), goes in `cite.with`, as does the
 * version's. The verifier reads the build file to check each is what that line says, and that
 * the name is the project's own, never a dependency's or a parent's.
 *
 * Nothing is projected into catalog C1 from it, as with a framework fact: the views read it, and
 * the estate's dependency join (`joinDependencies`) pairs it with the `dependency` facts that name
 * the same coordinates.
 */
export const ArtifactFact = z.strictObject({
  kind: z.literal("artifact"),
  ...common,
  group: Coordinate,
  name: Coordinate,
  version: z.string().min(1).max(100).optional(),
});

/** A dependency's scope (ADR 0192): Maven's, or what a Gradle configuration means. */
export const DEPENDENCY_SCOPES = ["compile", "runtime", "provided", "test", "import"] as const;
export type DependencyScope = (typeof DEPENDENCY_SCOPES)[number];

/**
 * A build dependency a component declares (ADR 0192): the `group` and `name` of what it builds
 * on, as the build file declares it in its dependencies (not a dependency-management block, a
 * plugin or an exclusion). `cite` is the line that writes the name (the dependency's
 * `<artifactId>`, a Gradle `implementation 'g:a:v'` line); the dependency's `<groupId>` line, when
 * it is another, goes in `cite.with`. `scope` is the declared scope, left out for the default
 * (compile). The dependency belongs to the component whose build file cites it: a module's pom
 * is its module's.
 *
 * Every dependency is recorded, the organisation's own or not: which one is the estate's own is
 * the dependency join's to say, from the coordinates the estate's `artifact` facts publish.
 */
export const DependencyFact = z.strictObject({
  kind: z.literal("dependency"),
  ...common,
  group: Coordinate,
  name: Coordinate,
  version: z.string().min(1).max(100).optional(),
  scope: z.enum(DEPENDENCY_SCOPES).optional(),
});

export const Fact = z.discriminatedUnion("kind", [
  EntryFact,
  CallFact,
  StoreFact,
  FieldFact,
  DeployFact,
  ConfigFact,
  FrameworkFact,
  FlowFact,
  TermFact,
  ComponentFact,
  ArtifactFact,
  DependencyFact,
]);
export type Fact = z.infer<typeof Fact>;
export type FactOf<K extends FactKind> = Extract<Fact, { kind: K }>;

/** A whole facts file, as an array (the JSONL form is one `Fact` per line). */
export const FactsFile = z.array(Fact);
