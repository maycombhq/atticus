import {
  ANSWERED_BY,
  differentThings,
  namedBeyondAnswer,
  SAME_QUESTION,
  type AnswerJudge,
  type AnsweredVerdict,
  type QuestionJudge,
  type SameVerdict,
} from "@maycombhq/core";
import { judge, type JudgeItem, type JudgeOptions, type JudgeSpec } from "./judge.js";

/**
 * The kinds of judgment Atticus asks (ADR 0117). Each is a closed question with its verdicts,
 * the texts it quotes, and the catalog fact that vetoes it before the model.
 */

/** Is a new question one already on file? (questions/, ADR 0089) */
export const SAME_QUESTION_SPEC: JudgeSpec = {
  kind: SAME_QUESTION,
  ask: "Does the new question ask what the existing question asks, so that a person's answer to the existing one answers the new one too?",
  verdicts: ["same", "narrower", "different"],
  means: {
    same: "they ask the same thing, in other words; one answer serves both",
    narrower: "the new one asks part of what the existing one asks, or the same about fewer things",
    different: "they ask different things, even if they share words or a line",
  },
  quote: "each",
  veto: (item) => {
    const why = differentThings(
      { question: item.texts.new ?? "" },
      { question: item.texts.existing ?? "" },
      String(item.inputs.repo ?? ""),
    );
    return why ? { verdict: "different", rule: "veto:different-ids" } : undefined;
  },
};

/** A judge for raiseQuestions' open pairs, through the AI runtime (model or replay). */
export function questionJudge(o: JudgeOptions): QuestionJudge {
  return async (pairs) => {
    const items: JudgeItem[] = pairs.map((p) => ({
      inputs: p.inputs,
      texts: { new: p.draft.question, existing: p.existing.question },
      facts: [
        `new cites ${p.draft.evidence.join(", ")}`,
        `existing cites ${p.existing.evidence.join(", ")}${p.existing.state === "answered" ? " (answered)" : ""}`,
      ],
    }));
    const r = await judge(SAME_QUESTION_SPEC, items, o);
    const out = new Map<string, SameVerdict>();
    for (const [k, v] of r.results) out.set(k, v.verdict as SameVerdict);
    return out;
  };
}

/**
 * Does a person's answer on file already decide a new question? (questions/, ADR 0117 addendum,
 * 2026-10-24) The same-question judgment reads two questions; this one reads the answer too, so a
 * draft that asks again what a person said, in other words, isn't put to them a second time.
 * The veto: the new question names an id, field, path or number neither the answered question
 * nor its answer names.
 */
export const ANSWERED_BY_SPEC: JudgeSpec = {
  kind: ANSWERED_BY,
  ask: "A person already answered the existing question with the answer given. Does that answer decide what the new question asks, so that asking the new question would ask the person again what they already said?",
  verdicts: ["yes", "no"],
  means: {
    yes: "the answer already says what the new question asks: it asks the same again in other words, or asks about something the answer settles",
    no: "the answer leaves what the new question asks open, or the new question is about something else",
  },
  quote: "one",
  quoteFrom: "answer",
  veto: (item) => {
    const names = namedBeyondAnswer(
      { question: item.texts.new ?? "" },
      { question: item.texts.existing ?? "", answer: item.texts.answer ?? "" },
      String(item.inputs.repo ?? ""),
    );
    return names.length ? { verdict: "no", rule: "veto:names-beyond-answer" } : undefined;
  },
};

/** A judge for raiseQuestions' answered-by pairs, through the AI runtime (model, headless or replay). */
export function answerJudge(o: JudgeOptions): AnswerJudge {
  return async (pairs) => {
    const items: JudgeItem[] = pairs.map((p) => ({
      inputs: p.inputs,
      texts: { new: p.draft.question, existing: p.answered.question, answer: p.answer },
      facts: [
        `new cites ${p.draft.evidence.join(", ")}`,
        `existing cites ${p.answered.evidence.join(", ")}`,
      ],
    }));
    const r = await judge(ANSWERED_BY_SPEC, items, o);
    const out = new Map<string, AnsweredVerdict>();
    for (const [k, v] of r.results) out.set(k, v.verdict as AnsweredVerdict);
    return out;
  };
}

