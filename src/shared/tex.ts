import katex from 'katex'

/*
 * Titles and abstracts from conference sites come as TeX, Markdown and HTML mixed. Each is read once, when it
 * arrives, the way TeX would read it, and kept as Markdown with $math$: text commands become marks or characters
 * (\textbf{CARL} → **CARL**, 56\% → 56%, -- → –), formulas stay with the slips sites cause repaired, and an
 * author's own macros (\ours) are left as written, for Claude to look up.
 */

/* ---------- formulas ---------- */

/** Where math opened before `from` ends: the index of the closing $ (the first of $$), or -1. Braces nest. */
function closing(s: string, from: number, display: boolean): number {
  let depth = 0
  for (let j = from; j < s.length; j++) {
    const c = s[j]
    if (c === '\\') j++
    else if (c === '{') depth++
    else if (c === '}') {
      if (--depth < 0) return -1
    }
    // inside a group a $ is math within text (\text{for $x$}), not the end
    else if (c === '$' && depth === 0) return !display || s[j + 1] === '$' ? j : -1
  }
  return -1
}

/** Prose between two dollar signs ("$20 for $x$", "$3，输出 $15"): with commands, arguments and scripts gone, math has no words or Chinese left. */
function wordy(inner: string): boolean {
  const bare = inner.replace(/\\[a-zA-Z]+\*?(\{[^{}]*\})*/g, '').replace(/[\^_]\{[^{}]*\}/g, '')
  return /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/.test(bare) || /\s[a-zA-Z]{2,}\s/.test(bare)
}

export type Formula = { tex: string; display: boolean; end: number; price?: undefined } | { price: number; tex?: undefined }

/**
 * The formula starting at s[i] ($, $$, \( or \[), paired the way TeX pairs dollar signs, so 2.5$\times$ and
 * $\sim$6 count. Dollar signs before amounts are not math: { price } is where a pair of them ("$5 to $10") ends.
 */
export function formulaAt(s: string, i: number, nested = false): Formula | undefined {
  if (s[i] === '\\') {
    const close = s[i + 1] === '(' ? '\\)' : '\\]'
    const j = s.indexOf(close, i + 2)
    return j > 0 ? { tex: s.slice(i + 2, j), display: s[i + 1] === '[', end: j + 2 } : undefined
  }
  const display = s[i + 1] === '$'
  const from = i + (display ? 2 : 1)
  const end = closing(s, from, display)
  if (end < from) return undefined
  const inner = s.slice(from, end)
  if (/^\d/.test(inner)) {
    if (wordy(inner)) return undefined
    // "$5 to $10": the next $ is a dollar sign too, unless it opens a formula ("$1, $10^{-4}$")
    if (!nested && /\d/.test(s[end + 1] ?? '')) return formulaAt(s, end, true)?.tex !== undefined ? undefined : { price: end + 1 }
  }
  return { tex: inner, display, end: end + (display ? 2 : 1) }
}

