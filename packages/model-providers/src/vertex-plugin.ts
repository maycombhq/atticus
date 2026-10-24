/**
 * Google Vertex AI as a model-provider plugin (ADR 0121 item 4): the first one Atticus ships,
 * copied into an org pack by `atticus plugin add vertex`, then reviewed and pinned there like
 * any plugin (`atticus plugin pin vertex`). Its files are kept here as text so the command line
 * carries them wherever it is installed.
 *
 * It speaks two of Vertex's APIs, chosen by the model's name: Anthropic's models through
 * `rawPredict` (the Messages API with Vertex's anthropic_version), and Google's own (Gemini)
 * through `generateContent`. The key is an OAuth access token for a service account that may
 * call Vertex, in the variable keyEnv names; Atticus sends it as `Authorization: Bearer`. Such a
 * token lasts about an hour, so it is refreshed outside Atticus (for example by the job that
 * starts the run): Atticus doesn't sign in to Google itself.
 */

const PLUGIN_YAML = `# Google Vertex AI (ADR 0121 item 4). Review index.js, then: atticus plugin pin vertex
schemaVersion: 1
id: vertex
version: 1.0.0
description: >-
  Google Vertex AI: Anthropic's models through rawPredict and Google's through generateContent.
  The key is an OAuth access token in the variable keyEnv names.
entry: index.js
settings: [project, region]
hosts:
  - "{region}-aiplatform.googleapis.com"
  - aiplatform.googleapis.com
auth: bearer
`;

const INDEX_JS = `// Google Vertex AI (ADR 0121 item 4). Pure translation: no imports, no network, no clock.
// Atticus sends the request this builds, to the hosts plugin.yaml names, with the key added.

const anthropic = (model) => /^claude/i.test(model);

function base(s) {
  if (!s.project) throw new Error("adapters.model.settings.project is missing (the Google Cloud project id)");
  if (!s.region) throw new Error("adapters.model.settings.region is missing (for example europe-west1, or global)");
  const host = s.region === "global" ? "aiplatform.googleapis.com" : s.region + "-aiplatform.googleapis.com";
  return "https://" + host + "/v1/projects/" + s.project + "/locations/" + s.region + "/publishers/";
}

export default {
  id: "vertex",
  version: "1.0.0",

  request(i) {
    const at = base(i.settings);
    if (anthropic(i.model))
      return {
        url: at + "anthropic/models/" + i.model + ":rawPredict",
        body: {
          anthropic_version: "vertex-2023-10-16",
          max_tokens: i.maxOutputTokens,
          system: i.system,
          messages: [{ role: "user", content: i.prompt }],
        },
      };
    return {
      url: at + "google/models/" + i.model + ":generateContent",
      body: {
        systemInstruction: { parts: [{ text: i.system }] },
        contents: [{ role: "user", parts: [{ text: i.prompt }] }],
        generationConfig: { maxOutputTokens: i.maxOutputTokens },
      },
    };
  },

  response(a) {
    if (Array.isArray(a.content)) {
      const text = a.content.filter((b) => b && b.type === "text").map((b) => b.text).join("");
      const u = a.usage || {};
      return {
        text,
        cutOff: a.stop_reason === "max_tokens",
        declined: a.stop_reason === "refusal" ? "refusal" : undefined,
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
      };
    }
    const c = (a.candidates || [])[0] || {};
    const parts = (c.content && c.content.parts) || [];
    const u = a.usageMetadata || {};
    const blocked = a.promptFeedback && a.promptFeedback.blockReason;
    return {
      text: parts.map((p) => p.text || "").join(""),
      cutOff: c.finishReason === "MAX_TOKENS",
      declined: blocked || (c.finishReason === "SAFETY" ? "safety" : undefined),
      inputTokens: u.promptTokenCount,
      outputTokens: u.candidatesTokenCount,
    };
  },
};
`;

const input = (model: string, region = "europe-west1") =>
  JSON.stringify(
    {
      model,
      system: "You are the architect agent.",
      prompt: "Draft the design.",
      maxOutputTokens: 4000,
      settings: { project: "forge-platform", region },
    },
    null,
    2,
  ) + "\n";

const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";

/** The plugin's files, by path inside its folder: the code, the manifest and its golden tests. */
export const VERTEX_PLUGIN: Record<string, string> = {
  "plugin.yaml": PLUGIN_YAML,
  "index.js": INDEX_JS,
  "test/claude/request.json": input("claude-opus-5-5"),
  "test/claude/expected-request.json": json({
    url: "https://europe-west1-aiplatform.googleapis.com/v1/projects/forge-platform/locations/europe-west1/publishers/anthropic/models/claude-opus-5-5:rawPredict",
    body: {
      anthropic_version: "vertex-2023-10-16",
      max_tokens: 4000,
      system: "You are the architect agent.",
      messages: [{ role: "user", content: "Draft the design." }],
    },
  }),
  "test/claude/answer.json": json({
    content: [{ type: "text", text: "Forge Pay calls Northwind Pay." }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1200, output_tokens: 42 },
  }),
  "test/claude/expected-answer.json": json({
    text: "Forge Pay calls Northwind Pay.",
    cutOff: false,
    inputTokens: 1200,
    outputTokens: 42,
  }),
  "test/gemini/request.json": input("gemini-2.5-pro", "global"),
  "test/gemini/expected-request.json": json({
    url: "https://aiplatform.googleapis.com/v1/projects/forge-platform/locations/global/publishers/google/models/gemini-2.5-pro:generateContent",
    body: {
      systemInstruction: { parts: [{ text: "You are the architect agent." }] },
      contents: [{ role: "user", parts: [{ text: "Draft the design." }] }],
      generationConfig: { maxOutputTokens: 4000 },
    },
  }),
  "test/gemini/answer.json": json({
    candidates: [
      {
        content: { parts: [{ text: "Forge Pay calls " }, { text: "Northwind Pay." }] },
        finishReason: "MAX_TOKENS",
      },
    ],
    usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 4000 },
  }),
  "test/gemini/expected-answer.json": json({
    text: "Forge Pay calls Northwind Pay.",
    cutOff: true,
    inputTokens: 900,
    outputTokens: 4000,
  }),
};

/** The plugins `atticus plugin add` can copy into an org pack. */
export const SHIPPED_MODEL_PROVIDER_PLUGINS: Record<string, Record<string, string>> = {
  vertex: VERTEX_PLUGIN,
};
