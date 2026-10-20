import { redactText } from "@maycombhq/core";
import { copy, type Where } from "./messages.js";
import { isCertCode, TransportError, type HttpResponse, type Transport } from "./network.js";
import { ModelProviderError } from "./settings.js";

/** How hard to try: bounded retries with backoff, honouring Retry-After up to a limit. */
export interface RetryPolicy {
  /** Retries after the first try (so maxRetries 3 means at most 4 requests). */
  maxRetries: number;
  /** The first backoff; each retry doubles it, with jitter, up to maxDelayMs. */
  baseDelayMs: number;
  maxDelayMs: number;
  /** A Retry-After longer than this stops the retries with a message instead of waiting. */
  maxRetryAfterMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  maxRetryAfterMs: 60_000,
};

/** Waiting and randomness, injectable so tests neither sleep nor flake. */
export interface Clock {
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  random(): number;
  now(): number;
}

export const realClock: Clock = {
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const t = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        reject(signal!.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
  random: Math.random,
  now: Date.now,
};

const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);
const RETRY_CODES = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "ECONNABORTED"]);

/** Retry-After (seconds or an HTTP date) or Azure's retry-after-ms, in milliseconds. */
export function retryAfterMs(res: HttpResponse, now: number): number | undefined {
  const ms = res.headers.get("retry-after-ms");
  if (ms && /^\d+(\.\d+)?$/.test(ms.trim())) return Math.ceil(Number(ms));
  const v = res.headers.get("retry-after")?.trim();
  if (!v) return undefined;
  if (/^\d+(\.\d+)?$/.test(v)) return Math.ceil(Number(v) * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

export function backoffMs(attempt: number, p: RetryPolicy, random: () => number): number {
  const exp = Math.min(p.maxDelayMs, p.baseDelayMs * 2 ** attempt);
  // "Equal jitter": half fixed, half random, so retries from many laptops spread out.
  return Math.round(exp / 2 + (exp / 2) * random());
}

/** Text from a provider fit for a message: the provider's own error message, short, with every secret masked. */
export function detailOf(text: string, secrets: readonly string[]): string {
  let d = "";
  try {
    const j = JSON.parse(text) as {
      error?: { message?: unknown } | string;
      message?: unknown;
      Message?: unknown;
    };
    const m =
      typeof j.error === "object" && j.error
        ? j.error.message
        : typeof j.error === "string"
          ? j.error
          : (j.message ?? j.Message);
    if (typeof m === "string") d = m;
  } catch {
    d = /<html/i.test(text) ? "" : text;
  }
  d = d.replace(/\s+/g, " ").trim().slice(0, 300);
  return mask(d, secrets);
}

/** Every secret value replaced by ***, then the log's own redaction on top. */
export function mask(s: string, secrets: readonly string[]): string {
  let out = s;
  for (const k of secrets) if (k && k.length >= 4) out = out.split(k).join("***");
  return redactText(out);
}

export interface PostOptions {
  where: Where;
  transport: Transport;
  url: string;
  headers: Record<string, string> | (() => Record<string, string>);
  body: string;
  timeoutMs: number;
  retry: RetryPolicy;
  clock: Clock;
  /** Values that must never appear in a message (the key, AWS secrets). */
  secrets: readonly string[];
  signal?: AbortSignal;
}

/**
 * POST JSON and return the parsed answer. Retries 408, 429, 5xx, 529 and dropped connections,
 * at most `retry.maxRetries` times; every other failure becomes one plain sentence.
 */
export async function postJson(o: PostOptions): Promise<unknown> {
  const tries = o.retry.maxRetries + 1;
  for (let attempt = 0; ; attempt++) {
    const last = attempt + 1 >= tries;
    let res: HttpResponse;
    try {
      res = await o.transport({
        url: o.url,
        method: "POST",
        headers: typeof o.headers === "function" ? o.headers() : o.headers,
        body: o.body,
        timeoutMs: o.timeoutMs,
        ...(o.signal ? { signal: o.signal } : {}),
      });
    } catch (e) {
      if (o.signal?.aborted) throw e;
      if (!(e instanceof TransportError))
        throw new ModelProviderError(mask(String((e as Error).message ?? e), o.secrets));
      if (!last && RETRY_CODES.has(e.code)) {
        await o.clock.sleep(backoffMs(attempt, o.retry, o.clock.random), o.signal);
        continue;
      }
      throw transportMessage(e, o.where, o.timeoutMs);
    }
    if (res.status >= 200 && res.status < 300) {
      try {
        return JSON.parse(res.text) as unknown;
      } catch {
        throw new ModelProviderError(copy.notJson(o.where), res.status);
      }
    }
    if (RETRY_STATUS.has(res.status) && !last) {
      const after = retryAfterMs(res, o.clock.now());
      if (after !== undefined && after > o.retry.maxRetryAfterMs)
        throw new ModelProviderError(
          copy.waitTooLong(o.where, Math.ceil(after / 1000)),
          res.status,
        );
      await o.clock.sleep(after ?? backoffMs(attempt, o.retry, o.clock.random), o.signal);
      continue;
    }
    throw statusMessage(res, o.where, attempt + 1, o.secrets);
  }
}

function statusMessage(
  res: HttpResponse,
  w: Where,
  tries: number,
  secrets: readonly string[],
): ModelProviderError {
  const s = res.status;
  const detail = detailOf(res.text, secrets);
  const msg =
    s === 401 || s === 403
      ? copy.unauthorized(w, s)
      : s === 404
        ? copy.notFound(w)
        : s === 429
          ? copy.rateLimited(w, tries)
          : s >= 500 || s === 408
            ? copy.serverError(w, s, tries)
            : s === 400 || s === 413 || s === 422
              ? copy.badRequest(w, s, detail)
              : copy.otherStatus(w, s, detail);
  return new ModelProviderError(msg, s);
}

function transportMessage(e: TransportError, w0: Where, timeoutMs: number): ModelProviderError {
  const w = { ...w0, ...(e.o.proxy ? { proxy: e.o.proxy } : {}) };
  if (e.o.timedOut) return new ModelProviderError(copy.timeout(w, Math.round(timeoutMs / 1000)));
  if (e.o.proxyStatus)
    return new ModelProviderError(copy.proxyRefused(w, `HTTP ${e.o.proxyStatus}`));
  if (isCertCode(e.code)) return new ModelProviderError(copy.untrustedCert(w, e.code));
  if (e.o.proxy) return new ModelProviderError(copy.proxyUnreachable(w, e.code));
  return new ModelProviderError(copy.unreachable(w, e.code));
}