// Sites that read Markdown before math made some authors escape their TeX for Markdown: \\% for \%, \* for *, \_ for _.
function repairMath(tex: string): string {
  // a formula with every backslash doubled (\\leq, \\begin) is halved throughout
  let t = (/\\\\[a-zA-Z]/.test(tex) ? tex.replace(/\\\\/g, '\\') : tex).replace(/\\([*=+<>-])/g, '$1')
  if (!/\\(text\w*|mathrm|operatorname|mbox)\{[^{}]*\\_/.test(t)) t = t.replace(/\\_/g, '_')
  // there are no line ends in an abstract, so a bare % would comment out the rest of the formula
  t = t.replace(/(^|[^\\])%/g, '$1\\%')
  // a $ at the top of a formula means nothing: \( $\Delta$ = 0.46 \)
  let out = ''
  let depth = 0
  for (let j = 0; j < t.length; j++) {
    const c = t[j]
    if (c === '\\') {
      out += t.slice(j, j + 2)
      j++
      continue
    }
    if (c === '{') depth++
    else if (c === '}') depth--
    else if (c === '$' && depth === 0) continue
    out += c
  }
  return out
    .replace(/\\unicode\{(x?)([0-9a-fA-F]+)\}/g, (m, x, h) => {
      const n = parseInt(h, x ? 16 : 10)
      return n > 0 && n <= 0x10ffff ? `\\text{${String.fromCodePoint(n)}}` : m
    })
    .trim()
}

// A formula holding only text commands ($\textbf{OPeX}$, $\textbf{4.28$\times$}$) is text the author wanted bold.
const TEXT_CMD = /\\(textbf|textit|texttt|textsc|textsf|textrm|textup|emph|text|underline|mbox)\s*\{/
function onlyText(tex: string): boolean {
  let rest = tex
  for (let n = 0; n < 20; n++) {
    const m = TEXT_CMD.exec(rest)
    if (!m) return n > 0 && !/[\p{L}\p{N}\\^_]/u.test(rest)
    const g = group(rest, rest.indexOf('{', m.index))
    if (!g) return false
    rest = rest.slice(0, m.index) + ' ' + rest.slice(g[1])
  }
  return false
}

/* ---------- drawing ---------- */

/** Text-mode commands authors use inside math, which KaTeX lacks. */
export const MATH_MACROS: Record<string, string> = {
  '\\textemdash': '\\text{—}',
  '\\textendash': '\\text{–}',
  '\\textasciitilde': '\\text{\\char`\\~}',
  '\\mbox': '\\text{#1}',
  '\\textsc': '\\text{#1}',
  '\\textless': '<',
  '\\textgreater': '>',
  '\\textdegree': '\\degree',
  '\\textsubscript': '_{\\text{#1}}',
  '\\textsuperscript': '^{\\text{#1}}',
  '\\textperthousand': '\\text{‰}',
  '\\textlangle': '\\langle',
  '\\textrangle': '\\rangle'
}

/**
 * A formula drawn by KaTeX; an author's own macro (\by) shows as its name, upright, and is listed in `own`.
 * Undefined when even that fails.
 */
export function drawTex(tex: string, display = false): { html: string; own: string[] } | undefined {
  const macros = { ...MATH_MACROS }
  const own: string[] = []
  for (let n = 0; n < 8; n++) {
    try {
      return { html: katex.renderToString(tex, { displayMode: display, throwOnError: true, strict: 'ignore', macros }), own }
    } catch (err) {
      const m = /Undefined control sequence: \\([a-zA-Z]+)/.exec(String((err as Error)?.message))
      if (!m) return undefined
      own.push(`\\${m[1]}`)
      macros[`\\${m[1]}`] = `\\mathrm{${m[1]}}`
    }
  }
  return undefined
}

const renders = (tex: string) => {
  try {
    katex.renderToString(tex, { throwOnError: true, strict: 'ignore' })
    return true
  } catch {
    return false
  }
}

/* ---------- text ---------- */

const ACCENT: Record<string, string> = {
  "'": '\u0301',
  '`': '\u0300',
  '^': '\u0302',
  '"': '\u0308',
  '~': '\u0303',
  '=': '\u0304',
  '.': '\u0307',
  u: '\u0306',
  v: '\u030c',
  H: '\u030b',
  c: '\u0327',
  k: '\u0328',
  r: '\u030a',
  d: '\u0323',
  b: '\u0331'
}
const LETTER: Record<string, string> = { ss: 'ß', o: 'ø', O: 'Ø', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', aa: 'å', AA: 'Å', l: 'ł', L: 'Ł', i: 'ı', j: 'ȷ' }
// Markdown's own characters are written escaped, so they stay text.
const SYMBOL: Record<string, string> = {
  '%': '%', '&': '&', '#': '#', '{': '\\{', '}': '\\}', _: '\\_', $: '\\$', ',': '\u2009', ' ': ' ', ';': ' ', ':': ' ', '!': '', '-': '', '/': '', '@': '', '\\': ' ',
  // \n left in by a script that didn't decode its source
  n: ' ',
  textemdash: '—', textendash: '–', textasciitilde: '~', textasciicircum: '^', textbackslash: '\\\\', textbar: '|', textless: '<', textgreater: '>',
  textquotedblleft: '“', textquotedblright: '”', textquoteleft: '‘', textquoteright: '’', textlangle: '⟨', textrangle: '⟩', ldots: '…', dots: '…', textellipsis: '…', textbullet: '•',
  S: '§', P: '¶', dag: '†', ddag: '‡', textdagger: '†', copyright: '©', textregistered: '®', texttrademark: '™', textdegree: '°', textmu: 'µ',
  texttimes: '×', textperthousand: '‰', checkmark: '✓', LaTeX: 'LaTeX', TeX: 'TeX',
  eg: 'e.g.', ie: 'i.e.', etal: 'et al.', etc: 'etc.', vs: 'vs.', wrt: 'w.r.t.', cf: 'cf.', Eg: 'E.g.', Ie: 'I.e.',
  noindent: '', smallskip: '', medskip: '', bigskip: '', par: ' ', newline: ' ', linebreak: ' ', quad: ' ', qquad: ' ', centering: '', hfill: ' '
}
/** Commands whose last argument is the text, and how it is marked. */
const MARK: Record<string, string> = {
  textbf: '**', bf: '**', bfseries: '**', textit: '*', emph: '*', em: '*', it: '*', itshape: '*', textsl: '*', sl: '*', texttt: '', tt: '', ttfamily: '',
  textsc: '', sc: '', scshape: '', textsf: '', sf: '', textrm: '', rm: '', textup: '', textmd: '', textnormal: '', mbox: '', text: '', underline: '', uline: '',
  hl: '', textcolor: '', colorbox: '', fbox: '', raisebox: '', scalebox: '', textsuperscript: 'sup', textsubscript: 'sub', footnote: '()', thanks: '()'
}
const DROP = new Set([
  'cite', 'citep', 'citet', 'citealp', 'citealt', 'citeauthor', 'citeyear', 'parencite', 'textcite', 'autocite', 'nocite', 'ref', 'eqref', 'cref', 'Cref', 'autoref',
  'label', 'footnotemark', 'vspace', 'hspace', 'includegraphics', 'color', 'begin', 'end', 'hyperref', 'setlength', 'ding', 'emoji', 'romannumeral'
])
/** HTML the sites use for marks, and links in angle brackets; any other <name> is text (<think>, <eos>). */
const TAG = /^<\/?(b|strong|i|em|u|sub|sup|code|br)\b[^<>]*>|^<[a-z][a-z0-9+.-]*:[^\s<>]*>/i

/** The brace group opening at s[i]: [content, index after it]. */
function group(s: string, i: number): [string, number] | undefined {
  let depth = 0
  for (let j = i; j < s.length; j++) {
    if (s[j] === '\\') j++
    else if (s[j] === '{') depth++
    else if (s[j] === '}' && --depth === 0) return [s.slice(i + 1, j), j + 1]
  }
  return undefined
}

/** A command's arguments: an optional [..], then brace groups. */
function args(s: string, i: number): [string[], number] {
  const out: string[] = []
  let j = i
  if (s[j] === '[') {
    const k = s.indexOf(']', j)
    if (k > 0) j = k + 1
  }
  while (s[j] === '{' || (s[j] === ' ' && s[j + 1] === '{' && out.length)) {
    if (s[j] === ' ') j++
    const g = group(s, j)
    if (!g) break
    out.push(g[0])
    j = g[1]
  }
  return [out, j]
}

function mark(how: string, inner: string): string {
  inner = inner.trim()
  if (!inner) return ''
  if (how === 'sup' || how === 'sub') return `<${how}>${inner}</${how}>`
  if (how === '()') return ` (${inner})`
  return how + inner + how
}

/** Author text read as TeX. */
function prose(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; ) {
    const c = s[i]
    if (c === '$' || (c === '\\' && (s[i + 1] === '(' || s[i + 1] === '['))) {
      const f = formulaAt(s, i)
      if (f?.price !== undefined) {
        out += `\\$${prose(s.slice(i + 1, f.price - 1))}\\$`
        i = f.price
        continue
      }
      if (f) {
        const tex = repairMath(f.tex)
        // ~ in math is a space
        out += !tex ? '' : onlyText(tex) ? prose(tex.replace(/~/g, ' ')) : f.display ? `$$${tex}$$` : `$${tex}$`
        i = f.end
        continue
      }
      if (c === '$') {
        out += '\\$'
        i++
        continue
      }
    }
    if (c === '\\') {
      const m = /^\\([a-zA-Z]+)\*?|^\\(.)/s.exec(s.slice(i))
      if (!m) {
        out += c
        i++
        continue
      }
      const name = m[1] ?? m[2]
      let j = i + m[0].length
      if (ACCENT[name] && (m[2] !== undefined || name.length === 1)) {
        let base: string | undefined
        if (s[j] === '{') {
          const g = group(s, j)
          if (g) [base, j] = g
        } else {
          if (m[1] !== undefined && s[j] === ' ') j++
          base = s[j]
          j++
        }
        if (base !== undefined && base.length <= 2) {
          out += (base.replace(/^\\([ij])$/, '$1') + ACCENT[name]).normalize('NFC')
          i = j
          continue
        }
      }
      if (LETTER[name] && !/^[a-zA-Z]/.test(s.slice(j))) {
        out += LETTER[name]
        i = s.startsWith('{}', j) ? j + 2 : j
        continue
      }
      if (name in SYMBOL) {
        out += SYMBOL[name]
        i = s.startsWith('{}', j) ? j + 2 : j
        continue
      }
      if (name === 'url' || name === 'href' || name === 'texorpdfstring') {
        const [a, k] = args(s, j)
        out += name === 'href' && a.length > 1 ? `[${prose(a[1])}](${a[0]})` : name === 'texorpdfstring' ? prose(a[0] ?? '') : a[0] ?? ''
        i = k
        continue
      }
      if (DROP.has(name) || /^fa[A-Z]/.test(name)) {
        const [, k] = args(s, j)
        if (/^([\s.,;:)]|$)/.test(s.slice(k))) out = out.replace(/[\s~]+$/, '')
        i = k
        continue
      }
      if (name in MARK) {
        const [a, k] = args(s, j)
        if (a.length) {
          out += mark(MARK[name], prose(a[a.length - 1]))
          i = k
          continue
        }
        // \bf outside a group: nothing to mark
        i = s[j] === ' ' ? j + 1 : j
        continue
      }
      // math left outside $: the command with its arguments and scripts, when KaTeX can draw it
      const run = /^\\[a-zA-Z]+(?:\{[^{}]*\}|\s*[_^](?:\{[^{}]*\}|\\?[a-zA-Z0-9]))*/.exec(s.slice(i))?.[0]
      const tex = [run, `\\${name}`].find((t) => t && renders(t))
      if (tex) {
        out += `$${tex}$`
        i += tex.length
        continue
      }
      // an unknown command: what its arguments say, or the command itself (an author's \ours)
      const [a, k] = args(s, j)
      if (a.join('').trim()) {
        out += prose(a[a.length - 1])
        i = k
        continue
      }
      out += s.slice(i, j)
      i = a.length ? k : j
      continue
    }
    // a braced super- or subscript outside $ (MEGS^{2}, O(T^{1/2})): math the author didn't mark
    if ((c === '^' || c === '_') && s[i + 1] === '{' && /\S/.test(s[i - 1] ?? ' ')) {
      const run = /^(?:[_^]\{[^{}$]*\})+/.exec(s.slice(i))?.[0]
      if (run && renders(run)) {
        out += `$${run}$`
        i += run.length
        continue
      }
    }
    if (c === '{') {
      const d = /^\{\\(bf|bfseries|em|it|itshape|sl|tt|ttfamily|sc|scshape|rm|sf)(?![a-zA-Z])\s*/.exec(s.slice(i))
      const g = group(s, i)
      if (d && g) {
        out += mark(MARK[d[1]], prose(g[0].slice(d[0].length - 1)))
        i = g[1]
        continue
      }
      // never closed
      if (!g) {
        i++
        continue
      }
      // braces group in TeX ({\L}ojasiewicz, {BERT}, 93{,}695); a list in braces is written out ({1.5B, 3B, 7B})
      const items = g[0].replace(/\{[^{}]*\}/g, '').split(',')
      const list = items.length > 1 && !g[0].startsWith('\\') && items.every((x) => x.trim() && x.trim().length <= 30)
      out += list ? `\\{${prose(g[0])}\\}` : prose(g[0])
      i = g[1]
      continue
    }
    // closes nothing
    if (c === '}') {
      i++
      continue
    }
    // a tie after a word (Fig.~3, Grok~4); after a space or between numbers it means "about" or a range
    if (c === '~') {
      out += /[a-zA-Z.,:]/.test(s[i - 1] ?? '') && /\S/.test(s[i + 1] ?? ' ') ? '\u00a0' : '~'
      i++
      continue
    }
    if (c === '`' && s[i + 1] === '`') {
      out += '“'
      i += 2
      continue
    }
    if (c === "'" && s[i + 1] === "'") {
      out += '”'
      i += 2
      continue
    }
    if (c === '<' && /^<\/?[a-zA-Z]/.test(s.slice(i, i + 3)) && !TAG.test(s.slice(i))) {
      out += '\\<'
      i++
      continue
    }
    out += c
    i++
  }
  return out
}

// --- and -- are TeX's dashes; formulas and links keep theirs
const dashes = (t: string) =>
  t
    .split(/(\$\$[\s\S]*?\$\$|(?<!\\)\$(?:\\.|[^$\\])*\$|\S*:\/\/\S*)/)
    .map((x, i) => (i % 2 ? x : x.replace(/---/g, '—').replace(/(?<=[\w\s)])--(?=[\w\s(])/g, '–')))
    .join('')

/** Raised whenever these rules change, so text already stored is read again. */
export const TIDY_VERSION = 1

/** A title or abstract as Shiori keeps it. Reading it again changes nothing. */
export function tidyTex(s: string): string {
  if (!/[\\$`'{}~^_<-]/.test(s)) return s
  const src = s
    // \\% for \%: written for a site that reads Markdown before math
    .replace(/\\\\(?=[$%&#_{}|])/g, '\\')
    // \$L^\star\$ around a formula, for the same reason
    .replace(/\\\$(\S(?:[^$]*?\S)?)\\\$/g, (m, inner) => (/\\[a-zA-Z]|[_^]|^\S+$/.test(inner) ? `$${inner}$` : m))
  return dashes(prose(src))
    .replace(/[ \u00a0]{2,}/g, ' ')
    .trim()
}

/* ---------- what is left ---------- */

type Piece = { text: string; tex?: undefined } | { tex: string; display: boolean; raw: string }

/** Tidied text as text and formulas, in order. */
function pieces(s: string): Piece[] {
  const out: Piece[] = []
  let text = ''
  for (let i = 0; i < s.length; ) {
    if (s[i] === '\\') {
      text += s.slice(i, i + 2)
      i += 2
      continue
    }
    if (s[i] === '$') {
      const f = formulaAt(s, i)
      if (f?.price !== undefined) {
        text += s.slice(i, f.price)
        i = f.price
        continue
      }
      if (f) {
        if (text) out.push({ text })
        text = ''
        out.push({ tex: f.tex, display: f.display, raw: s.slice(i, f.end) })
        i = f.end
        continue
      }
    }
    text += s[i++]
  }
  if (text) out.push({ text })
  return out
}

const MACRO = /(?<!\\)\\[a-zA-Z]+/g

/** What the rules couldn't read: an author's own macros, in text (\ours) or in a formula (\by), and formulas KaTeX can't draw ($\tilde$). */
export function unresolved(s: string): string[] {
  const out = new Set<string>()
  for (const p of pieces(s)) {
    if (p.tex === undefined) for (const m of p.text.match(MACRO) ?? []) out.add(m)
    else {
      const drawn = drawTex(p.tex, p.display)
      if (!drawn) out.add(p.raw)
      else for (const m of drawn.own) out.add(m)
    }
  }
  return [...out]
}

/**
 * Answers for what the rules couldn't read, put in place: a macro becomes what it stands for (empty: nothing), a
 * formula KaTeX can't draw becomes its corrected form; null means nobody knows, and the text stays as it is.
 */
export function applyFixes(s: string, fixes: Record<string, string | null> | undefined): string {
  if (!fixes || !Object.keys(fixes).length) return s
  const has = (k: string) => typeof fixes[k] === 'string'
  let out = ''
  for (const p of pieces(s)) {
    if (p.tex === undefined) out += p.text.replace(MACRO, (m) => (has(m) ? fixes[m]! : m))
    else if (has(p.raw)) out += fixes[p.raw]
    else
      out += p.raw.replace(MACRO, (m) => {
        if (!has(m)) return m
        // inside a formula: the answer's own math, or its words as text
        const v = fixes[m]!.trim()
        const math = /^\$([^$]+)\$$/.exec(v)
        return math ? math[1] : v ? `\\text{${v}}` : ''
      })
  }
  return tidyTex(out)
}

/** A < that would open a tag other than the marks (<think>, <eos>), written as text; formulas keep theirs. For text no rule has read. */
export function escapeTags(s: string): string {
  if (!s.includes('<')) return s
  return pieces(s)
    .map((p) => (p.tex === undefined ? p.text.replace(/(?<!\\)<(?=\/?[a-zA-Z])/g, (m, at: number, t: string) => (TAG.test(t.slice(at)) ? m : '\\<')) : p.raw))
    .join('')
}

/** Tidied text without its marks, for matching words: **C**ompetence-**A**ware → Competence-Aware. */
export const plainText = (s: string) => s.replace(/\*+|<\/?(?:b|strong|i|em|u|sub|sup|code)>/gi, '').replace(/\\([^a-zA-Z0-9\s])/g, '$1')
