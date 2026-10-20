import { createHash, createHmac } from "node:crypto";

/**
 * AWS Signature Version 4, written with node:crypto so Atticus ships no AWS SDK. It signs
 * what Bedrock needs: one request with a body, the host and every header given. Paths are
 * encoded once more over the wire form, as AWS expects for every service but S3.
 */

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

const sha256hex = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const hmac = (key: string | Buffer, s: string) =>
  createHmac("sha256", key).update(s, "utf8").digest();

/** RFC 3986 encoding: everything but A-Z a-z 0-9 - _ . ~ is %XX (upper-case hex). */
export function uriEncode(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** 20150830T123600Z and 20150830, from a date. */
export function amzDates(d: Date): { amzDate: string; dateStamp: string } {
  const amzDate = d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

export function signingKey(secret: string, dateStamp: string, region: string, service: string) {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, dateStamp), region), service), "aws4_request");
}

export interface SignInput {
  method: string;
  url: URL;
  /** Headers to send and sign (host and x-amz-date are added). */
  headers: Record<string, string>;
  body: string;
  region: string;
  service: string;
  credentials: AwsCredentials;
  date: Date;
}

/** The canonical request, string to sign and signature (exported for the test vectors). */
export function sigV4Parts(i: SignInput) {
  const { amzDate, dateStamp } = amzDates(i.date);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(i.headers)) headers[k.toLowerCase()] = v;
  headers.host ??= i.url.host;
  headers["x-amz-date"] = amzDate;
  if (i.credentials.sessionToken) headers["x-amz-security-token"] = i.credentials.sessionToken;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names
    .map((n) => `${n}:${headers[n]!.trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const signedHeaders = names.join(";");
  const canonicalUri =
    i.url.pathname
      .split("/")
      .map((seg) => uriEncode(seg))
      .join("/") || "/";
  const query = [...i.url.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonicalRequest = [
    i.method.toUpperCase(),
    canonicalUri,
    query,
    canonicalHeaders,
    signedHeaders,
    sha256hex(i.body),
  ].join("\n");
  const scope = `${dateStamp}/${i.region}/${i.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest)].join("\n");
  const signature = createHmac(
    "sha256",
    signingKey(i.credentials.secretAccessKey, dateStamp, i.region, i.service),
  )
    .update(stringToSign, "utf8")
    .digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${i.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { canonicalRequest, stringToSign, signature, authorization, headers };
}

/** The headers to send: the given ones, x-amz-date, the session token and Authorization. */
export function signV4(i: SignInput): Record<string, string> {
  const p = sigV4Parts(i);
  const out = { ...p.headers, authorization: p.authorization };
  delete (out as Record<string, string>).host;
  return out;
}
