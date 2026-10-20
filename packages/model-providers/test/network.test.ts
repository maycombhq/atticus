import { rootCertificates } from "node:tls";
import { describe, expect, it } from "vitest";
import { bypassesProxy, caList, proxyFor, showProxy } from "../src/index.js";

const PEM = "-----BEGIN CERTIFICATE-----\nTIDEWATERROOT\n-----END CERTIFICATE-----\n";

describe("proxy selection", () => {
  it("https uses HTTPS_PROXY, then HTTP_PROXY; lower-case names first", () => {
    expect(
      proxyFor("https://api.anthropic.com/v1/messages", {
        HTTPS_PROXY: "http://proxy.tidewater.example:8080",
      })?.url.href,
    ).toBe("http://proxy.tidewater.example:8080/");
    expect(
      proxyFor("https://api.anthropic.com/", { HTTP_PROXY: "http://fallback.example:3128" })?.from,
    ).toBe("HTTP_PROXY");
    expect(
      proxyFor("https://api.anthropic.com/", {
        https_proxy: "http://lower.example:1",
        HTTPS_PROXY: "http://upper.example:2",
      })?.from,
    ).toBe("https_proxy");
  });

  it("http URLs never use HTTPS_PROXY", () => {
    expect(
      proxyFor("http://127.0.0.1:8000/v1", { HTTPS_PROXY: "http://p.example:1" }),
    ).toBeUndefined();
    expect(proxyFor("http://gw.example/v1", { HTTP_PROXY: "http://p.example:1" })?.from).toBe(
      "HTTP_PROXY",
    );
  });

  it("a proxy without a scheme is http", () => {
    expect(proxyFor("https://x.example/", { HTTPS_PROXY: "proxy.example:8080" })?.url.href).toBe(
      "http://proxy.example:8080/",
    );
  });

  it("NO_PROXY: exact hosts, domain suffixes, *.suffix, ports, IPs and *", () => {
    const u = (s: string) => new URL(s);
    expect(
      bypassesProxy(u("https://llm.tidewater.example/v1"), "localhost,.tidewater.example"),
    ).toBe(true);
    expect(bypassesProxy(u("https://tidewater.example/"), ".tidewater.example")).toBe(true);
    expect(bypassesProxy(u("https://llm.tidewater.example/"), "tidewater.example")).toBe(true);
    expect(bypassesProxy(u("https://nottidewater.example/"), "tidewater.example")).toBe(false);
    expect(bypassesProxy(u("https://a.forge.example/"), "*.forge.example")).toBe(true);
    expect(bypassesProxy(u("https://gw.forge.example:8443/"), "gw.forge.example:8443")).toBe(true);
    expect(bypassesProxy(u("https://gw.forge.example/"), "gw.forge.example:8443")).toBe(false);
    expect(bypassesProxy(u("http://127.0.0.1:8000/"), "127.0.0.1")).toBe(true);
    expect(bypassesProxy(u("http://[::1]:8000/"), "[::1]")).toBe(true);
    expect(bypassesProxy(u("https://anything.example/"), "*")).toBe(true);
    expect(bypassesProxy(u("https://API.Anthropic.com/"), "api.anthropic.com")).toBe(true);
    expect(bypassesProxy(u("https://api.anthropic.com/"), "  ")).toBe(false);
    expect(
      proxyFor("https://llm.tidewater.example/", {
        HTTPS_PROXY: "http://p.example:1",
        no_proxy: "tidewater.example llm.other.example",
      }),
    ).toBeUndefined();
  });

  it("messages show a proxy without its credentials", () => {
    const p = proxyFor("https://x.example/", {
      HTTPS_PROXY: "http://jdoe:hunter2@proxy.example:8080",
    });
    expect(showProxy(p!.url)).toBe("http://proxy.example:8080");
  });

  it("a malformed proxy says which variable", () => {
    expect(() => proxyFor("https://x.example/", { HTTPS_PROXY: "http://exa mple:abc" })).toThrow(
      /The proxy in HTTPS_PROXY isn't a valid address/,
    );
  });
});

describe("certificate authorities", () => {
  it("leaves Node's own list alone without caFile (NODE_EXTRA_CA_CERTS is Node's job then)", () => {
    expect(caList({ env: { NODE_EXTRA_CA_CERTS: "/x.pem" } })).toBeUndefined();
  });

  it("with caFile: Node's roots, NODE_EXTRA_CA_CERTS and the file, so none is dropped", () => {
    const files: Record<string, string> = {
      "/extra.pem": PEM,
      "/ca.pem": PEM.replace("ROOT", "ISSUING"),
    };
    const list = caList({ caFile: "/ca.pem", env: { NODE_EXTRA_CA_CERTS: "/extra.pem" } }, (f) => {
      if (!(f in files)) throw new Error("ENOENT");
      return files[f]!;
    })!;
    expect(list.length).toBe(rootCertificates.length + 2);
    expect(list.at(-2)).toContain("TIDEWATERROOT");
    expect(list.at(-1)).toContain("TIDEWATERISSUING");
  });

  it("an unreadable or non-PEM CA file is a plain error", () => {
    expect(() =>
      caList({ caFile: "/missing.pem", env: {} }, () => {
        throw new Error("ENOENT");
      }),
    ).toThrow(
      "The CA certificate file /missing.pem (adapters.model.settings.caFile or NODE_EXTRA_CA_CERTS) can't be read. Check the path and that it holds PEM certificates.",
    );
    expect(() => caList({ caFile: "/x.der", env: {} }, () => "binary")).toThrow(/can't be read/);
  });
});
