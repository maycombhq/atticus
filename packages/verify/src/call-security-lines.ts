/**
 * What a line must write for a call's `tls` or `auth` claim to rest on it (ADR 0163, review 5),
 * as `authPolicyMismatch` asks of an entry's auth: a deterministic check of the line's kind, by
 * words any stack writes, never by one language's API. The quoted value being on the line says
 * only that the line is the one meant; these say it is a line of the kind claimed.
 *
 * - `tls: mtls`: a client certificate, a key store, an SSL bundle, a .pfx or .p12, or a
 *   certificate given with its key (`{ cert, key }`);
 * - `tls: tls`: https, SSL or TLS;
 * - `tls: none`: a plain `http://` URL, or a switch set off (`false`, `disabled`, `insecure`,
 *   `plaintext`), and no `https://`;
 * - `auth`: a token (OAuth, bearer, JWT, an Authorization header, client credentials) for
 *   `oauth2`, a key for `api-key`, a password or basic credentials for `basic`, the client
 *   certificate's words for `mtls`; `other` and `none` are not judged.
 */

const CLIENT_CERT =
  /client[-_ .]?cert|keystore|key[-_ .]?store|ssl[-_ .]?bundle|\.pfx\b|\.p12\b|pkcs12|\bpfx\b|\bp12\b/i;
const CERT_AND_KEY = (l: string) => /\bcert\b/i.test(l) && /\bkey\b/i.test(l);

const KINDS: Record<string, { test: (l: string) => boolean; needs: string }> = {
  "tls mtls": {
    test: (l) => CLIENT_CERT.test(l) || CERT_AND_KEY(l),
    needs: "a client certificate, a key store or an SSL bundle",
  },
  "tls tls": { test: (l) => /https|ssl|tls/i.test(l), needs: "https, SSL or TLS" },
  "tls none": {
    test: (l) =>
      !/https:\/\//i.test(l) &&
      (/http:\/\//i.test(l) || /\b(false|disabled?|insecure|plain-?text|off)\b/i.test(l)),
    needs: "a plain http:// URL or a TLS switch set off",
  },
  "auth oauth2": {
    test: (l) =>
      /oauth|token|bearer|jwt|authori[sz]|client[-_ ]?credentials|access[-_ ]?token/i.test(l),
    needs: "a token (OAuth, bearer, JWT or an Authorization header)",
  },
  "auth api-key": {
    test: (l) => /api[-_ ]?key|apikey|x-api|subscription[-_ ]?key|[a-z0-9][-_]key\b/i.test(l),
    needs: "a key",
  },
  "auth basic": {
    test: (l) => /basic|password|passwd|username|credential/i.test(l),
    needs: "a password or basic credentials",
  },
  "auth mtls": {
    test: (l) => CLIENT_CERT.test(l) || CERT_AND_KEY(l),
    needs: "a client certificate, a key store or an SSL bundle",
  },
};

/**
 * Undefined when one of the lines writes the kind of thing claimed, or the claim isn't judged;
 * else what the lines would have to write.
 */
export function securityLineKind(
  what: "tls" | "auth",
  claim: string,
  lines: readonly string[],
): string | undefined {
  const k = KINDS[`${what} ${claim}`];
  if (!k) return undefined;
  return lines.some((l) => k.test(l)) ? undefined : k.needs;
}

/**
 * The line of a citation the value is on: of the cited line and the line either side (the
 * window every claim is checked in), the first that writes the value, else the cited line.
 */
export function lineOfValue(
  lines: readonly string[] | undefined,
  line: number,
  value: string,
): string | undefined {
  if (!lines) return undefined;
  const v = value.toLowerCase();
  for (const n of [line, line - 1, line + 1]) {
    const l = lines[n - 1];
    if (l !== undefined && l.toLowerCase().includes(v)) return l;
  }
  return lines[line - 1];
}
