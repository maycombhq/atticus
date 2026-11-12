/**
 * Which lines of a C-family or PHP file are all comment, read by a small lexer in one pass over
 * the file (fifth review of ADR 0196). A regex per line opened a block comment on a `/*` inside a
 * string (`"rm -rf build /*"`, `"SELECT a /*+ FIRST_ROWS"`) or after `;//`, and read the rest of
 * the file as comment, so a live route below it was refused. The lexer keeps its state across
 * lines: a line comment, a block comment (nested where the language nests them: Kotlin, Rust,
 * Swift, Scala, Dart), a string in `"` or `'` (to the line's end, or past it after a `\`), a
 * JavaScript or TypeScript template literal across lines with `${…}` inside it (braces counted, so
 * an object or a nested template in it is read), a Go raw string, a Java, Kotlin, Scala, Swift,
 * Dart, Groovy or C# triple-quoted string, a C# verbatim string, a JavaScript regex literal, a Rust
 * char (not a lifetime), and escapes. A line is comment when it has a comment on it and every other
 * character on it outside one is a space or one of `{ } ( ) ,` (a JSX comment, `{/* … *\/}`, and the
 * `{/*` and `*\/}` lines of one across lines). Linear in the file's length.
 *
 * Kept from the regex it replaces: a line that starts with a doc block's `*` (` * text`, ` *\/`)
 * outside any block the lexer saw is read as a doc block's line (its opening was missed), for that
 * line only. In PHP a doc block's line that carries an annotation the framework reads (Symfony's
 * `@Route(`, `@Method(`, FOSRest's `@Rest\Get(` and `@Get(`…, API Platform's `@ApiResource(`,
 * Doctrine's `@ORM\…`) is code: the annotation is live, as a PHP 8 attribute is.
 *
 * Not read: C++ raw strings (`R"(…)"`), Swift's `#"…"#`, PHP heredocs and `?>` (HTML after it is read
 * as PHP), Groovy's slashy strings, a string an interpolation nests inside another string's
 * interpolation outside JavaScript (Kotlin's `"${m["k"]}"`). Each of these can misread the lines
 * it spans and, when it holds an unclosed `/*`, those after it up to the next `*\/`.
 */

/** What the lexer reads in a file, by its language. */
export interface CommentLexis {
  /** `//` starts a line comment (not in plain CSS, where `url(//cdn…)` is no comment). */
  slashSlash: boolean;
  /** `#` starts a line comment, `#[` doesn't (PHP). */
  hash: boolean;
  /** Block comments nest (Kotlin, Rust, Swift, Scala, Dart). */
  nest: boolean;
  /** Template literals with `${…}` and regex literals (JavaScript, TypeScript). */
  js: boolean;
  /** A backtick opens a raw string across lines (Go). */
  goRaw: boolean;
  /** A backtick quotes an identifier on its line (Kotlin, Scala, Swift). */
  tickIdent: boolean;
  /** The triple quotes that open a string across lines. */
  triple: readonly string[];
  /** Whether `\` escapes inside a triple-quoted string (not Kotlin's or Scala's raw ones, nor C#'s). */
  tripleEscapes: boolean;
  /** C#'s verbatim `@"…"`: across lines, `""` a quote, no escapes. */
  verbatim: boolean;
  /** Rust: a `'` is a char only as `'x'` or `'\…'`, else a lifetime. */
  rustChar: boolean;
  /** PHP: a doc block's line with a live annotation is code. */
  php: boolean;
}

const JS = /\.(m?[jt]sx?|c[jt]s|mts)$/i;
const NESTING = /\.(kt|kts|rs|swift|scala|sc|dart)$/i;
const TRIPLE_DOUBLE =
  /\.(java|kt|kts|scala|sc|swift|dart|groovy|gradle|cs|csx)$|(^|\/)Jenkinsfile(\.[\w.-]+)?$/i;
const TRIPLE_SINGLE = /\.(dart|groovy|gradle)$|(^|\/)Jenkinsfile(\.[\w.-]+)?$/i;
const RAW_TRIPLE = /\.(kt|kts|scala|sc|cs|csx)$/i;

