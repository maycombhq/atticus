/**
 * ADR 0202 point 10: the fixed words of the shape card, and of the invented estate made from it.
 *
 * `atticus selfcheck` describes the estate it ran on with these words and no others: a size band
 * for its repos and its records, which shape flags are present, the platform, and the slowest
 * step in a time band. The card holds no name, id, path, hash, count or free text of the estate,
 * so its words can be read off a screen and typed elsewhere from memory. The invented Forge
 * estate of the tests (`packages/cli/test/field-estate.ts`) takes the same words as its `shape`
 * and as `ATTICUS_FIELD_SHAPE`, and makes an estate of that shape from Forge names.
 *
 * Nothing here reads a file. Whether even these words may be said outside a site is that
 * organisation's decision.
 */

export const REPO_BANDS = ["1-5", "6-20", "21-50", "51-100", "over-100"] as const;
export const RECORD_BANDS = ["under-1k", "1k-10k", "10k-50k", "50k-200k", "over-200k"] as const;
export const SHAPE_FLAGS = [
  "gateway-proxies",
  "deploy-token-hosts",
  "repos-with-no-system",
  "dotted-ids",
  "nested-payloads",
  "ssh-origins",
  "https-origins",
  "non-gateway-callee",
  "legacy-slots",
  "hand-pairings",
  "empty-repo",
  "unread-repo",
] as const;
export const PLATFORMS = ["windows", "macos", "linux"] as const;
export const STEPS = ["sync", "read", "verify", "build", "scan", "other", "none"] as const;
export const TIME_BANDS = ["under-5s", "5-30s", "30s-2m", "2-10m", "over-10m"] as const;

export type RepoBand = (typeof REPO_BANDS)[number];
export type RecordBand = (typeof RECORD_BANDS)[number];
export type ShapeFlag = (typeof SHAPE_FLAGS)[number];
export type Platform = (typeof PLATFORMS)[number];
export type Step = (typeof STEPS)[number];
export type TimeBand = (typeof TIME_BANDS)[number];

/** What an invented estate is made from: the card's first three lines. */
export interface Shape {
  repos: RepoBand;
  records: RecordBand;
  flags: ShapeFlag[];
}

/** The whole card. `slowest.time` is left out when no step is on record (`none`). */
export interface ShapeCard extends Shape {
  platform: Platform;
  slowest: { step: Step; time?: TimeBand };
}

/** Every word a card may hold: its lines' names, and the words above. */
export const CARD_WORDS: ReadonlySet<string> = new Set<string>([
  "repos",
  "records",
  "flags",
  "platform",
  "slowest",
  "step",
  ...REPO_BANDS,
  ...RECORD_BANDS,
  ...SHAPE_FLAGS,
  ...PLATFORMS,
  ...STEPS,
  ...TIME_BANDS,
]);

export const repoBand = (n: number): RepoBand =>
  n <= 5 ? "1-5" : n <= 20 ? "6-20" : n <= 50 ? "21-50" : n <= 100 ? "51-100" : "over-100";

export const recordBand = (n: number): RecordBand =>
  n < 1_000
    ? "under-1k"
    : n < 10_000
      ? "1k-10k"
      : n < 50_000
        ? "10k-50k"
        : n < 200_000
          ? "50k-200k"
          : "over-200k";

export const timeBand = (ms: number): TimeBand =>
  ms < 5_000
    ? "under-5s"
    : ms < 30_000
      ? "5-30s"
      : ms < 120_000
        ? "30s-2m"
        : ms < 600_000
          ? "2-10m"
          : "over-10m";

/** Node's platform in the card's words; anything that is neither Windows nor macOS is `linux`. */
export const platformWord = (p: string): Platform =>
  p === "win32" ? "windows" : p === "darwin" ? "macos" : "linux";

/** The flags in the list's own order, each once. */
export const orderedFlags = (flags: Iterable<ShapeFlag>): ShapeFlag[] => {
  const have = new Set(flags);
  return SHAPE_FLAGS.filter((f) => have.has(f));
};

/** The card as its five lines: a line's name, then words of the list only. */
export function cardLines(c: ShapeCard): string[] {
  return [
    `repos: ${c.repos}`,
    `records: ${c.records}`,
    `flags: ${c.flags.length ? orderedFlags(c.flags).join(" ") : "none"}`,
    `platform: ${c.platform}`,
    `slowest step: ${c.slowest.step}${c.slowest.time ? ` ${c.slowest.time}` : ""}`,
  ];
}

/** The shape as `ATTICUS_FIELD_SHAPE` takes it: its words, comma-separated, in the card's order. */
export const shapeText = (s: Shape): string =>
  [s.repos, s.records, ...orderedFlags(s.flags)].join(",");

/**
 * A shape from its words (commas or spaces between them; the card's other words, a platform or
 * a step and its time, are allowed and ignored). A word that is not on the list is refused: a
 * shape is only ever made of these words. A band left out is the smallest.
 */
export function parseShape(text: string): Shape {
  const shape: Shape = { repos: "1-5", records: "under-1k", flags: [] };
  for (const w of text.split(/[\s,;+]+/).filter(Boolean)) {
    const word = w.replace(/:$/, "");
    if ((REPO_BANDS as readonly string[]).includes(word)) shape.repos = word as RepoBand;
    else if ((RECORD_BANDS as readonly string[]).includes(word)) shape.records = word as RecordBand;
    else if ((SHAPE_FLAGS as readonly string[]).includes(word)) shape.flags.push(word as ShapeFlag);
    else if (!CARD_WORDS.has(word))
      throw new Error(
        `"${word.slice(0, 40)}" is not a word of the shape card. Its words: ${[...REPO_BANDS, ...RECORD_BANDS, ...SHAPE_FLAGS].join(", ")}.`,
      );
  }
  shape.flags = orderedFlags(shape.flags);
  return shape;
}

/** The fixed size each band is made at: how many repos the manifests list in all. */
export const REPOS_AT: Record<RepoBand, number> = {
  "1-5": 4,
  "6-20": 12,
  "21-50": 40,
  "51-100": 70,
  "over-100": 120,
};

/** The fixed size each band is made at: about how many records the build makes. */
export const RECORDS_AT: Record<RecordBand, number> = {
  "under-1k": 500,
  "1k-10k": 4_000,
  "10k-50k": 14_000,
  "50k-200k": 80_000,
  "over-200k": 250_000,
};
