# 0065. Model-provider plugins: Anthropic, OpenAI-compatible endpoints and AWS Bedrock (C5 and C6, additive)

- Status: accepted (pending review by the product owner)
- Date: 2026-10-20

## Context

Model mode (ADR 0014, ADR 0036) calls a model directly through a model-provider adapter, but no adapter shipped: `createRuntime` took `providers` from its caller, and the CLI passed none, so `runtime.yaml` `modes.default: model` always ended in "No anthropic model provider is installed". Banks and other regulated organisations reach models in three ways: Anthropic's API (directly or through a gateway), an OpenAI-shaped endpoint (Azure OpenAI deployments, an internal LLM gateway, vLLM and similar servers) and AWS Bedrock (often through a VPC endpoint). They do it from laptops behind a corporate proxy that inspects TLS with the organisation's own certificate authority, and their security reviews ask the same questions every time: where does the key live, can it leak into a log, what happens when the service slows down.

## Decision

**A new package, `@maycombhq/model-providers`**, holds three providers. The CLI registers them when it starts, so `adapters.model.type` works out of the box:

| `adapters.model.type` | Calls                                                                                                                          | Credentials                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `anthropic`           | Messages API, `POST {baseUrl}/v1/messages` (default `https://api.anthropic.com`), `anthropic-version: 2023-06-01`              | The variable named in `keyEnv`, as `x-api-key` (or `Authorization: Bearer` with `auth: bearer`, for gateways)             |
| `openai-compatible`   | Chat Completions, `POST {baseUrl}/chat/completions` (`flavour: openai`, the default)                                           | The variable named in `keyEnv` as a bearer token; optional, since a gateway on the inside may take none                   |
| `openai-compatible`   | Azure OpenAI with `flavour: azure`: `POST {baseUrl}/openai/deployments/{deployment}/chat/completions?api-version={apiVersion}` | `keyEnv`, as the `api-key` header (or `auth: bearer` for a Microsoft Entra ID token the person puts in the variable)      |
| `azure-openai`        | The same as `openai-compatible` with `flavour: azure` (this type was already in C6)                                            | As above                                                                                                                  |
| `bedrock`             | Converse API, `POST {baseUrl}/model/{model}/converse` (default `https://bedrock-runtime.{region}.amazonaws.com`)               | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN`, read on each call; SigV4 written with `node:crypto` |

`vertex` stays in C6 with no built-in provider; it keeps the existing "No vertex model provider is installed" message, as does any type nobody registered.

**Settings** (`adapters.model.settings`): `model` (required except for Azure, where it defaults to the deployment; it is what `models.allowed` checks), `baseUrl`, `keyEnv`, `auth`, `timeoutMs` (default 300 000), `maxRetries` (default 3, at most 6), `maxOutput` (a cap on the output tokens asked for, default 16 000; the runtime asks for what is left of the agent's budget, which can be more than a model allows), `caFile`, and per provider `anthropicVersion`; `flavour`, `deployment`, `apiVersion`, `outputLimitField` (`max_tokens` or `max_completion_tokens`); `region`. A setting a provider doesn't read is refused with the list it does read. Setting names avoid the words C6 already refuses as secret-like (`token`, `apikey`, `secret`, ...): `keyEnv` and `maxOutput` rather than `apiKeyEnv` and `maxOutputTokens`.

**Keys never go in runtime.yaml, and never reach a message.**

- `keyEnv` is the _name_ of an environment variable; the provider reads the key from the environment when the runtime is built. A missing or empty variable stops the command with a message naming the variable.
- Every string setting is checked for the look of a key: known key shapes (`sk-...`, AWS access key ids), `Bearer ...`/`Basic ...` values, JWTs, URLs with a password or a key, token or signature in the query, and long opaque strings (mixed case with digits, or long hex). A hit stops the command; the message names the setting, never the value.
- Error messages are built from fixed sentences (the package's copy file, `src/messages.ts`) plus the host, the model and the variable's name. The provider's own error text, when quoted, is cut to 300 characters, has the key and the AWS secrets replaced by `***`, and goes through the log's redaction (`redactText`). The key is held in a `#private` field, so inspecting or logging a provider shows neither the key nor the environment.
- `baseUrl` must be `https://`; plain `http://` is accepted only for this machine (`localhost`, `127.0.0.1`, `[::1]`), since prompts carry the organisation's material. There is no setting to allow plain HTTP elsewhere. A `baseUrl` with a user name or password is refused.

**The network.** The real transport is undici's `fetch` (undici, MIT, added as a dependency; Node's built-in `fetch` doesn't read proxy variables before Node 24).

