/**
 * The columns a traffic export names (ADR 0151, J4), per source: which of an export's columns
 * hold the caller app, method, path, proxy, base path, count and time. Every other column (client
 * ids, keys, IPs, user agents, full URIs, bodies) is dropped at import, whatever it is called.
 * Names are compared lower case with everything but letters and digits taken out, so
 * `developer_app`, `Developer App` and `developerApp` are one. A new source is a new entry here.
 */
export interface TrafficColumns {
  /** The calling application, as the export names it. */
  app: readonly string[];
  method: readonly string[];
  /** The whole request path (its query string is cut off at import). */
  path: readonly string[];
  /** A proxy's base path and the path after it, which together are the path. */
  basepath: readonly string[];
  suffix: readonly string[];
  proxy: readonly string[];
  /** How many requests the row stands for; a row is one request when the export has none. */
  count: readonly string[];
  /** When: an ISO date or timestamp, of which the day is kept. */
  time: readonly string[];
}

/** The sources `atticus intake traffic --source` reads. */
export const TRAFFIC_SOURCES: Readonly<Record<string, TrafficColumns>> = {
  // A gateway analytics custom report, exported as CSV or JSON: its dimensions and metrics.
  apigee: {
    app: ["developer_app", "developer app", "app", "application"],
    method: ["request_verb", "verb", "method"],
    path: ["request_path", "request_uri", "uri", "path"],
    basepath: ["proxy_basepath", "basepath", "base path"],
    suffix: ["proxy_pathsuffix", "pathsuffix", "path suffix"],
    proxy: ["apiproxy", "api_proxy", "proxy"],
    count: ["sum(message_count)", "message_count", "traffic", "count"],
    time: ["client_received_start_timestamp", "timestamp", "time", "date", "day"],
  },
  // An API catalogue's usage export: who calls which operation, and how often.
  catalog: {
    app: ["consumer", "consumer app", "application", "app", "client name", "subscriber"],
    method: ["method", "http method", "verb"],
    path: ["path", "operation path", "resource", "route"],
    basepath: ["basepath", "base path"],
    suffix: [],
    proxy: ["api", "api name", "proxy", "product"],
    count: ["calls", "count", "requests", "hits"],
    time: ["date", "day", "timestamp", "time", "period"],
  },
};
