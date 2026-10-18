import type { Runtime } from "@maycombhq/core";

/**
 * The critic runs in a fresh session and, when the org pack allows more than one model, on a
 * different model family from the one that wrote the artifacts, so it doesn't share the
 * author's blind spots. Families are read from model names ("claude-…", "gpt-…", "gemini-…",
 * or a provider prefix such as "bedrock/…").
 */
export interface ModelChoice {
  model?: string;
  family?: string;
  authorFamily?: string;
  /** True when a model of another family was available and chosen. */
  differentFamily: boolean;
  note: string;
}

export function modelFamily(model: string): string {
  const name = model.toLowerCase().split("/").pop()!;
  return name.split(/[-_.:@\d]/)[0] || name;
}

export function criticModel(runtime: Runtime, authorModel?: string): ModelChoice {
  const allowed = runtime.models.allowed;
  const recommended = runtime.models.recommended.critic;
  const authorFamily = authorModel ? modelFamily(authorModel) : undefined;
  if (allowed.length === 0)
    return {
      ...(recommended ? { model: recommended, family: modelFamily(recommended) } : {}),
      ...(authorFamily ? { authorFamily } : {}),
      differentFamily: false,
      note: "runtime.yaml allows no models; the critic runs on the person's own assistant (hand-off) or a replay.",
    };
  const other = authorFamily ? allowed.filter((m) => modelFamily(m) !== authorFamily) : [];
  const pick =
    (recommended && other.includes(recommended) ? recommended : other[0]) ??
    (recommended && allowed.includes(recommended) ? recommended : allowed[0]!);
  const differentFamily = !!authorFamily && modelFamily(pick) !== authorFamily;
  return {
    model: pick,
    family: modelFamily(pick),
    ...(authorFamily ? { authorFamily } : {}),
    differentFamily,
    note: differentFamily
      ? `The critic uses ${pick}, a different family from the author's ${authorModel}.`
      : authorFamily
        ? `runtime.yaml allows only the author's model family (${authorFamily}); the critic still runs in a fresh session.`
        : `The critic uses ${pick} in a fresh session.`,
  };
}
