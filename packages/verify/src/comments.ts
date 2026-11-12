/**
 * Which lines of a C-family or PHP file are all comment, read by a small lexer in one pass over
 * the file (fifth review of ADR 0196). A regex per line opened a block comment on a `/*` inside a
 * string (`"rm -rf build /*"`, `"SELECT a /*+ FIRST_ROWS"`) or after `;//`, and read the rest of
 * the file as comment, so a live route below it was refused. The lexer keeps its state across
 * lines: a line comment, a block comment (nested where the language nests them: Kotlin, Rust,
 * Swift, Scala, Dart), a string in `"` or `'` (to the line's end, or past it after a `\`; a `"`
 * string across lines in Rust, a `"` or `'` one in PHP), a JavaScript or TypeScript template
 * literal across lines with `${…}` inside it (braces counted, so an object or a nested template in
 * it is read), a Go raw string, a Java, Kotlin, Scala, Swift, Dart, Groovy or C# triple-quoted
 * string, a C# verbatim string, a Rust raw string (`r#"…"#`, `br"…"`) and char (not a lifetime), a
 * Dart raw string (`r'…'`, no escapes), a PHP heredoc or nowdoc (to the line its label starts, PHP
 * 7.3's flexible closing) and backtick command (across lines), a JavaScript regex literal, and
 * escapes. A line is comment when it has a comment on it and every other character on it outside
 * one is a space or one of `{ } ( ) ,` (a JSX comment, `{/* … *\/}`, and the `{/*` and `*\/}` lines
 * of one across lines). Linear in the file's length.
 *
 * A `/` starts a regex literal after an operator, an opening bracket, `;` or a keyword
 * (`return`…), and after `}` in a script, but not after `}` before `>` (JSX's `}/>`), after `++` or
 * `--`, nor after any `}` in a `.jsx` or `.tsx` file (sixth review of ADR 0196).
 *
 * A line read alone (`isCommentLine`, no file around it) that starts with a doc block's `*`
 * (` * text`, ` *\/`) is read as a doc block's line, as the regex it replaces read it; in a file
 * read whole a leading `*` is a doc block's only inside a block comment the lexer saw (sixth review:
 * `  * b; app.get(…)` continuing an expression is code). In PHP a doc block's line that carries an
 * annotation the framework reads (Symfony's `@Route(`, `@Method(`, FOSRest's `@Rest\Get(` and
 * `@Get(`…, API Platform's `@ApiResource(`, Doctrine's `@ORM\…`) is code: the annotation is live, as
 * a PHP 8 attribute is.
 *
 * A PHP file read whole starts as inline HTML (beta.27 re-review 6: HTML after `?>` was read as
 * PHP, and an apostrophe in its prose opened a `'` string across lines that put every later quote
 * out of step): `<?php`, `<?=` or `<?` opens PHP, and `?>` in its code closes it, ending a `//` or
 * `#` comment too, as PHP does (not one in a string, a heredoc or a block comment). Inline HTML is
 * text, neither code the lexer reads nor comment: a line of it is no comment line, as before, and
 * an HTML `<!-- -->` hides no PHP (PHP still runs inside it). In a Blade template (`.blade.php`)
 * the HTML's `{{-- … --}}` is comment, `<?php` inside one too (Blade takes them out first).
 *
 * Not read: C++ raw strings (`R"(…)"`), Swift's `#"…"#`, C#'s raw strings of four quotes or more
 * (`""""…""""`, read as a triple-quoted one, so a `"""` in one closes it), Scala's `raw"…\""` (its
 * `\` read as an escape), Blade's `@php … @endphp` (read as its HTML) and a `{{--` inside PHP code
 * in a Blade template (read as PHP's), Groovy's slashy strings, a
 * string an interpolation nests inside another string's interpolation outside JavaScript (Kotlin's
 * `"${m["k"]}"`). Each of these can misread the lines it spans and, when it holds an unclosed
 * `/*`, those after it up to the next `*\/`.
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
  /** JSX's own file (`.jsx`, `.tsx`): a `/` after `}` is never a regex's start. */
  jsx: boolean;
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
  /** Rust: a `'` is a char only as `'x'` or `'\…'`, else a lifetime; `r#"…"#` a raw string. */
  rustChar: boolean;
  /** Dart: `r'…'` and `r"…"` (and their triple forms) are raw, with no escapes. */
  dartRaw: boolean;
  /** The quotes whose strings run across lines (`"` in Rust, `"` and `'` in PHP). */
  spanQuotes: string;
  /**
   * PHP: a doc block's line with a live annotation is code; heredocs and backticks are read; a
   * file read whole starts as inline HTML, `<?php`, `<?=` or `<?` opens PHP and `?>` closes it.
   */
  php: boolean;
  /** A Blade template (`.blade.php`): in its HTML, `{{-- … --}}` is a comment. */
  blade: boolean;
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
  const rust = !php && /\.rs$/i.test(file);
  return {
    slashSlash: !/\.css$/i.test(file),
    hash: php,
    nest: !php && NESTING.test(file),
    js: !php && JS.test(file),
    jsx: !php && /\.[jt]sx$/i.test(file),
    goRaw: !php && /\.go$/i.test(file),
    tickIdent: !php && /\.(kt|kts|scala|sc|swift)$/i.test(file),
    triple,
    tripleEscapes: !RAW_TRIPLE.test(file),
    verbatim: !php && /\.(cs|csx)$/i.test(file),
    rustChar: rust,
    dartRaw: !php && /\.dart$/i.test(file),
    // Beta.27 re-review 5: PHP's `'…'` runs across lines too (its escapes, `\\` and `\'`, are read
    // as any `\` is: the character after one never closes it unless it is a quote escaped)
    spanQuotes: php ? `"'` : rust ? '"' : "",
    php,
    blade: php && /\.blade\.php$/i.test(file),
  };
}