/** Does an acceptance criterion check a field's value? (planner stories, ADR 0117) */
export const COVERS_FIELD_SPEC: JudgeSpec = {
  kind: "covers-field",
  // ADR 0117 addendum (V2): a criterion checks a field when its outcome depends on the field's
  // value, so a given that fixes the value and a then that follows from it counts. A mismatch
  // case (a refusal) is the stories format's own rule, never asked through this judge.
  ask: "Does the criterion's outcome depend on the value of the field named in the facts, so that a test written from it checks that field: its then clause states what the field holds, or states a result that follows from a value its given clause fixes?",
  verdicts: ["yes", "no"],
  means: {
    yes: "the then clause states the field's value, in its own name or in words that mean it, or a result that follows from a value its given clause fixes for the field",
    no: "the outcome doesn't depend on the field's value (naming the event or the record isn't enough, and a given value the then clause doesn't follow from isn't either)",
  },
  quote: "one",
};

/** Does a quoted span state a value? (knowledge values, ADR 0111, 0117) */
export const STATES_VALUE_SPEC: JudgeSpec = {
  kind: "states-value",
  ask: "Does the span, word for word from the page, state the value given in the facts for the field named there?",
  verdicts: ["yes", "no"],
  means: {
    yes: "the span says it: the same value, in its words or in other units that mean exactly it",
    no: "the span doesn't say it, says something else, or says it about something else",
  },
  quote: "one",
};

/** Does a process or request apply to a step of the change? (planner stories, ADR 0083) */
export const APPLIES_SPEC: JudgeSpec = {
  kind: "applies",
  ask: "Does the process's applies-when hold for the step, given the step's facts from the catalog?",
  verdicts: ["yes", "no"],
  means: {
    yes: "what the step does meets the applies-when clause",
    no: "the step doesn't meet it",
  },
  quote: "each",
};

// ---- the kinds of the ADR 0117 addendum (release, critic, readiness bar, knowledge facts)

