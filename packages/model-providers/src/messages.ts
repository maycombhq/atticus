/**
 * Every sentence the model providers say to a person (the copy for this package). Each one
 * says what happened and what to change. None of them takes a key: a key never reaches a
 * message, so it can't reach a log or a screen.
 */

export interface Where {
  /** The provider's name for people: "Anthropic", "Azure OpenAI", "the OpenAI-compatible endpoint", "AWS Bedrock". */
  provider: string;
  /** The host Atticus called (no path, no query). */
  host: string;
  model: string;
  /** The environment variable that holds the key, when the provider uses one. */
  keyEnv?: string;
  /** What to check for credentials when there is no key variable (Bedrock). */
  credentials?: string;
  /** What "the model" is called in this provider's settings: "model" or "deployment". */
  modelSetting?: string;
  /** The proxy used, credentials removed, when there was one. */
  proxy?: string;
}

const keyHint = (w: Where) =>
  w.keyEnv
    ? `Check that the environment variable ${w.keyEnv} holds a valid key for ${w.host}`
    : (w.credentials ?? "Check the credentials for this endpoint");

export const copy = {
  // ---------------------------------------------------------------- settings (config errors)
  unknownSetting: (provider: string, name: string, known: readonly string[]) =>
    `runtime.yaml adapters.model.settings has ${name}, which the ${provider} model provider doesn't read. It reads: ${known.join(", ")}.`,
  missingSetting: (provider: string, name: string, example: string) =>
    `The ${provider} model provider needs adapters.model.settings.${name} in runtime.yaml (for example ${name}: ${example}).`,
  badSetting: (provider: string, name: string, what: string) =>
    `adapters.model.settings.${name} for the ${provider} model provider ${what}.`,
  literalKey: (provider: string, name: string) =>
    `adapters.model.settings.${name} for the ${provider} model provider looks like a key or token itself. A key never goes in runtime.yaml: put it in an environment variable and give that variable's name as keyEnv (for example keyEnv: ATTICUS_MODEL_KEY).`,
  keyEnvName: (provider: string) =>
    `adapters.model.settings.keyEnv for the ${provider} model provider must be the name of an environment variable (letters, digits and _, for example ATTICUS_MODEL_KEY), not the key.`,
  keyEnvUnset: (provider: string, keyEnv: string) =>
    `The ${provider} model provider reads its key from ${keyEnv}, which is set neither in the environment nor in this machine's credential store. Keep it there with atticus secret set ${keyEnv} (or the AI tab's "Set the key on this machine"), or set the environment variable; the key never goes in runtime.yaml.`,
  plainHttp: (provider: string, url: string) =>
    `The ${provider} model provider only calls https:// addresses (prompts carry your organisation's material), and ${url} isn't one. Plain http:// is accepted only for this machine (localhost or 127.0.0.1).`,
  awsUnset: (missing: readonly string[]) =>
    `AWS Bedrock reads its credentials from the standard AWS environment variables, and ${missing.join(" and ")} ${missing.length === 1 ? "isn't" : "aren't"} set. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (and AWS_SESSION_TOKEN for temporary credentials) in the environment that runs Atticus.`,
  awsNoRegion: () =>
    "AWS Bedrock needs a region: set adapters.model.settings.region in runtime.yaml (for example region: us-east-1), or AWS_REGION in the environment.",
  caFileUnreadable: (file: string) =>
    `The CA certificate file ${file} (adapters.model.settings.caFile or NODE_EXTRA_CA_CERTS) can't be read. Check the path and that it holds PEM certificates.`,
  badProxy: (name: string) =>
    `The proxy in ${name} isn't a valid address (it should look like http://proxy.example:8080).`,

  // ---------------------------------------------------------------- calls (run errors)
  unauthorized: (w: Where, status: number) =>
    `${w.provider} at ${w.host} refused the credentials (HTTP ${status}). ${keyHint(w)}, and that it may use the model ${w.model}.`,
  notFound: (w: Where) =>
    `${w.provider} at ${w.host} has no ${w.modelSetting ?? "model"} called ${w.model} (HTTP 404). Check adapters.model.settings.${w.modelSetting ?? "model"} and baseUrl in runtime.yaml.`,
  badRequest: (w: Where, status: number, detail: string) =>
    `${w.provider} at ${w.host} rejected the request (HTTP ${status})${detail ? `: ${detail}` : ""}. Check the model settings in runtime.yaml (maxOutput is a common cause).`,
  rateLimited: (w: Where, tries: number) =>
    `${w.provider} at ${w.host} kept asking Atticus to slow down (HTTP 429) after ${tries} ${tries === 1 ? "try" : "tries"}. Wait a few minutes and run it again, or ask for a higher rate limit.`,
  waitTooLong: (w: Where, seconds: number) =>
    `${w.provider} at ${w.host} asked Atticus to wait ${seconds} seconds before trying again, which is longer than Atticus waits. Run it again later.`,
  serverError: (w: Where, status: number, tries: number) =>
    `${w.provider} at ${w.host} failed with HTTP ${status} after ${tries} ${tries === 1 ? "try" : "tries"}. The service may be down; run it again later.`,
  otherStatus: (w: Where, status: number, detail: string) =>
    `${w.provider} at ${w.host} answered HTTP ${status}${detail ? `: ${detail}` : ""}.`,
  timeout: (w: Where, seconds: number) =>
    `${w.provider} at ${w.host} didn't answer within ${seconds} second${seconds === 1 ? "" : "s"}. Run it again, or raise adapters.model.settings.timeoutMs.`,
  proxyRefused: (w: Where, detail: string) =>
    `The proxy ${w.proxy ?? ""} refused to connect Atticus to ${w.host} (${detail}). Check HTTPS_PROXY, the proxy's credentials (HTTP 407 means it wants them) and that it allows ${w.host}; or add ${w.host} to NO_PROXY.`,
  proxyUnreachable: (w: Where, code: string) =>
    `Atticus couldn't reach the proxy ${w.proxy ?? ""} (${code}). Check HTTPS_PROXY and HTTP_PROXY.`,
  unreachable: (w: Where, code: string) =>
    `Atticus couldn't reach ${w.host} (${code}). Check baseUrl in runtime.yaml and the network; behind a corporate proxy, set HTTPS_PROXY.`,
  untrustedCert: (w: Where, code: string) =>
    `Atticus doesn't trust the certificate ${w.host} presented (${code}). If your organisation inspects TLS with its own certificate authority, point NODE_EXTRA_CA_CERTS (or adapters.model.settings.caFile) at that CA's PEM file.`,
  notJson: (w: Where) =>
    `${w.provider} at ${w.host} answered with something that isn't the expected JSON. Check baseUrl: it may point at a login page or a different service.`,
  noText: (w: Where) => `${w.provider} at ${w.host} answered with no text.`,
  cutOff: (w: Where, max: number) =>
    `${w.provider} stopped the answer at the output limit (${max} tokens), so it is incomplete and Atticus doesn't use it. Raise adapters.model.settings.maxOutput, or make the step smaller.`,
  declined: (w: Where, reason: string) =>
    `${w.provider} declined to answer (${reason}). Nothing was written; a person can do this step, or hand it off.`,
};
