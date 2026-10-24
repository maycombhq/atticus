import { BaseProvider, COMMON_SETTINGS, type CompleteInput, type ProviderDeps } from "./common.js";
import type { KeyStore } from "./credentials.js";
import { copy, type Where } from "./messages.js";
import {
  ModelProviderConfigError,
  ModelProviderError,
  readKey,
  SettingsReader,
  type RawSettings,
} from "./settings.js";

/**
 * A model provider from an org-pack plugin (ADR 0121 item 4):
 * org-pack/plugins/model-providers/<id>/, pinned by sha256 and named in runtime.yaml as
 * adapters.model.type. The plugin's code only translates, in the plugin sandbox: `request` turns
 * the prompt into a URL, headers and a body, and `response` turns the answer into text. This
 * class makes the call through the same transport, proxy, CA, retries and timeouts as every
 * provider, refuses a URL that isn't HTTPS to a host the manifest names, and adds the key from
 * keyEnv itself. The plugin never sees the key, nor the name of its variable.
 */

/** Call one of the plugin's functions with data (the sandbox's runTranslator, or a fake). */
export type Translate = (fn: "request" | "response", arg: unknown) => Promise<unknown>;

/** What the provider needs from the plugin's manifest. */
export interface PluginManifest {
  id: string;
  version: string;
  settings: readonly string[];
  hosts: readonly string[];
  auth: string;
}

export interface PluginDeps extends ProviderDeps {
  translate: Translate;
  /** Where a key not in the environment is looked up. Default: this machine's store. */
  keys?: Pick<KeyStore, "get">;
}

/** Headers only Atticus sets: the plugin's own of these are refused. */
const RESERVED = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "cookie",
  "host",
  "content-length",
]);

const HOST_PART = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const PART = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

const count = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;

export class PluginProvider extends BaseProvider {
  readonly model: string;
  readonly #key: string | undefined;
  readonly #translate: Translate;
  private readonly keyEnv: string | undefined;
  private readonly hosts: string[];
  private readonly extra: Record<string, string>;
  /** The header the key goes in, when the manifest's auth is header:<name>. */
  private readonly own: string | undefined;

  constructor(
    private readonly manifest: PluginManifest,
    settings: RawSettings,
    deps: PluginDeps,
  ) {
    const s = new SettingsReader(manifest.id, settings, [
      ...COMMON_SETTINGS,
      ...(manifest.auth === "none" ? [] : ["keyEnv"]),
      ...manifest.settings,
    ]);
    super(s, deps);
    this.#translate = deps.translate;
    this.model = s.str("model", { required: true, example: "the model's id" });
    const extra: Record<string, string> = {};
    for (const name of manifest.settings) {
      const v = s.str(name);
      if (v !== undefined) extra[name] = v;
    }
    this.extra = extra;
    // Every host the manifest names, its {setting} parts filled: each part a plain name.
    this.hosts = manifest.hosts.map((h) =>
      h.replace(PART, (_m, name: string) => {
        const v = extra[name];
        if (v === undefined)
          throw new ModelProviderConfigError(copy.missingSetting(manifest.id, name, "eu-west"));
        if (!HOST_PART.test(v))
          throw new ModelProviderConfigError(copy.hostPart(manifest.id, name));
        return v;
      }),
    );
    this.own = manifest.auth.startsWith("header:")
      ? manifest.auth.slice("header:".length).toLowerCase()
      : undefined;
    if (manifest.auth === "none") {
      this.keyEnv = undefined;
      this.#key = undefined;
    } else {
      this.keyEnv = s.keyEnv({ required: true })!;
      this.#key = readKey(manifest.id, this.keyEnv, this.env, deps.keys);
    }
  }

  protected where(): Where {
    return {
      provider: `The ${this.manifest.id} plugin`,
      host: this.hosts[0] ?? "",
      model: this.model,
      ...(this.keyEnv ? { keyEnv: this.keyEnv } : {}),
    };
  }

  protected secrets(): string[] {
    return this.#key ? [this.#key] : [];
  }

  private async call(fn: "request" | "response", arg: unknown): Promise<Record<string, unknown>> {
    let out: unknown;
    try {
      out = await this.#translate(fn, arg);
    } catch (e) {
      throw new ModelProviderError(
        copy.pluginFailed(
          this.manifest.id,
          fn === "request" ? "build the request" : "read the answer",
          (e as Error).message,
        ),
      );
    }
    if (!out || typeof out !== "object" || Array.isArray(out))
      throw new ModelProviderError(
        copy.pluginFailed(this.manifest.id, fn, "it gave back something that isn't an object"),
      );
    return out as Record<string, unknown>;
  }

  /** The plugin's request, checked: HTTPS to a named host, no credentials, no key headers. */
  private checked(r: Record<string, unknown>): { url: string; headers: Record<string, string> } {
    const refuse = (why: string) =>
      new ModelProviderError(copy.pluginRefused(this.manifest.id, why));
    if (typeof r.url !== "string") throw refuse("it has no url");
    let u: URL;
    try {
      u = new URL(r.url);
    } catch {
      throw refuse("its url isn't an address");
    }
    if (u.protocol !== "https:") throw refuse("its url isn't https");
    if (u.username || u.password) throw refuse("its url holds credentials");
    if (u.port) throw refuse("its url names a port");
    if (!this.hosts.includes(u.hostname))
      throw refuse(
        `it goes to ${u.hostname}, which the plugin's manifest doesn't name (${this.hosts.join(", ")})`,
      );
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };
    if (r.headers !== undefined) {
      if (!r.headers || typeof r.headers !== "object" || Array.isArray(r.headers))
        throw refuse("its headers aren't an object");
      for (const [k, v] of Object.entries(r.headers as Record<string, unknown>)) {
        const name = k.toLowerCase();
        if (RESERVED.has(name) || name === this.own || name.startsWith("proxy-"))
          throw refuse(`it sets the ${k} header, which only Atticus sets`);
        if (typeof v !== "string" || /[\r\n]/.test(v))
          throw refuse(`its ${k} header isn't one line of text`);
        headers[name] = v;
      }
    }
    if (this.#key) {
      if (this.manifest.auth === "bearer") headers.authorization = `Bearer ${this.#key}`;
      else if (this.manifest.auth === "x-api-key") headers["x-api-key"] = this.#key;
      else if (this.own) headers[this.own] = this.#key;
    }
    return { url: u.href, headers };
  }

  async complete(input: CompleteInput) {
    const max = this.tokensFor(input);
    const req = await this.call("request", {
      model: this.model,
      system: input.system,
      prompt: input.prompt,
      maxOutputTokens: max,
      settings: { ...this.extra },
    });
    const { url, headers } = this.checked(req);
    const json = await this.post({
      url,
      headers,
      body: req.body ?? {},
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const out = await this.call("response", json);
    const inputTokens = count(out.inputTokens);
    const outputTokens = count(out.outputTokens);
    return this.finish(
      typeof out.text === "string" ? out.text : "",
      {
        cutOff: out.cutOff === true,
        ...(typeof out.declined === "string" && out.declined ? { declined: out.declined } : {}),
      },
      max,
      {
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
      },
      input,
    );
  }
}