/** The lexis of a file of the `c` or `php` comment style, by its name. */
export function commentLexisOf(file: string, php: boolean): CommentLexis {
  const triple = [
    ...(php || !TRIPLE_DOUBLE.test(file) ? [] : ['"""']),
    ...(php || !TRIPLE_SINGLE.test(file) ? [] : ["'''"]),
  ];
  return {
    slashSlash: !/\.css$/i.test(file),
    hash: php,
    nest: !php && NESTING.test(file),
    js: !php && JS.test(file),
    goRaw: !php && /\.go$/i.test(file),
    tickIdent: !php && /\.(kt|kts|scala|sc|swift)$/i.test(file),
    triple,
    tripleEscapes: !RAW_TRIPLE.test(file),
    verbatim: !php && /\.(cs|csx)$/i.test(file),
    rustChar: !php && /\.rs$/i.test(file),
    php,
  };
}

/** A doc block's leading `*` at a line's start, not a generator method (`*entries()`). */
const DOC_STAR_START = /^\s*\*(?![A-Za-z_$[])/;
/** A PHP doc block's line whose annotation the framework reads, as its first word. */
const LIVE_PHP_ANNOTATION =
  /^\s*(?:\/\*\*)?\s*\*?\s*@(?:(?:Route|Method|Get|Post|Put|Patch|Delete|Head|Options|ApiResource)\s*\(|Rest\\\w+|ORM\\\w+)/;
/** The words after which a `/` starts a regex literal, not a division. */
const REGEX_AFTER_WORD = new Set(
  "return typeof instanceof in of new delete void throw case do else yield await".split(" "),
);
/** The characters after which a `/` starts a regex literal. */
const REGEX_AFTER = "(,=:[!&|?{};+-*%~^";
/** Characters a comment line may hold outside its comment (a JSX comment's braces). */
const BRACKETS = "{}(),";

/** A space, a tab, a line end, a no-break space or a byte-order mark (`\s` in a regex, as the regex this replaces read). */
const isSpace = (c: string) => c <= " " || c === "\uFEFF" || c === "\u00A0";
const isWord = (c: string) =>
  (c >= "a" && c <= "z") ||
  (c >= "A" && c <= "Z") ||
  (c >= "0" && c <= "9") ||
  c === "_" ||
  c === "$";

type Mode = "code" | "block" | "str" | "raw" | "tpl";

/**
 * Which lines are all comment, in one pass. With `codeOut`, each line's text outside its comments
 * is put there too (its pieces joined by a space; a line all comment gives ""), for the
 * skipped-lines reader.
 */
export function lexCommentLines(
  lines: readonly string[],
  lx: CommentLexis,
  codeOut?: string[],
): boolean[] {
  const out = new Array<boolean>(lines.length);
  let mode: Mode = "code";
  let depth = 0; // a block comment's nesting
  let doc = false; // the block is a doc block, `/**`
  let close = ""; // what ends the string
  let escapes = true; // whether `\` escapes in it
  let doubled = false; // C#'s verbatim: `""` is a quote
  const frames: number[] = []; // the open braces of each template's `${…}`
  let prev = ""; // the last code character, for telling a regex from a division
  let prev2 = "";
  let word = ""; // the identifier that ends at `prev`
  const sawCode = (c: string) => {
    if (word && isWord(c) && isWord(prev)) word += c;
    else word = isWord(c) ? c : "";
    prev2 = prev;
    prev = c;
  };
  for (let n = 0; n < lines.length; n++) {
    const l = lines[n]!;
    const len = l.length;
    let comment: boolean = mode === "block";
    let code = false;
    let docLine: boolean = mode === "block" && doc;
    let synthetic = false;
    let cont = false; // a string continued past the line's end by a `\`
    let regexOk = lx.js;
    if (mode === "code" && DOC_STAR_START.test(l)) {
      // a doc block's line whose opening wasn't seen: read as one, for this line only
      mode = "block";
      depth = 1;
      doc = docLine = synthetic = comment = true;
    }
    let i = 0;
    // where the line's text outside a comment starts (-1: in one), and where a line comment cuts it
    let seg = mode === "block" ? -1 : 0;
    let cut = len;
    let text = "";
    while (i < len) {
      const c = l[i]!;
      if (mode === "block") {
        if (c === "*" && l[i + 1] === "/") {
          i += 2;
          if (--depth === 0) {
            mode = "code";
            seg = i;
          }
        } else if (lx.nest && c === "/" && l[i + 1] === "*") {
          depth++;
          i += 2;
        } else i++;
        continue;
      }
      if (mode !== "code") {
        if (!isSpace(c)) code = true;
        if (escapes && c === "\\") {
          if (i === len - 1) cont = true;
          i += 2;
        } else if (mode === "tpl") {
          if (c === "`") {
            mode = "code";
            prev = '"';
            word = "";
            i++;
          } else if (c === "$" && l[i + 1] === "{") {
            frames.push(0);
            mode = "code";
            prev = "{";
            word = "";
            i += 2;
          } else i++;
        } else if (doubled && c === '"' && l[i + 1] === '"') i += 2;
        else if (l.startsWith(close, i)) {
          mode = "code";
          prev = '"';
          word = "";
          i += close.length;
          // a triple-quoted string closes at the last of its run of quotes (`"$name""""`)
          if (close.length === 3) while (l[i] === close[0]) i++;
        } else i++;
        continue;
      }
      // code
      const d = l[i + 1];
      if (c === "/" && d === "/" && lx.slashSlash) {
        comment = true;
        cut = i;
        break;
      }
      if (c === "/" && d === "*") {
        if (codeOut && seg >= 0) text += `${l.slice(seg, i)} `;
        seg = -1;
        comment = true;
        mode = "block";
        depth = 1;
        doc = l[i + 2] === "*" && l[i + 3] !== "/";
        if (doc) docLine = true;
        i += 2;
        continue;
      }
      if (c === "#" && lx.hash && d !== "[") {
        comment = true;
        cut = i;
        break;
      }
      if (c === '"' || c === "'" || c === "`") {
        code = true;
        const t = lx.triple.find((q) => q[0] === c && l.startsWith(q, i));
        if (t) {
          mode = "raw";
          close = t;
          escapes = lx.tripleEscapes;
          doubled = false;
          i += 3;
        } else if (c === "`") {
          if (lx.js) {
            mode = "tpl";
            escapes = true;
            doubled = false;
          } else if (lx.goRaw || lx.tickIdent) {
            mode = lx.goRaw ? "raw" : "str";
            close = "`";
            escapes = false;
            doubled = false;
          } else sawCode(c);
          i++;
        } else if (c === '"' && lx.verbatim && (prev === "@" || (prev === "$" && prev2 === "@"))) {
          mode = "raw";
          close = '"';
          escapes = false;
          doubled = true;
          i++;
        } else if (c === "'" && lx.rustChar && d !== "\\" && l[i + 2] !== "'") {
          // a lifetime (`'a`), no quote
          sawCode(c);
          i++;
        } else {
          mode = "str";
          close = c;
          escapes = true;
          doubled = false;
          i++;
        }
        continue;
      }
      if (c === "/" && regexOk) {
        const after = REGEX_AFTER.includes(prev) || prev === "" || (prev === ">" && prev2 === "=");
        if (after || (isWord(prev) && REGEX_AFTER_WORD.has(word))) {
          // a regex literal: to its closing `/` on this line, outside a class (`[…]`)
          let j = i + 1;
          let cls = false;
          for (; j < len; j++) {
            const ch = l[j]!;
            if (ch === "\\") j++;
            else if (ch === "[") cls = true;
            else if (ch === "]") cls = false;
            else if (ch === "/" && !cls) break;
          }
          if (j < len) {
            code = true;
            prev = "a";
            word = "";
            i = j + 1;
            continue;
          }
          regexOk = false; // none closes on this line: no later one does either
        }
      }
      if (frames.length && c === "{") frames[frames.length - 1]!++;
      else if (frames.length && c === "}") {
        if (frames[frames.length - 1] === 0) {
          frames.pop();
          mode = "tpl";
          i++;
          continue;
        }
        frames[frames.length - 1]!--;
      }
      if (!isSpace(c)) {
        if (!BRACKETS.includes(c)) code = true;
        sawCode(c);
      }
      i++;
    }
    if (mode === "str" && !cont) mode = "code";
    if (synthetic && mode === "block") {
      mode = "code";
      depth = 0;
    }
    const live = lx.php && docLine && LIVE_PHP_ANNOTATION.test(l);
    out[n] = comment && !code && !live;
    if (codeOut)
      codeOut[n] = live ? l : out[n] ? "" : seg >= 0 ? text + l.slice(seg, cut) : text.trimEnd();
  }
  return out;
}
