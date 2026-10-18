import dgram from "node:dgram";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";

/**
 * Run a function with the network blocked and the clock fixed, to check that a plugin is
 * deterministic (ADR 0007): every way out of the process a plugin could take (fetch, http and
 * https requests, sockets, TLS, UDP, DNS) throws and is recorded; `Date` reports a fixed time.
 * Everything is restored afterwards, even when the function throws. Not a sandbox: it catches
 * accidents and honest plugins, not a plugin set on escaping.
 */

export class NetworkBlocked extends Error {
  constructor(what: string) {
    super(`Network access is blocked in a conformance run (${what}).`);
    this.name = "NetworkBlocked";
  }
}

type Patch = [object, string, unknown];

export interface GuardedRun<T> {
  value?: T;
  error?: unknown;
  /** What the function tried to reach, in order. */
  attempts: string[];
}

export async function guarded<T>(
  fn: () => Promise<T>,
  o: { fixedTime?: string } = {},
): Promise<GuardedRun<T>> {
  const attempts: string[] = [];
  const saved: Patch[] = [];
  const block = (target: object, key: string, what: string) => {
    saved.push([target, key, (target as Record<string, unknown>)[key]]);
    (target as Record<string, unknown>)[key] = (...args: unknown[]) => {
      const arg = args[0];
      const detail =
        typeof arg === "string"
          ? arg
          : arg instanceof URL
            ? arg.href
            : arg && typeof arg === "object" && "host" in arg
              ? String((arg as { host?: unknown }).host)
              : "";
      attempts.push(detail ? `${what} ${detail}` : what);
      throw new NetworkBlocked(what);
    };
  };
  if (typeof globalThis.fetch === "function") block(globalThis, "fetch", "fetch");
  block(http, "request", "http.request");
  block(http, "get", "http.get");
  block(https, "request", "https.request");
  block(https, "get", "https.get");
  block(net, "connect", "net.connect");
  block(net, "createConnection", "net.createConnection");
  block(net.Socket.prototype, "connect", "socket.connect");
  block(tls, "connect", "tls.connect");
  block(dgram, "createSocket", "dgram.createSocket");
  for (const k of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny"])
    block(dns, k, `dns.${k}`);
  for (const k of ["lookup", "resolve", "resolve4", "resolve6"]) block(dns.promises, k, `dns.${k}`);

  const RealDate = globalThis.Date;
  if (o.fixedTime) {
    const fixed = RealDate.parse(o.fixedTime);
    class FixedDate extends RealDate {
      constructor(...args: unknown[]) {
        if (args.length === 0) super(fixed);
        else super(...(args as [string]));
      }
      static override now() {
        return fixed;
      }
    }
    globalThis.Date = FixedDate as DateConstructor;
  }
  syncBuiltinESMExports();
  try {
    return { value: await fn(), attempts };
  } catch (error) {
    return { error, attempts };
  } finally {
    globalThis.Date = RealDate;
    for (const [target, key, value] of saved.reverse())
      (target as Record<string, unknown>)[key] = value;
    syncBuiltinESMExports();
  }
}