/** A doc block's leading `*` at a line's start, not a generator method (`*entries()`). */
const DOC_STAR_START = /^\s*\*(?![A-Za-z_$[])/;
/**
 * A PHP doc block's annotation the framework reads, where the line's first word starts (sticky:
 * the `\s`, `/**` and `*` before it are read by hand, `livePhpAnnotation`; sixth review of ADR
 * 0196: `^\s*(?:\/\*\*)?\s*\*?\s*@…` backtracked cubically on a run of spaces).
 */
const LIVE_PHP_ANNOTATION =
  /@(?:(?:Route|Method|Get|Post|Put|Patch|Delete|Head|Options|ApiResource)\s*\(|Rest\\\w+|ORM\\\w+)/y;
/** A run of spaces, as `\s` reads them, from where it is set. */
const SPACES = /\s*/y;
const skipSpaces = (l: string, i: number) => {
  SPACES.lastIndex = i;
  SPACES.test(l);
  return SPACES.lastIndex;
};
/** Whether a PHP doc block's line carries a live annotation as its first word (linear). */
function livePhpAnnotation(l: string): boolean {
  let i = skipSpaces(l, 0);
  if (l.startsWith("/**", i)) i = skipSpaces(l, i + 3);
  if (l[i] === "*") i = skipSpaces(l, i + 1);
  LIVE_PHP_ANNOTATION.lastIndex = i;
  return LIVE_PHP_ANNOTATION.test(l);
}
/** A PHP heredoc's or nowdoc's opening after `<<<`: spaces, the label (quoted or not), the line's end. */
const HEREDOC_OPEN = /[ \t]*(["']?)([A-Za-z_\x80-\uFFFF][A-Za-z0-9_\x80-\uFFFF]*)\1[ \t\r]*$/y;
/** A character a PHP label may hold. */
const isLabelChar = (c: string | undefined) =>
  c !== undefined && c !== "$" && (isWord(c) || c >= "\x80");
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

/**
 * `html`: a PHP file's inline HTML, outside `<?php … ?>`: text, neither code the lexer reads nor
 * comment (a line of it is no comment, as any line of code); `blade`: a Blade comment in it.
 */
type Mode = "code" | "block" | "str" | "raw" | "tpl" | "heredoc" | "html" | "blade";

/** PHP's open tags, where inline HTML has `<?`: `<?php` (then a space or the line's end), `<?=`, `<?`. */
const PHP_OPEN = /<\?(?:php(?=\s|$)|=)?/iy;

/**
 * Which lines are all comment, in one pass. With `codeOut`, each line's text outside its comments
 * is put there too (its pieces joined by a space; a line all comment gives ""), for the
 * skipped-lines reader. `alone`: the lines are read with no file around them (`isCommentLine`), so a
 * line that starts with a doc block's `*` is read as one's.
 */
export function lexCommentLines(
  lines: readonly string[],
  lx: CommentLexis,
  codeOut?: string[],
  alone = false,
): boolean[] {
  const out = new Array<boolean>(lines.length);
  // a PHP file read whole starts as inline HTML (a line read alone, as PHP)
  let mode: Mode = lx.php && !alone ? "html" : "code";
  let depth = 0; // a block comment's nesting
  let doc = false; // the block is a doc block, `/**`
  let close = ""; // what ends the string (a heredoc's label)
  let escapes = true; // whether `\` escapes in it
  let doubled = false; // C#'s verbatim: `""` is a quote
  let tripled = false; // a triple-quoted string: it closes at the last of its run of quotes
  const frames: number[] = []; // the open braces of each template's `${…}`
  let prev = ""; // the last code character, for telling a regex from a division
  let prev2 = "";
  let word = ""; // the identifier that ends at `prev`
  let base = 0; // where the line starts in the file
  let prevAt = -2; // where `prev` is in the file
  let pair = false; // `prev` and `prev2` are one token's two characters (`++`, `--`)
  const sawCode = (c: string, at: number) => {
    if (word && isWord(c) && isWord(prev)) word += c;
    else word = isWord(c) ? c : "";
    pair = c === prev && at === prevAt + 1;
    prev2 = prev;
    prev = c;
    prevAt = at;
  };
  /** A string opens, closed by `to`: to the line's end (`str`) or across lines (`raw`). */
  const openString = (to: string, o: { escapes: boolean; lines: boolean; triple?: boolean }) => {
    mode = o.lines ? "raw" : "str";
    close = to;
    escapes = o.escapes;
    doubled = false;
    tripled = o.triple === true;
  };
  for (let n = 0; n < lines.length; base += lines[n]!.length + 1, n++) {
    const l = lines[n]!;
    const len = l.length;
    let comment: boolean = mode === "block" || mode === "blade";
    let code = false;
    let docLine: boolean = mode === "block" && doc;
    let synthetic = false;
    let cont = false; // a string continued past the line's end by a `\`
    let regexOk = lx.js;
    if (alone && mode === "code" && DOC_STAR_START.test(l)) {
      // a doc block's line read alone, whose opening isn't there: read as one, for this line only
      mode = "block";
      depth = 1;
      doc = docLine = synthetic = comment = true;
    }
    let i = 0;
    if (mode === "heredoc") {
      // its closing label, where the line's spaces end, not followed by a label's character
      const k = skipSpaces(l, 0);
      if (l.startsWith(close, k) && !isLabelChar(l[k + close.length])) {
        mode = "code";
        prev = '"';
        word = "";
        i = k + close.length;
      } else i = len;
      code = l.trim() !== "";
    }
    // where the line's text outside a comment starts (-1: in one), and where a line comment cuts it
    let seg = mode === "block" || mode === "blade" ? -1 : 0;
    let cut = len;
    let text = "";
    while (i < len) {
      const c = l[i]!;
      if (mode === "html") {
        // inline HTML: text to the next open tag; a `<!-- -->` in it hides no PHP (PHP still runs)
        PHP_OPEN.lastIndex = i;
        if (c === "<" && l[i + 1] === "?" && PHP_OPEN.test(l)) {
          mode = "code";
          prev = ";";
          word = "";
          i = PHP_OPEN.lastIndex;
        } else if (lx.blade && c === "{" && l.startsWith("{{--", i)) {
          // Blade takes its comments out before PHP runs: a `<?php` inside one is gone too
          if (codeOut && seg >= 0) text += `${l.slice(seg, i)} `;
          seg = -1;
          comment = true;
          mode = "blade";
          i += 4;
        } else {
          if (!isSpace(c)) code = true;
          i++;
        }
        continue;
      }
      if (mode === "blade") {
        const k = l.indexOf("--}}", i);
        if (k < 0) i = len;
        else {
          mode = "html";
          i = seg = k + 4;
        }
        continue;
      }
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
        else if (c === close[0] && l.startsWith(close, i)) {
          mode = "code";
          prev = '"';
          word = "";
          i += close.length;
          // a triple-quoted string closes at the last of its run of quotes (`"$name""""`)
          if (tripled) while (l[i] === close[0]) i++;
        } else i++;
        continue;
      }
      // code
      const d = l[i + 1];
      if (lx.php && c === "?" && d === ">") {
        // PHP's close tag (no string's, no block comment's): inline HTML after it
        mode = "html";
        i += 2;
        continue;
      }
      const lineComment =
        (c === "/" && d === "/" && lx.slashSlash) || (c === "#" && lx.hash && d !== "[");
      if (lineComment) {
        comment = true;
        // in PHP a line comment ends at `?>`, and inline HTML follows it
        const k = lx.php ? l.indexOf("?>", i + (c === "#" ? 1 : 2)) : -1;
        if (k < 0) {
          cut = i;
          break;
        }
        if (codeOut && seg >= 0) text += `${l.slice(seg, i)} `;
        mode = "html";
        i = seg = k + 2;
        continue;
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
      // a prefix that makes the string after it raw, at an identifier's start
      if ((lx.rustChar || lx.dartRaw) && !(i > 0 && isWord(l[i - 1]!))) {
        if (lx.rustChar && (c === "r" || ((c === "b" || c === "c") && d === "r"))) {
          // Rust's `r#"…"#`, `br"…"`, `cr"…"` (not a raw identifier, `r#type`)
          let j = c === "r" ? i + 1 : i + 2;
          const h = j;
          while (l[j] === "#") j++;
          if (l[j] === '"') {
            code = true;
            openString(`"${"#".repeat(j - h)}`, { escapes: false, lines: true });
            i = j + 1;
            continue;
          }
        } else if (lx.dartRaw && c === "r" && (d === "'" || d === '"')) {
          // Dart's `r'…'`, `r"…"`, `r'''…'''`: no escapes
          code = true;
          const t = lx.triple.find((q) => l.startsWith(q, i + 1));
          if (t) openString(t, { escapes: false, lines: true, triple: true });
          else openString(d, { escapes: false, lines: false });
          i += t ? 4 : 2;
          continue;
        }
      }
      if (lx.php && c === "<" && d === "<" && l[i + 2] === "<") {
        HEREDOC_OPEN.lastIndex = i + 3;
        const m = HEREDOC_OPEN.exec(l);
        if (m) {
          code = true;
          mode = "heredoc";
          close = m[2]!;
          break;
        }
      }
      if (c === '"' || c === "'" || c === "`") {
        code = true;
        const t = lx.triple.find((q) => q[0] === c && l.startsWith(q, i));
        if (t) {
          openString(t, { escapes: lx.tripleEscapes, lines: true, triple: true });
          i += 3;
        } else if (c === "`") {
          if (lx.js) {
            mode = "tpl";
            escapes = true;
            doubled = false;
          } else if (lx.php) openString("`", { escapes: true, lines: true });
          else if (lx.goRaw) openString("`", { escapes: false, lines: true });
          else if (lx.tickIdent) openString("`", { escapes: false, lines: false });
          else sawCode(c, base + i);
          i++;
        } else if (c === '"' && lx.verbatim && (prev === "@" || (prev === "$" && prev2 === "@"))) {
          openString('"', { escapes: false, lines: true });
          doubled = true;
          i++;
        } else if (c === "'" && lx.rustChar && d !== "\\" && l[i + 2] !== "'") {
          // a lifetime (`'a`), no quote
          sawCode(c, base + i);
          i++;
        } else {
          openString(c, { escapes: true, lines: lx.spanQuotes.includes(c) });
          i++;
        }
        continue;
      }
      if (c === "/" && regexOk) {
        const division =
          (prev === "}" && (lx.jsx || d === ">")) || (pair && (prev === "+" || prev === "-"));
        const after =
          !division &&
          (REGEX_AFTER.includes(prev) || prev === "" || (prev === ">" && prev2 === "="));
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
        sawCode(c, base + i);
      }
      i++;
    }
    // (`openString` sets the mode too, which the compiler's narrowing doesn't follow)
    if ((mode as Mode) === "str" && !cont) mode = "code";
    if (synthetic && mode === "block") {
      mode = "code";
      depth = 0;
    }
    const live = lx.php && docLine && livePhpAnnotation(l);
    out[n] = comment && !code && !live;
    if (codeOut)
      codeOut[n] = live ? l : out[n] ? "" : seg >= 0 ? text + l.slice(seg, cut) : text.trimEnd();
  }
  return out;
}