/** A name written as a whole word in a text (not inside another word): a fact, not a reading. */
export function namesWord(text: string, word: string): boolean {
  if (!word) return false;
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_-])${esc}($|[^A-Za-z0-9_-])`, "i").test(text);
}

/**
 * Must an existing caller change for an API change? (release notes, ADR 0117 addendum)
 * Inputs: `change` (planned-new, planned-modify, planned-retire), `notes`. The veto is the
 * catalog's change kind: a retired operation breaks its callers, a new one has none yet.
 */
export const BREAKING_SPEC: JudgeSpec = {
  kind: "breaking",
  ask: "Given what interfaces.md says about the change to the operation in the facts, must a caller that uses the operation today change its code or handling to keep working?",
  verdicts: ["yes", "no"],
  means: {
    yes: "a caller must change: a field removed, renamed or now required, a new error or response it must handle, a changed meaning or format",
    no: "callers that use it today keep working unchanged: only optional additions, or nothing they see changes",
  },
  quote: "one",
  veto: (item) =>
    item.inputs.change === "planned-retire"
      ? { verdict: "yes", rule: "veto:retired-operation" }
      : item.inputs.change === "planned-new"
        ? { verdict: "no", rule: "veto:new-operation" }
        : undefined,
};

/**
 * Does a sentence say how to undo a deployment step? (release plan, ADR 0117 addendum)
 * Inputs: `sentence`, `step` (its key), `names` (the step's names: repo, tables, routes) and
 * `others` (the other steps' names). The veto: the sentence names another step and none of this
 * one's, so it is about that step.
 */
export const UNDOES_SPEC: JudgeSpec = {
  kind: "undoes",
  ask: "Does the sentence say how the deployment step in the facts is undone (rolled back, reverted, backed out) if the release goes wrong, or that it needs no undo and why?",
  verdicts: ["yes", "no"],
  means: {
    yes: "the sentence tells a person how to undo this step, or why it needs none (for example an expand-only migration)",
    no: "the sentence is about something else: the rollout order, another step, or what the change does",
  },
  quote: "one",
  veto: (item) => {
    const s = String(item.inputs.sentence ?? "");
    const own = (item.inputs.names as string[] | undefined) ?? [];
    const others = (item.inputs.others as string[] | undefined) ?? [];
    if (own.some((n) => namesWord(s, n))) return undefined;
    return others.some((n) => namesWord(s, n))
      ? { verdict: "no", rule: "veto:names-another-step" }
      : undefined;
  },
};

/**
 * Credentials written in a known token format: a fact (the shape is on the line), kept
 * deterministic. Words about secrets are a reading, and go to the judge.
 */
export const TOKEN_FORMATS: readonly { re: RegExp; what: string }[] = [
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: "a private key" },
  { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, what: "a cloud access key" },
  { re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/, what: "a Git host token" },
  { re: /\b(?:sk|xox[abp])-[A-Za-z0-9-]{20,}\b/, what: "an API token" },
  {
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/,
    what: "a signed token (JWT)",
  },
];

/** The token format a text holds, if any. */
export const tokenFormatIn = (text: string) => TOKEN_FORMATS.find((t) => t.re.test(text))?.what;

/**
 * Does a line of the change say a secret or credential is needed or touched? (security review
 * draft, ADR 0117 addendum) Inputs: `line`. The veto: a token in a known format is on the line.
 */
export const NAMES_SECRET_SPEC: JudgeSpec = {
  kind: "names-secret",
  ask: "Does the line say that the change needs, creates, uses, rotates or exposes a secret or credential (a key, certificate, password, token or client secret)?",
  verdicts: ["yes", "no"],
  means: {
    yes: "a reviewer of secrets should see this line: it names a credential the change needs or touches, or holds one",
    no: "it doesn't: the words may sound alike (a primary key, a token bucket, an account's key field) but no secret is involved",
  },
  quote: "one",
  veto: (item) =>
    tokenFormatIn(String(item.inputs.line ?? ""))
      ? { verdict: "yes", rule: "veto:token-format" }
      : undefined,
};

/** The fact a personal-data item carries when the column is classified personal already. */
export const CLASSIFIED_PERSONAL = "classified as personal data";

/**
 * A column for the personal-data judgment. The key is the column, its table and its type, so
 * the critic and the security review read the same judgment; whether it is classified personal
 * is a fact beside it, not part of the key.
 */
export function personalItem(c: {
  column: string;
  table: string;
  type?: string | undefined;
  classifiedPersonal?: boolean;
}): JudgeItem {
  return {
    inputs: { v: 1, column: c.column, table: c.table, ...(c.type ? { type: c.type } : {}) },
    texts: { column: c.column },
    facts: [
      `table: ${c.table}`,
      ...(c.type ? [`type: ${c.type}`] : []),
      ...(c.classifiedPersonal ? [CLASSIFIED_PERSONAL] : []),
    ],
  };
}

/**
 * Is a column personal data? (critic data classification, security review, ADR 0117
 * addendum) Inputs: `column`, `table`, `type`. The veto: the column is classified as personal
 * already (the catalog or data.md says so by name).
 */
export const PERSONAL_DATA_SPEC: JudgeSpec = {
  kind: "personal-data",
  ask: "Does the column hold personal data: data about a person who can be identified (a name, contact detail, address, date of birth, government id, account holder, or a value tied to one person)?",
  verdicts: ["yes", "no"],
  means: {
    yes: "the column holds data about an identifiable person, judged by its name, its table and its type",
    no: "it doesn't: an amount, a flag, a timestamp or an id of a thing, not a person, even if its name has a word that sounds personal",
  },
  quote: "one",
  veto: (item) =>
    item.facts?.includes(CLASSIFIED_PERSONAL)
      ? { verdict: "yes", rule: "veto:classified-personal" }
      : undefined,
};

/**
 * Does a definition-of-ready item ask for one of the readiness bar's checks? (planner bar,
 * ADR 0117 addendum) Inputs: `item`, `check`, and `known` (the checks of an item in Atticus's
 * own default wording, which Atticus wrote with its checks). The veto: the item is a default
 * one, so its checks are known, not read.
 */
export const ASKS_CHECK_SPEC: JudgeSpec = {
  kind: "asks-check",
  ask: "Does the definition-of-ready item ask for what the check in the facts tests in a story?",
  verdicts: ["yes", "no"],
  means: {
    yes: "a story that fails the check doesn't meet the item",
    no: "the item asks for something else; the check doesn't test it",
  },
  quote: "one",
  veto: (item) =>
    Array.isArray(item.inputs.known)
      ? {
          verdict: (item.inputs.known as string[]).includes(String(item.inputs.check))
            ? "yes"
            : "no",
          rule: "veto:default-item",
        }
      : undefined,
};

/**
 * How does one system reach another, by a wiki sentence? (knowledge facts, ADR 0117 addendum)
 * Inputs: `sentence`, `from`, `to`. No veto: which systems a sentence names is the mention
 * index's fact, and it chose the pair.
 */
export const REACHES_SPEC: JudgeSpec = {
  kind: "reaches",
  ask: "What does the sentence say about how the system 'from' in the facts reaches the system 'to'?",
  verdicts: ["gateway", "direct", "api-only", "none"],
  means: {
    gateway: "from calls to through the API gateway",
    direct: "from calls to directly, not through the gateway",
    "api-only": "from reads to's data only through to's API, never its tables",
    none: "the sentence says none of these about from and to (or says it is not so)",
  },
  quote: "one",
};
