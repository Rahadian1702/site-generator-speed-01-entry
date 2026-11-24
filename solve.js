// A faster drop-in for makefun-site 1.0.0: run(input) returns exactly the output
// tree makefun-site's build returns for the same input, byte for byte, in less
// CPU time. Written from scratch against the reference's documented behaviour:
// its front matter, its Markdown subset, its template dialect, its slug rule and
// its report. Nothing here is copied from the reference; the speed comes from
// doing the same work with less of it — batched HTML escaping, a Markdown lexer
// that dispatches on a line's first character, memoised slugs, and templates
// compiled once per case into straight-line JavaScript instead of walked as a
// tree on every page.
//
// Pure JavaScript, no dependencies, no WebAssembly, no native addons, no
// prebuilt binaries. Deterministic: the same input always yields the same
// output.

// ------------------------------------------------------------------ text

/** The HTML escape table. */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const ESC_TEST = /[&<>"']/;
const escReplacer = (c) => ESCAPES[c];

/** `s` with & < > " ' escaped. A string holding none of them is returned as is. */
function escapeHtml(s) {
  if (!ESC_TEST.test(s)) return s;
  ESC_RE.lastIndex = 0;
  return s.replace(ESC_RE, escReplacer);
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/** Slugs already computed, by their text: titles, tag names and headings repeat. */
const slugCache = new Map();

const NON_ALNUM_RUN = /[^a-z0-9]+/g;
const NON_ASCII = /[^\x00-\x7F]/;
const MARKS = /\p{M}/gu;

/** The slug of an ASCII-only string: lowercase, each run of other characters one "-". */
function slugAscii(s) {
  let out = s.toLowerCase().replace(NON_ALNUM_RUN, '-');
  if (out.charCodeAt(0) === 45) out = out.slice(1);
  const last = out.length - 1;
  if (last >= 0 && out.charCodeAt(last) === 45) out = out.slice(0, last);
  out = out.slice(0, SLUG_MAX);
  const cut = out.length - 1;
  if (cut >= 0 && out.charCodeAt(cut) === 45) out = out.replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of
 * characters other than a-z and 0-9 one "-", none at either end, at most 64
 * characters (a "-" left at the cut dropped), "untitled" when nothing is left.
 */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let out;
  if (!NON_ASCII.test(text)) {
    out = slugAscii(text);
  } else {
    const plain = text.normalize('NFKD').replace(MARKS, '');
    if (!NON_ASCII.test(plain)) {
      out = slugAscii(plain);
    } else {
      let built = '';
      let gap = false;
      for (const ch of plain) {
        let keep = null;
        if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
        else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
        if (keep === null) {
          gap = built.length > 0;
          continue;
        }
        if (gap) built += '-';
        gap = false;
        built += keep;
      }
      built = built.slice(0, SLUG_MAX).replace(/-+$/, '');
      out = built === '' ? 'untitled' : built;
    }
  }
  slugCache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, slug-3... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const y = date.slice(0, 4);
  const m = (date.charCodeAt(5) - 48) * 10 + (date.charCodeAt(6) - 48);
  const d = (date.charCodeAt(8) - 48) * 10 + (date.charCodeAt(9) - 48);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Whether a UTF-16 code unit is JavaScript whitespace (\s). */
function isWs(code) {
  return (
    code === 32 || code === 9 || code === 10 || code === 11 || code === 12 || code === 13 ||
    code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f ||
    code === 0x3000 || code === 0xfeff
  );
}

// ------------------------------------------------------------------ front matter

/** The keys a source's front matter may give. */
const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** Whether `c` is a decimal digit. */
const isDigit = (c) => c >= 48 && c <= 57;

/**
 * A string value: "..." with \" and \\ its only escapes, or bare, the rest of
 * the line (never opening on " or [). Returns { value } or { error }.
 */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. Returns { value } or { error }. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      let y = 0;
      let mo = 0;
      let d = 0;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          if (!isDigit(raw.charCodeAt(i))) {
            ok = false;
            break;
          }
        }
      }
      if (ok) {
        y = (raw.charCodeAt(0) - 48) * 1000 + (raw.charCodeAt(1) - 48) * 100 + (raw.charCodeAt(2) - 48) * 10 + (raw.charCodeAt(3) - 48);
        mo = (raw.charCodeAt(5) - 48) * 10 + (raw.charCodeAt(6) - 48);
        d = (raw.charCodeAt(8) - 48) * 10 + (raw.charCodeAt(9) - 48);
        if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) ok = false;
      }
      if (!ok) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',');
      for (let i = 0; i < tags.length; i++) {
        const t = tags[i].trim();
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let j = 0; j < t.length; j++) {
          const c = t.charCodeAt(j);
          if (c === 34 || c === 91 || c === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
        tags[i] = t;
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      let ok = raw.length > 0;
      for (let i = 0; ok && i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        ok = (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45;
      }
      return ok ? { value: raw } : { error: 'key "layout": not a template name' };
    }
    case 'slug': {
      let ok = raw.length > 0 && raw.length <= 64;
      let prevDash = true;
      for (let i = 0; ok && i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (c === 45) {
          if (prevDash) ok = false;
          prevDash = true;
        } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
        else ok = false;
      }
      if (prevDash) ok = false;
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first
 * reason it is refused. `text` has "\n" line ends.
 */
function parseFrontMatter(text) {
  // The opening line must be exactly "---".
  if (text === '---') return { error: 'the front matter is not closed' };
  if (text.length < 4 || text.charCodeAt(0) !== 45 || text.charCodeAt(1) !== 45 || text.charCodeAt(2) !== 45 || text.charCodeAt(3) !== 10) {
    return { error: 'no front matter' };
  }
  // The closing line comes first: a line exactly "---". Without one the file
  // is refused as not closed, whatever its lines between hold.
  let closeStart = -1;
  let search = 3;
  for (;;) {
    const idx = text.indexOf('\n---', search);
    if (idx === -1) break;
    const after = idx + 4;
    if (after === text.length || text.charCodeAt(after) === 10) {
      closeStart = idx + 1;
      break;
    }
    search = idx + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let pos = 4;
  let lineNo = 2;
  while (pos < closeStart) {
    const nl = text.indexOf('\n', pos);
    const line = text.slice(pos, nl);
    // Blank (spaces and tabs only) or a comment.
    let blank = true;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) {
        blank = false;
        break;
      }
    }
    if (!blank && line.charCodeAt(0) !== 35) {
      // "key: value": a key of a-z and _, a colon, one space and the value.
      let k = 0;
      while (k < line.length) {
        const c = line.charCodeAt(k);
        if (!((c >= 97 && c <= 122) || c === 95)) break;
        k++;
      }
      if (k === 0 || k >= line.length || line.charCodeAt(k) !== 58) {
        return { error: `line ${lineNo} is not "key: value"` };
      }
      const key = line.slice(0, k);
      let raw;
      if (k + 1 === line.length) raw = '';
      else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
      else return { error: `line ${lineNo} is not "key: value"` };
      let end = raw.length;
      while (end > 0) {
        const c = raw.charCodeAt(end - 1);
        if (c !== 32 && c !== 9) break;
        end--;
      }
      raw = raw.slice(0, end);
      if (!KEYS.has(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    pos = nl + 1;
    lineNo++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const body = closeStart + 3 === text.length ? '' : text.slice(closeStart + 4);
  return { data, body };
}

// ------------------------------------------------------------------ markdown

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** Whether `line` is blank: empty, or spaces and tabs only. */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `line` with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Whether `c` is a fence-language character: A-Z, a-z, 0-9, _, +, -. */
function isLangChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}

/**
 * A fence's language when `line` opens one (three backticks, an optional
 * language, then spaces or tabs only), else null.
 */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length && isLangChar(line.charCodeAt(i))) i++;
  for (let j = i; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
  }
  return line.slice(3, i);
}

/** Whether `line` closes a fence: three backticks, then spaces or tabs only. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let hashes = 0;
  while (hashes < line.length && line.charCodeAt(hashes) === 35) hashes++;
  if (hashes === 0 || hashes > 6) return null;
  let i = hashes;
  let spaces = 0;
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) {
    i++;
    spaces++;
  }
  if (spaces === 0) return null;
  let end = line.length;
  while (end > i && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  if (end === i) return null;
  return { depth: hashes, text: line.slice(i, end) };
}

/** Whether `line` is a thematic break: --- or ***, then spaces or tabs only. */
function isHr(line) {
  const c = line.charCodeAt(0);
  if (c !== 45 && c !== 42) return false;
  if (line.charCodeAt(1) !== c || line.charCodeAt(2) !== c) return false;
  for (let i = 3; i < line.length; i++) {
    const ch = line.charCodeAt(i);
    if (ch !== 32 && ch !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a break. */
function endsParagraph(line) {
  if (line.length === 0) return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return isBlank(line);
  if (c === 96) return fenceLang(line) !== null;
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return isHr(line);
  return false;
}

/** A list continuation line: two or more spaces, then a non-space. */
const CONTINUED = /^ {2,}\S/;

/** The words of `line`: its runs of characters other than whitespace. */
function countWords(line) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < line.length; i++) {
    if (isWs(line.charCodeAt(i))) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** The first index from `from` below `end` where `s` holds "**" outside an escape, or -1. */
function findStrongClose(s, from, end) {
  for (let j = from; j + 1 < end; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c === 42 && s.charCodeAt(j + 1) === 42) return j;
  }
  return -1;
}

/** The first index from `from` below `end` where `s` holds "]" outside an escape, or -1. */
function findBracketClose(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c === 93) return j;
  }
  return -1;
}

/** The first single * from `from` below `end` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (j + 1 < end && s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

const WS_TEST = /\s/;

/**
 * `s` from `start` to `end` rendered inline, appended to `out`. `link(target)`
 * is a link's href. Text between inline marks is escaped in bulk, not one
 * character at a time.
 */
function inlineInto(s, start, end, link, out) {
  const re = /[\\`*[]/g;
  let i = start;
  re.lastIndex = start;
  for (;;) {
    const m = re.exec(s);
    if (m === null || m.index >= end) {
      if (i < end) out.push(escapeHtml(s.slice(i, end)));
      return;
    }
    const j = m.index;
    if (j > i) out.push(escapeHtml(s.slice(i, j)));
    const c = s.charCodeAt(j);
    if (c === 92) {
      // Backslash: an escapable character after it is written escaped.
      if (j + 1 < end && ESCAPABLE.has(s[j + 1])) {
        const n = s[j + 1];
        out.push(n === '>' ? '&gt;' : n);
        i = j + 2;
      } else {
        out.push('\\');
        i = j + 1;
      }
    } else if (c === 96) {
      // A backtick opens a code span closed by the next backtick, with at least
      // one character between.
      const k = s.indexOf('`', j + 1);
      if (k !== -1 && k < end && k > j + 1) {
        out.push('<code>', escapeHtml(s.slice(j + 1, k)), '</code>');
        i = k + 1;
      } else {
        out.push('`');
        i = j + 1;
      }
    } else if (c === 42) {
      if (j + 1 < end && s.charCodeAt(j + 1) === 42) {
        const k = findStrongClose(s, j + 2, end);
        if (k !== -1 && k > j + 2) {
          out.push('<strong>');
          inlineInto(s, j + 2, k, link, out);
          out.push('</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1, end);
        if (k !== -1 && k > j + 1) {
          out.push('<em>');
          inlineInto(s, j + 1, k, link, out);
          out.push('</em>');
          i = k + 1;
        } else {
          out.push('*');
          i = j + 1;
        }
      }
    } else {
      // A link: [text](target), the target neither empty nor holding whitespace.
      const k = findBracketClose(s, j + 1, end);
      let m2 = -1;
      if (k !== -1 && k + 1 < end && s.charCodeAt(k + 1) === 40) m2 = s.indexOf(')', k + 2);
      if (m2 !== -1 && m2 < end) {
        const target = s.slice(k + 2, m2);
        if (target !== '' && !WS_TEST.test(target)) {
          out.push('<a href="', escapeHtml(link(target)), '">');
          inlineInto(s, j + 1, k, link, out);
          out.push('</a>');
          i = m2 + 1;
        } else {
          out.push('[');
          i = j + 1;
        }
      } else {
        out.push('[');
        i = j + 1;
      }
    }
    re.lastIndex = i;
  }
}

/** `s` rendered inline, whole. */
function inlineStr(s, link) {
  const out = [];
  inlineInto(s, 0, s.length, link, out);
  return out.join('');
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents (every level 2 and 3 heading), its excerpt (the
 * first paragraph's inline HTML, or "") and its word count.
 */
function renderMarkdown(src, link) {
  const lines = src.split('\n');
  const n = lines.length;
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let words = 0;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    words += countWords(line);
    if (line.length === 0) {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 32 || c0 === 9) {
      if (isBlank(line)) {
        i++;
        continue;
      }
      // An indented line is paragraph text, not code.
    } else if (c0 === 96) {
      const lang = fenceLang(line);
      if (lang !== null) {
        const body = [];
        i++;
        while (i < n) {
          const l = lines[i];
          words += countWords(l);
          if (isFenceClose(l)) {
            i++;
            break;
          }
          body.push(l);
          i++;
        }
        const cls = lang === '' ? '' : ` class="language-${lang}"`;
        blocks.push(`<pre><code${cls}>${body.length === 0 ? '' : `${escapeHtml(body.join('\n'))}\n`}</code></pre>`);
        continue;
      }
    } else if (c0 === 35) {
      const h = headingOf(line);
      if (h !== null) {
        const id = uniqueSlug(slugify(h.text), ids);
        const html = inlineStr(h.text, link);
        blocks.push(`<h${h.depth} id="${id}">${html}</h${h.depth}>`);
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHr(line)) {
        blocks.push('<hr>');
        i++;
        continue;
      }
      if (line.charCodeAt(1) === 32) {
        // A bullet list: each following "- "/"* " line another item.
        const items = [[trimLine(line.slice(2))]];
        i++;
        while (i < n) {
          const l = lines[i];
          const d0 = l.charCodeAt(0);
          if ((d0 === 45 || d0 === 42) && l.charCodeAt(1) === 32) {
            words += countWords(l);
            items.push([trimLine(l.slice(2))]);
            i++;
          } else if (CONTINUED.test(l)) {
            words += countWords(l);
            items[items.length - 1].push(trimLine(l));
            i++;
          } else break;
        }
        const parts = ['<ul>\n'];
        for (const item of items) parts.push(`<li>${inlineStr(item.join('\n'), link)}</li>\n`);
        parts.push('</ul>');
        blocks.push(parts.join(''));
        continue;
      }
    } else if (c0 === 62) {
      // A blockquote: the lines opening on ">".
      const body = [];
      {
        const dropped = line.charCodeAt(1) === 32 ? line.slice(2) : line.slice(1);
        const t = trimLine(dropped);
        if (t !== '') body.push(t);
        i++;
      }
      while (i < n) {
        const l = lines[i];
        if (l.charCodeAt(0) !== 62) break;
        words += countWords(l);
        const dropped = l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1);
        const t = trimLine(dropped);
        if (t !== '') body.push(t);
        i++;
      }
      blocks.push(body.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inlineStr(body.join('\n'), link)}</p>\n</blockquote>`);
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      // An ordered list: digits and ". ", at most 9 digits.
      let d = 0;
      while (d < line.length && line.charCodeAt(d) >= 48 && line.charCodeAt(d) <= 57) d++;
      if (d >= 1 && d <= 9 && line.charCodeAt(d) === 46 && line.charCodeAt(d + 1) === 32) {
        const start = Number(line.slice(0, d));
        const items = [[trimLine(line.slice(d + 2))]];
        i++;
        while (i < n) {
          const l = lines[i];
          let e = 0;
          while (e < l.length && l.charCodeAt(e) >= 48 && l.charCodeAt(e) <= 57) e++;
          if (e >= 1 && e <= 9 && l.charCodeAt(e) === 46 && l.charCodeAt(e + 1) === 32) {
            words += countWords(l);
            items.push([trimLine(l.slice(e + 2))]);
            i++;
          } else if (CONTINUED.test(l)) {
            words += countWords(l);
            items[items.length - 1].push(trimLine(l));
            i++;
          } else break;
        }
        const open = start !== 1 ? `<ol start="${start}">` : '<ol>';
        const parts = [`${open}\n`];
        for (const item of items) parts.push(`<li>${inlineStr(item.join('\n'), link)}</li>\n`);
        parts.push('</ol>');
        blocks.push(parts.join(''));
        continue;
      }
    }
    // A paragraph: the lines after it up to a blank line, a fence, a heading
    // or a thematic break.
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) {
      words += countWords(lines[i]);
      body.push(trimLine(lines[i]));
      i++;
    }
    const html = inlineStr(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : `${blocks.join('\n')}\n`, toc, excerpt: excerpt ?? '', words };
}

// ------------------------------------------------------------------ templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether `src` from `a` to `b` holds only spaces and tabs. */
function isSpacesOnly(src, a, b) {
  for (let i = a; i < b; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isSpacesOnly(src, lineStart, open) && isSpacesOnly(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * Whether `nodes` references `loop` where it would resolve to the enclosing
 * for's loop object: any unshadowed reference, following includes (cycle-safe).
 * A nested for shadows `loop` in its body, though its own path is read outside.
 */
function bodyNeedsLoop(nodes, templates) {
  const seen = new Set();
  const walk = (ns) => {
    for (const nd of ns) {
      if (nd.kind === 'var' || nd.kind === 'raw') {
        if (nd.path[0] === 'loop') return true;
      } else if (nd.kind === 'if') {
        if (nd.path[0] === 'loop') return true;
        if (walk(nd.then)) return true;
        if (nd.else !== null && walk(nd.else)) return true;
      } else if (nd.kind === 'for') {
        if (nd.path[0] === 'loop') return true;
        // Its body is not walked: the nested for shadows `loop` there.
      } else if (nd.kind === 'include') {
        const t = templates.get(nd.name);
        if (t !== undefined && !seen.has(nd.name)) {
          seen.add(nd.name);
          if (walk(t)) return true;
        }
      }
    }
    return false;
  };
  return walk(nodes);
}

/** JavaScript for `nodes`, rendered in the scope held by variable `sv`. */
function genNodes(nodes, sv, templates, st) {
  let out = '';
  for (const nd of nodes) {
    if (nd.kind === 'text') out += `o+=${JSON.stringify(nd.text)};`;
    else if (nd.kind === 'var') out += `o+=E(T(L(${sv},${JSON.stringify(nd.path)})));`;
    else if (nd.kind === 'raw') out += `o+=T(L(${sv},${JSON.stringify(nd.path)}));`;
    else if (nd.kind === 'if') {
      out += `if(TR(L(${sv},${JSON.stringify(nd.path)}))!==${nd.not}){${genNodes(nd.then, sv, templates, st)}`;
      if (nd.else !== null) out += `}else{${genNodes(nd.else, sv, templates, st)}`;
      out += '}';
    } else if (nd.kind === 'for') {
      const u = ++st.uid;
      const xs = `_x${u}`;
      const k = `_k${u}`;
      const s = `_s${u}`;
      out += `var ${xs}=L(${sv},${JSON.stringify(nd.path)});if(Array.isArray(${xs})){for(var ${k}=0;${k}<${xs}.length;${k}++){var ${s}={vars:{},parent:${sv}};${s}.vars[${JSON.stringify(nd.name)}]=${xs}[${k}];`;
      if (bodyNeedsLoop(nd.body, templates)) {
        out += `${s}.vars.loop={index:${k}+1,first:${k}===0,last:${k}===${xs}.length-1,length:${xs}.length};`;
      }
      out += genNodes(nd.body, s, templates, st);
      out += '}}';
    } else if (nd.kind === 'include') {
      const t = `_t${++st.uid}`;
      out += `var ${t}=ctx.templates.get(${JSON.stringify(nd.name)});if(${t}!==undefined&&depth<${INCLUDE_DEPTH})o+=${t}(${sv},ctx,depth+1,L,T,E,TR);`;
    }
  }
  return out;
}

/**
 * `nodes` compiled into a render function (scope, ctx, depth, L, T, E, TR).
 * `templates` is the parsed-template map the include analysis reads.
 */
function compileTemplate(nodes, templates) {
  const st = { uid: 0 };
  const body = genNodes(nodes, 'scope', templates, st);
  return new Function('scope', 'ctx', 'depth', 'L', 'T', 'E', 'TR', `var o='';${body}return o;`);
}

// ------------------------------------------------------------------ the build

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

/** Resolved link paths, by source directory and relative target: links repeat across sources. */
const resolveCache = new Map();

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const key = `${dir}\0${rel}`;
  const hit = resolveCache.get(key);
  if (hit !== undefined) return hit;
  const parts = dir === '' ? [] : dir.split('/');
  let ok = true;
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) {
        ok = false;
        break;
      }
      parts.pop();
    } else parts.push(seg);
  }
  const out = ok ? parts.join('/') : null;
  resolveCache.set(key, out);
  return out;
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** A page's link record as templates read it. */
const linkOf = (s) =>
  s === null
    ? null
    : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };

/** A post's card, as lists show it. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it. */
function pageOf(s) {
  return {
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text. */
export function run(input) {
  // Templates, parsed in code-unit order of their names; one that does not
  // parse is reported and left out. Each parsed template is compiled once.
  const parsed = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      parsed.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const compiled = new Map();
  for (const [name, nodes] of parsed) compiled.set(name, compileTemplate(nodes, parsed));
  const ctx = { templates: compiled };

  const base = input.site.base_url.replace(/\/+$/, '');

  // Sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push({ path: f.path, content: f.content });
  }

  // Front matter: a refused source is reported and dropped, and so is a draft.
  // The checks run in order, and the first one that fails is the one reported.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!parsed.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each page's slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, each body's links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const schemeRe = /^[A-Za-z][A-Za-z0-9+.-]*:/;
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (schemeRe.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null) {
        const page = bySource.get(path);
        if (page !== undefined) return `${page.url}${frag}`;
        if (staticPaths.has(path)) return `${base}/${path}${frag}`;
      }
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = md.words;
  }

  // Collections: the posts, newest first and then by slug, each with its neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: grouped by their slug, each named as first met in the posts' order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  // A page's tags link to the posts' tag of the same slug, and to nothing (url "")
  // where no post has it.
  for (const s of kept) {
    if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Layouts: every page through its layout, the index pages and the tag pages
  // through theirs. `site`, `tags` and `recent` are the same for every render
  // of a case, so they live in one shared root scope.
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const rootScope = { vars: { site, tags: allTags, recent }, parent: null };
  const output = {};
  const render = (name, vars) => {
    const fn = compiled.get(name);
    if (fn === undefined) return null;
    const scope = vars === null ? rootScope : { vars, parent: rootScope };
    return fn(scope, ctx, 0, lookup, textOf, escapeHtml, truthy);
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: {
        number: k,
        total: pages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', null);
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every refusal, draft, broken link and template that did not
  // parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  let pageCount = 0;
  for (const s of kept) if (!s.post) pageCount++;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
