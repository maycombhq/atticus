import { readFileSync } from "node:fs";
import { rootCertificates } from "node:tls";
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
import { copy } from "./messages.js";
import { ModelProviderConfigError, type Env } from "./settings.js";

/**
 * The network under every provider: one HTTP request in, one response out. Tests pass their
 * own transport, so no test reaches the network; the real one is undici's fetch through the
 * corporate proxy and CA the environment names.
 */

export interface HttpRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  headers: { get(name: string): string | null };
  text: string;
}

export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

/** The request didn't get an HTTP answer: what went wrong, in Node's or undici's code. */
export class TransportError extends Error {
  constructor(
    readonly code: string,
    readonly o: { proxy?: string; proxyStatus?: number; timedOut?: boolean } = {},
  ) {
    super(code);
    this.name = "TransportError";
  }
}

// ------------------------------------------------------------------ proxy selection

const pick = (env: Env, ...names: string[]) => {
  for (const n of names) {
    const v = env[n]?.trim();
    if (v) return { name: n, value: v };
  }
  return undefined;
};

/** Does NO_PROXY (comma- or space-separated hosts, `.suffix`, `*.suffix`, `host:port`, `*`) cover this URL? */
export function bypassesProxy(url: URL, noProxy: string | undefined): boolean {
  if (!noProxy) return false;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  for (const raw of noProxy.split(/[,\s]+/)) {
    let entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;
    let entryPort: string | undefined;
    const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry);
    if (bracketed) {
      entry = bracketed[1]!;
      entryPort = bracketed[2];
    } else if ((entry.match(/:/g) ?? []).length === 1) {
      const [h, p] = entry.split(":");
      entry = h!;
      entryPort = p;
    }
    entry = entry.replace(/^\*\./, ".");
    if (entryPort && entryPort !== port) continue;
    if (entry.startsWith(".")) {
      if (host.endsWith(entry) || host === entry.slice(1)) return true;
    } else if (host === entry || host.endsWith(`.${entry}`)) return true;
  }
  return false;
}

/**
 * The proxy for a URL, from the environment the way curl and undici read it: https URLs use
 * https_proxy or HTTPS_PROXY, then http_proxy or HTTP_PROXY; http URLs use http_proxy or
 * HTTP_PROXY. NO_PROXY (or no_proxy) wins. Lower-case names first.
 */
export function proxyFor(url: string | URL, env: Env): { url: URL; from: string } | undefined {
  const u = typeof url === "string" ? new URL(url) : url;
  const no = pick(env, "no_proxy", "NO_PROXY");
  if (bypassesProxy(u, no?.value)) return undefined;
  const p =
    u.protocol === "https:"
      ? pick(env, "https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY")
      : pick(env, "http_proxy", "HTTP_PROXY");
  if (!p) return undefined;
  const value = /^[a-z][a-z0-9+.-]*:\/\//i.test(p.value) ? p.value : `http://${p.value}`;
  try {
    return { url: new URL(value), from: p.name };
  } catch {
    throw new ModelProviderConfigError(copy.badProxy(p.name));
  }
}

/** A proxy address fit for a message: no user name or password. */
export function showProxy(u: URL): string {
  return `${u.protocol}//${u.host}`;
}

// ------------------------------------------------------------------ certificates

/**
 * Extra certificate authorities. Node already trusts NODE_EXTRA_CA_CERTS for every TLS
 * connection when it starts; Atticus only builds its own list when `caFile` is set, and then
 * keeps Node's bundled roots and NODE_EXTRA_CA_CERTS in it, so naming one file never drops
 * the others.
 */
export function caList(
  o: { caFile?: string; env: Env },
  read: (file: string) => string = (f) => readFileSync(f, "utf8"),
): string[] | undefined {
  if (!o.caFile) return undefined;
  const files = [o.env.NODE_EXTRA_CA_CERTS?.trim(), o.caFile].filter((f): f is string => !!f);
  const out = [...rootCertificates];
  for (const f of files) {
    let pem: string;
    try {
      pem = read(f);
    } catch {
      throw new ModelProviderConfigError(copy.caFileUnreadable(f));
    }
    if (!pem.includes("-----BEGIN CERTIFICATE-----"))
      throw new ModelProviderConfigError(copy.caFileUnreadable(f));
    out.push(pem);
  }
  return out;
}

// ------------------------------------------------------------------ the real transport

const CERT_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_UNTRUSTED",
]);
export const isCertCode = (code: string) => CERT_CODES.has(code);

function codeOf(e: unknown): string {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur; i++) {
    const c = cur as { code?: unknown; cause?: unknown; name?: unknown };
    if (typeof c.code === "string" && c.code !== "UND_ERR") return c.code;
    cur = c.cause;
  }
  return "network error";
}

function proxyStatusOf(e: unknown): number | undefined {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur; i++) {
    const m = /Proxy response \((\d{3})\)/.exec(String((cur as Error).message ?? ""));
    if (m) return Number(m[1]);
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * undici's fetch through the proxy the environment names (HTTPS_PROXY, HTTP_PROXY, NO_PROXY),
 * trusting Node's CAs, NODE_EXTRA_CA_CERTS and the `caFile` setting. Proxy credentials in the
 * proxy URL are sent to the proxy and never printed.
 */
export function undiciTransport(o: { env: Env; caFile?: string }): Transport {
  const ca = caList(o);
  const tls = ca ? { ca } : {};
  const agents = new Map<string, Dispatcher>();
  const dispatcherFor = (target: string, timeoutMs: number) => {
    const proxy = proxyFor(target, o.env);
    const key = `${proxy?.url.href ?? "direct"}|${timeoutMs}`;
    let d = agents.get(key);
    if (!d) {
      const timeouts = { headersTimeout: timeoutMs, bodyTimeout: timeoutMs };
      d = proxy
        ? new ProxyAgent({ uri: proxy.url.href, requestTls: tls, proxyTls: tls, ...timeouts })
        : new Agent({ connect: tls, ...timeouts });
      agents.set(key, d);
    }
    return { dispatcher: d, proxy };
  };
  return async (r) => {
    const { dispatcher, proxy } = dispatcherFor(r.url, r.timeoutMs);
    const timer = AbortSignal.timeout(r.timeoutMs);
    const signal = r.signal ? AbortSignal.any([r.signal, timer]) : timer;
    try {
      const res = await undiciFetch(r.url, {
        method: r.method,
        headers: r.headers,
        body: r.body,
        signal,
        dispatcher,
        redirect: "manual",
      });
      return { status: res.status, headers: res.headers, text: await res.text() };
    } catch (e) {
      if (r.signal?.aborted) throw e;
      const shown = proxy ? showProxy(proxy.url) : undefined;
      if (timer.aborted)
        throw new TransportError("timeout", { timedOut: true, ...(shown ? { proxy: shown } : {}) });
      const proxyStatus = proxyStatusOf(e);
      throw new TransportError(codeOf(e), {
        ...(shown ? { proxy: shown } : {}),
        ...(proxyStatus ? { proxyStatus } : {}),
      });
    }
  };
}
