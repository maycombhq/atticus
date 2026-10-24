import { RuntimeConfigError, RuntimeError } from "@maycombhq/ai";
import { copy } from "./messages.js";
import { defaultKeyStore, type KeyStore } from "./credentials.js";

/** runtime.yaml `adapters.model.settings`, as the factory hands it over. */
export type RawSettings = Record<string, string | number | boolean | string[]>;

/** The environment a provider reads (keys, AWS credentials, proxy, CA). Injectable for tests. */
export type Env = Record<string, string | undefined>;

/** A setting in runtime.yaml is wrong or missing: the command stops before anything is sent. */
export class ModelProviderConfigError extends RuntimeConfigError {
  constructor(message: string) {
    super(message);
    this.name = "ModelProviderConfigError";
  }
}

/** A call to the model failed; the message says what to check. It never holds a key. */
export class ModelProviderError extends RuntimeError {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ModelProviderError";
  }
}

/**
 * Does this look like a key, token or signed URL rather than a name, a model id or an
 * address? Known key shapes, bearer and basic values, JWTs, URLs with credentials or a
 * key in the query, and long opaque strings: mixed case with digits, or long hex. Model ids,
 * deployment names and environment variable names have hyphens, dots, colons or one case.
 */
export function looksLikeKey(v: string): boolean {
  const s = v.trim();
  if (/^sk-[A-Za-z0-9_-]{12,}/.test(s)) return true;
  if (/\b(AKIA|ASIA)[A-Z0-9]{16}\b/.test(s)) return true;
  if (/^(bearer|basic)\s+\S{8,}/i.test(s)) return true;
  if (/^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./.test(s)) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      if (u.password) return true;
      for (const k of u.searchParams.keys())
        if (/(key|token|secret|sig|signature|password|credential|code)/i.test(k)) return true;
    } catch {
      // not a URL after all; fall through
    }
    return false;
  }
  if (s.length >= 32 && /^[A-Za-z0-9+/=_]+$/.test(s)) {
    const digit = /\d/.test(s);
    if (digit && /[A-Z]/.test(s) && /[a-z]/.test(s)) return true;
    if (digit && /^[0-9a-f]+$/.test(s) && /[a-f]/.test(s)) return true;
  }
  return false;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Reads one provider's settings, refusing unknown names, wrong types and literal keys. */
export class SettingsReader {
  constructor(
    readonly provider: string,
    private readonly raw: RawSettings,
    known: readonly string[],
  ) {
    const knownSet = new Set(known);
    for (const name of Object.keys(raw)) {
      if (!knownSet.has(name))
        throw new ModelProviderConfigError(copy.unknownSetting(provider, name, [...known].sort()));
    }
    for (const [name, value] of Object.entries(raw)) {
      const values = Array.isArray(value) ? value : [value];
      for (const v of values)
        if (typeof v === "string" && looksLikeKey(v))
          throw new ModelProviderConfigError(copy.literalKey(provider, name));
    }
  }

  str(name: string): string | undefined;
  str(name: string, o: { required: true; example: string }): string;
  str(name: string, o?: { required: true; example: string }): string | undefined {
    const v = this.raw[name];
    if (v === undefined || v === "") {
      if (o?.required)
        throw new ModelProviderConfigError(copy.missingSetting(this.provider, name, o.example));
      return undefined;
    }
    if (typeof v !== "string")
      throw new ModelProviderConfigError(copy.badSetting(this.provider, name, "must be text"));
    return v.trim();
  }

  oneOf<T extends string>(name: string, options: readonly T[], fallback: T): T {
    const v = this.str(name) ?? fallback;
    if (!(options as readonly string[]).includes(v))
      throw new ModelProviderConfigError(
        copy.badSetting(this.provider, name, `must be one of ${options.join(", ")}`),
      );
    return v as T;
  }

  int(name: string, o: { min: number; max: number; fallback: number }): number {
    const v = this.raw[name];
    if (v === undefined) return o.fallback;
    if (typeof v !== "number" || !Number.isInteger(v) || v < o.min || v > o.max)
      throw new ModelProviderConfigError(
        copy.badSetting(this.provider, name, `must be a whole number from ${o.min} to ${o.max}`),
      );
    return v;
  }

  /** The name of the environment variable holding the key (never the key itself). */
  keyEnv(o: { required: boolean }): string | undefined {
    const v = this.raw.keyEnv;
    if (v === undefined || v === "") {
      if (o.required)
        throw new ModelProviderConfigError(
          copy.missingSetting(this.provider, "keyEnv", "ATTICUS_MODEL_KEY"),
        );
      return undefined;
    }
    if (typeof v !== "string" || !ENV_NAME.test(v.trim()))
      throw new ModelProviderConfigError(copy.keyEnvName(this.provider));
    return v.trim();
  }

  /** baseUrl, https only (plain http for this machine alone), without a trailing slash. */
  url(name: string, o: { fallback?: string; example: string }): URL {
    const v = this.str(name) ?? o.fallback;
    if (!v) throw new ModelProviderConfigError(copy.missingSetting(this.provider, name, o.example));
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      throw new ModelProviderConfigError(
        copy.badSetting(this.provider, name, `must be an address like ${o.example}`),
      );
    }
    if (u.username || u.password)
      throw new ModelProviderConfigError(copy.literalKey(this.provider, name));
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback))
      throw new ModelProviderConfigError(copy.plainHttp(this.provider, u.origin));
    u.pathname = u.pathname.replace(/\/+$/, "");
    return u;
  }
}

/**
 * The key named in keyEnv: from the environment first, then from this machine's credential store
 * (`atticus secret set`, ADR 0121); refuses one that is in neither.
 */
export function readKey(
  provider: string,
  keyEnv: string,
  env: Env,
  store: Pick<KeyStore, "get"> = defaultKeyStore(),
): string {
  const v = env[keyEnv]?.trim() || store.get(keyEnv)?.trim();
  if (!v) throw new ModelProviderConfigError(copy.keyEnvUnset(provider, keyEnv));
  return v;
}
