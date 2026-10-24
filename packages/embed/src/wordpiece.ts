/**
 * A BERT WordPiece tokenizer (ADR 0116), read from a model's tokenizer.json: the normaliser
 * (clean the text, space around CJK characters, lower case, strip accents), the pre-tokenizer
 * (split at white space and punctuation) and the WordPiece model (longest match first, `##`
 * for a word's later pieces, the unknown token for a word it can't spell), then [CLS] … [SEP],
 * cut at the model's limit. Small and in-house so no tokenizer library (or its downloader)
 * ships; golden token ids test it against the model's own tokenizer.
 */

export interface WordPieceConfig {
  vocab: Map<string, number>;
  unk: string;
  prefix: string;
  maxCharsPerWord: number;
  lowercase: boolean;
  stripAccents: boolean;
  cls: string;
  sep: string;
}

interface TokenizerJson {
  normalizer?: { type?: string; lowercase?: boolean; strip_accents?: boolean | null } | null;
  model: {
    type: string;
    vocab: Record<string, number>;
    unk_token?: string;
    continuing_subword_prefix?: string;
    max_input_chars_per_word?: number;
  };
}

/** The config of a tokenizer.json; only BERT WordPiece models are read. */
export function wordPieceConfig(json: unknown): WordPieceConfig {
  const t = json as TokenizerJson;
  if (t?.model?.type !== "WordPiece")
    throw new Error(`the tokenizer is ${t?.model?.type ?? "unknown"}, not WordPiece`);
  const lowercase = t.normalizer?.lowercase ?? true;
  return {
    vocab: new Map(Object.entries(t.model.vocab)),
    unk: t.model.unk_token ?? "[UNK]",
    prefix: t.model.continuing_subword_prefix ?? "##",
    maxCharsPerWord: t.model.max_input_chars_per_word ?? 100,
    lowercase,
    // BertNormalizer: strip_accents null means "as lowercase".
    stripAccents: t.normalizer?.strip_accents ?? lowercase,
    cls: "[CLS]",
    sep: "[SEP]",
  };
}

const isControl = (c: string) => {
  if (c === "\t" || c === "\n" || c === "\r") return false;
  return /\p{Cc}|\p{Cf}/u.test(c);
};
const isWhite = (c: string) => /\s/u.test(c);
const isPunct = (c: string) => {
  const cp = c.codePointAt(0)!;
  if (
    (cp >= 33 && cp <= 47) ||
    (cp >= 58 && cp <= 64) ||
    (cp >= 91 && cp <= 96) ||
    (cp >= 123 && cp <= 126)
  )
    return true;
  return /\p{P}/u.test(c);
};
const isCjk = (cp: number) =>
  (cp >= 0x4e00 && cp <= 0x9fff) ||
  (cp >= 0x3400 && cp <= 0x4dbf) ||
  (cp >= 0x20000 && cp <= 0x2a6df) ||
  (cp >= 0x2a700 && cp <= 0x2b73f) ||
  (cp >= 0x2b740 && cp <= 0x2b81f) ||
  (cp >= 0x2b820 && cp <= 0x2ceaf) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0x2f800 && cp <= 0x2fa1f);

/** The text as the normaliser leaves it. */
export function normalize(text: string, c: WordPieceConfig): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0 || cp === 0xfffd || isControl(ch)) continue;
    if (isWhite(ch)) out += " ";
    else if (isCjk(cp)) out += ` ${ch} `;
    else out += ch;
  }
  if (c.lowercase) out = out.toLowerCase();
  if (c.stripAccents) out = out.normalize("NFD").replace(/\p{Mn}/gu, "");
  return out;
}

/** The words the pre-tokenizer splits a normalised text into. */
export function preTokenize(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const ch of text) {
    if (isWhite(ch)) {
      if (cur) out.push(cur);
      cur = "";
    } else if (isPunct(ch)) {
      if (cur) out.push(cur);
      out.push(ch);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** One word's pieces, longest match first; the unknown token for a word it can't spell. */
export function wordPieces(word: string, c: WordPieceConfig): string[] {
  const chars = [...word];
  if (chars.length > c.maxCharsPerWord) return [c.unk];
  const out: string[] = [];
  let start = 0;
  while (start < chars.length) {
    let end = chars.length;
    let found: string | undefined;
    while (start < end) {
      const sub = `${start > 0 ? c.prefix : ""}${chars.slice(start, end).join("")}`;
      if (c.vocab.has(sub)) {
        found = sub;
        break;
      }
      end--;
    }
    if (!found) return [c.unk];
    out.push(found);
    start = end;
  }
  return out;
}

/** A text's token ids: [CLS], its pieces, [SEP], at most maxTokens in all. */
export function encode(text: string, c: WordPieceConfig, maxTokens: number): number[] {
  const ids: number[] = [c.vocab.get(c.cls)!];
  const unk = c.vocab.get(c.unk)!;
  outer: for (const w of preTokenize(normalize(text, c)))
    for (const p of wordPieces(w, c)) {
      if (ids.length >= maxTokens - 1) break outer;
      ids.push(c.vocab.get(p) ?? unk);
    }
  ids.push(c.vocab.get(c.sep)!);
  return ids;
}
