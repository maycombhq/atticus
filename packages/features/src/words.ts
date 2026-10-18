/**
 * Words in code signals: path segments, topics, class and job names. Features are grouped and
 * named from these, so the rules are small and predictable: split on punctuation and camel
 * case, lower-case, drop words that say nothing about the business (api, v1, controller...).
 */

/** Path prefixes and technical words that never name a feature. */
const NOISE = new Set([
  "api",
  "apis",
  "rest",
  "public",
  "internal",
  "private",
  "ext",
  "external",
  "service",
  "services",
  "svc",
  "controller",
  "controllers",
  "endpoint",
  "endpoints",
  "resource",
  "resources",
  "handler",
  "handlers",
  "client",
  "clients",
  "listener",
  "listeners",
  "consumer",
  "consumers",
  "subscriber",
  "publisher",
  "producer",
  "impl",
  "app",
  "application",
  "main",
  "src",
  "java",
  "kt",
  "ts",
  "js",
  "py",
  "go",
  "cs",
  "event",
  "events",
  "message",
  "messages",
  "topic",
  "topics",
  "the",
  "a",
  "an",
  "of",
  "and",
  "for",
  "to",
  "by",
  "on",
  "in",
]);

/** Words that end a job, task or class name and say what it is, not what it does. */
const SUFFIXES = new Set([
  "job",
  "jobs",
  "task",
  "tasks",
  "batch",
  "scheduler",
  "schedule",
  "runner",
  "worker",
  "cron",
]);

/** Verbs that start an operation or method name. */
const VERBS = new Set([
  "get",
  "list",
  "find",
  "fetch",
  "search",
  "create",
  "add",
  "post",
  "put",
  "update",
  "patch",
  "delete",
  "remove",
  "run",
  "execute",
  "process",
  "handle",
  "start",
  "perform",
  "do",
  "on",
]);

/** Past tenses on event topics: payments.initiated is about payments. */
const STATES = new Set([
  "initiated",
  "completed",
  "created",
  "updated",
  "deleted",
  "changed",
  "requested",
  "failed",
  "succeeded",
  "processed",
  "received",
  "sent",
  "started",
  "finished",
  "cancelled",
  "canceled",
  "approved",
  "rejected",
]);

/** Split any identifier or text into lower-case words: "DailyEntriesJob" → daily, entries, job. */
export function splitWords(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0 && !/^\d+$/.test(w));
}

/** A simple English singular, enough to match "entries" with the entry table. */
export function singular(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(sses|xes|ches|shes)$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !/(ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

const isVersion = (w: string) => /^v\d+$/.test(w);

/** Words of a REST path's fixed segments: /api/v1/accounts/{id}/balance → accounts, balance. */
export function pathWords(path: string): string[] {
  return path
    .split("/")
    .filter((s) => s && !/^[{:<$]/.test(s) && s !== "{}")
    .flatMap(splitWords)
    .filter((w) => !NOISE.has(w) && !isVersion(w));
}

/** Words of an event topic, without its state: payments.initiated → payments. */
export function topicWords(topic: string): string[] {
  return splitWords(topic).filter((w) => !NOISE.has(w) && !STATES.has(w) && !isVersion(w));
}

/** Words of a class or job name: DailyEntriesJob → daily, entries. */
export function nameWords(name: string): string[] {
  const words = splitWords(name).filter((w) => !NOISE.has(w) && !isVersion(w));
  while (words.length > 1 && VERBS.has(words[0]!)) words.shift();
  return words.filter((w) => !SUFFIXES.has(w) && !(words.length > 1 && VERBS.has(w)));
}

/** The class a source file holds, from its name: src/.../BalanceController.java → BalanceController. */
export function classOf(path: string): string | undefined {
  const file = path.split("/").pop() ?? "";
  const stem = file.replace(/\.[^.]+$/, "");
  return /^[A-Z][A-Za-z0-9]*$/.test(stem) ? stem : undefined;
}

/** Words for matching: singular, without noise. */
export function tokens(words: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const w of words) if (!NOISE.has(w) && !VERBS.has(w)) out.add(singular(w));
  return out;
}

export const overlaps = (a: Set<string>, b: Set<string>): boolean => {
  for (const x of a) if (b.has(x)) return true;
  return false;
};

/**
 * Resource words of a path: every segment singular but the last, as a collection segment
 * comes before what it holds: /accounts/{id}/balance → account, balance.
 */
export const resourceOfPath = (words: string[]): string[] =>
  words.map((w, i) => (i < words.length - 1 ? singular(w) : w));

/** A feature name from resource words, first letter capital. */
export function displayName(words: string[]): string {
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A record-id-safe slug from resource words, kept short enough for a record id. */
export function slugOf(words: string[]): string {
  const s = words
    .join("-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return s.slice(0, 100).replace(/-$/, "") || "unnamed";
}