- Proxy: `https_proxy`/`HTTPS_PROXY` for https URLs, then `http_proxy`/`HTTP_PROXY`; `http_proxy`/`HTTP_PROXY` for http URLs; lower-case names first. `NO_PROXY`/`no_proxy` (hosts, `.suffix`, `*.suffix`, `host:port`, bracketed IPv6, `*`) wins. CIDR ranges are not read. Credentials in the proxy URL are sent to the proxy as Basic auth and never printed. The proxy is used with CONNECT tunnels.
- Certificates: Node trusts `NODE_EXTRA_CA_CERTS` for every connection when it starts. `caFile` adds a PEM file for model calls only; when it is set, Atticus passes Node's bundled roots, `NODE_EXTRA_CA_CERTS` and the file together, so naming one never drops the others. TLS verification is never turned off.
- Timeouts: `timeoutMs` covers the whole request (headers and body). The caller's `AbortSignal` cancels the request and any wait between retries.
- Retries: 408, 429, 500, 502, 503, 504 and 529, and a dropped connection (`ECONNRESET`, `EPIPE`, undici socket errors), at most `maxRetries` times, with exponential backoff from 1 s doubling to a 30 s cap with equal jitter. `Retry-After` (seconds or an HTTP date) and Azure's `retry-after-ms` are honoured; one longer than 60 s stops the retries with a message rather than waiting. A timeout is not retried (the request may have been billed), nor is any other 4xx. Bedrock requests are signed again for each try.
- Messages say what to change: 401/403 "check that the environment variable X holds a valid key" (Bedrock: the AWS variables, `bedrock:InvokeModel` and model access); 404 "check the model (or deployment) and baseUrl"; 400 carries the provider's own words; 429 after the retries; 5xx; a timeout; the proxy refusing the tunnel (407 means it wants credentials), an unreachable proxy, an untrusted certificate (with `NODE_EXTRA_CA_CERTS`), an unreachable host (with `HTTPS_PROXY`), and an answer that isn't JSON (a login page).

**Answers.** The text is the concatenated text blocks (Anthropic, Bedrock) or the first choice's content (Chat Completions). Usage is the response's token counts: Anthropic `input_tokens` plus cache creation and cache read tokens, and `output_tokens`; Chat Completions `prompt_tokens` and `completion_tokens`; Bedrock `inputTokens` and `outputTokens`. Only when an OpenAI-compatible server leaves usage out is it estimated as before. An answer cut off at the output limit (`max_tokens`, `length`) or declined (`refusal`, `content_filter`, `guardrail_intervened`, `content_filtered`) fails the run with a message; Atticus never uses half an artifact.

**Contract changes, both additive (no schema version bump, no migration):**

- C5: `@maycombhq/ai` exports `registerModelProvider(type, factory)`, `registeredModelProviders()`, `clearModelProviders()` (tests) and the `ModelProviderFactory` type. `createRuntime` looks for a provider in `providers` passed in, then the registered ones, then the built-in `mock`. `mock` can't be registered over. `ModelProvider` is unchanged.
- C6: `adapters.model.type` gains `openai-compatible`. Every existing runtime.yaml stays valid.

**Unchanged:** every check in front of a model call. `ai: off` refuses model mode before a provider is built; `models.allowed` refuses a model it doesn't list; `modes.allowed` must list `model`; text-only is kept (providers send text, never images); the data rule stays in the system prompt; CI and tests never call a model (every test injects a transport or uses a server on 127.0.0.1 inside the test).

**An organisation's own provider** keeps the plugin shape: code that calls `registerModelProvider("house-gateway", factory)` (or passes `providers` to `createRuntime`) and a runtime.yaml type for it. C6 lists the types it accepts, so a new type name still needs a C6 change; replacing a built-in under its own name (for example `anthropic` with a house client) does not. There is no loader yet that picks up a plugin package from configuration (Phase 4 in `docs/build-status.md`).

## Consequences

- `modes.default: model` works with Anthropic, Azure OpenAI, an internal gateway or vLLM, and Bedrock, behind a corporate proxy and TLS inspection, with nothing to install beyond the bundle.
- Security review has one place to read: the package is small, has one third-party dependency (undici), and its tests show the key is absent from messages, inspected objects and run records.
- Not built: streaming (one request per step, so a very long answer can hit `timeoutMs`; raise it), Vertex AI, Bedrock with AWS profiles, SSO or instance roles (only the environment variables are read; `aws configure export-credentials --format env` gives them), Bedrock API keys, Azure managed identity (a token must be put in the variable), images, tools, and prompt caching. None of these providers has been called against a real endpoint from this repo; the request shapes come from the providers' published API references and the SigV4 code passes AWS's published test vectors.
