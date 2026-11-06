import { utilityProcess } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Channel, ConfPaper, Edition } from '../../shared/conferences'
import { normTitle } from '../../shared/conferences'
import { applyFixes, plainText, tidyTex, unresolved } from '../../shared/tex'
import { editionDir, loadPapers, paperKey, savePapers } from './store'

/*
 * Fetch scripts: channels/<id>.js defines `async function fetchPapers(tools)` and returns the papers it found.
 * Shiori runs each in a utility process (runner.ts), cleans what comes back and merges it into papers.json,
 * one paper per normalised title. Papers Claude wrote down itself sit in channels/<id>.json and merge the same way.
 * Titles and abstracts are read as TeX on the way in (shared/tex.ts).
 */

export interface RawPaper {
  /** From the title as the channel gives it, so reading the title differently never changes which paper it is */
  key: string
  title: string
  authors: string[]
  abstract?: string
  track?: string
  kind?: string
  area?: string
  url?: string
  pdf?: string
  arxiv?: string
}

export interface ScriptRun {
  ok: boolean
  papers: RawPaper[]
  error?: string
  log: string
  requests: number
  ms: number
}

const RUN_LIMIT = 10 * 60_000

export function runScript(code: string, file: string): Promise<ScriptRun> {
  const started = Date.now()
  return new Promise((resolve) => {
    const child = utilityProcess.fork(join(__dirname, 'runner.js'), [], { serviceName: 'Shiori fetch script', stdio: 'ignore' })
    let done = false
    const finish = (r: Omit<ScriptRun, 'ms'>) => {
      if (done) return
      done = true
      clearTimeout(timer)
      child.kill()
      resolve({ ...r, ms: Date.now() - started })
    }
    const timer = setTimeout(() => finish({ ok: false, papers: [], error: `still running after ${RUN_LIMIT / 60_000} minutes; stopped`, log: '', requests: 0 }), RUN_LIMIT)
    child.on('message', (m: any) => {
      if (!m.ok) return finish({ ok: false, papers: [], error: m.error, log: m.log, requests: m.requests })
      const list = Array.isArray(m.result) ? m.result : Array.isArray(m.result?.papers) ? m.result.papers : undefined
      if (!list) return finish({ ok: false, papers: [], error: 'fetchPapers must return an array of papers, or { papers: [...] }', log: m.log, requests: m.requests })
      finish({ ok: true, papers: list.map(clean).filter(Boolean) as RawPaper[], log: m.log, requests: m.requests })
    })
    child.on('exit', (code) => finish({ ok: false, papers: [], error: `the script process exited (${code})`, log: '', requests: 0 }))
    child.postMessage({ code, file })
  })
}

const text = (v: unknown, max: number) =>
  typeof v === 'string' || typeof v === 'number'
    ? String(v)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max) || undefined
    : undefined
const link = (v: unknown) => {
  const s = text(v, 1000)
  return s && /^https?:\/\//.test(s) ? s : undefined
}

function clean(raw: any): RawPaper | undefined {
  const title = text(raw?.title, 500)
  if (!title || normTitle(title).length < 4) return undefined
  const authors = (Array.isArray(raw.authors) ? raw.authors : typeof raw.authors === 'string' ? raw.authors.split(/\s*[,;]\s*|\s+and\s+/) : [])
    .map((a: unknown) => text(typeof a === 'object' && a ? (a as any).name ?? (a as any).fullname : a, 120))
    .filter(Boolean)
    .slice(0, 100) as string[]
  const arxiv = text(raw.arxiv, 40)?.match(/\d{4}\.\d{4,5}/)?.[0]
  const abstract = text(raw.abstract, 8000)
  return {
    key: paperKey(title),
    title: tidyTex(title),
    authors,
    abstract: abstract && tidyTex(abstract),
    track: text(raw.track, 60),
    kind: text(raw.kind, 40),
    area: text(raw.area, 120),
    url: link(raw.url),
    pdf: link(raw.pdf),
    arxiv
  }
}

export const scriptFile = (e: Edition, ch: Pick<Channel, 'id' | 'kind'>) => join(editionDir(e.conf, e.year), 'channels', `${ch.id}.${ch.kind === 'script' ? 'js' : 'json'}`)

/** A channel's papers: its script run now, or the papers Claude wrote down. */
export async function runChannel(e: Edition, ch: Channel): Promise<ScriptRun> {
  const file = scriptFile(e, ch)
  if (!existsSync(file)) return { ok: false, papers: [], error: `${ch.kind === 'script' ? 'script' : 'data file'} missing`, log: '', requests: 0, ms: 0 }
  if (ch.kind === 'data') {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'))
      const list = Array.isArray(data) ? data : data.papers
      return { ok: true, papers: (list ?? []).map(clean).filter(Boolean), log: '', requests: 0, ms: 0 }
    } catch (err) {
      return { ok: false, papers: [], error: `cannot read ${ch.id}.json: ${(err as Error).message}`, log: '', requests: 0, ms: 0 }
    }
  }
  const run = await runScript(readFileSync(file, 'utf8'), `${ch.id}.js`)
  // The last output, kept for Claude to look at when the channel needs repair.
  mkdirSync(join(editionDir(e.conf, e.year), 'out'), { recursive: true })
  writeFileSync(join(editionDir(e.conf, e.year), 'out', `${ch.id}.json`), JSON.stringify({ ...run, papers: run.papers.slice(0, 20), count: run.papers.length }, null, 1))
  return run
}

export interface MergeStats {
  added: number
  abstracts: number
  pdfs: number
  /** Papers that just got a PDF */
  pdfKeys: string[]
}

const surname = (a?: string) => a?.trim().split(/\s+/).pop()?.toLowerCase()

/** What no rule could read in a paper's title and abstract, less what Claude was already asked about. */
export function leftoversOf(p: Pick<ConfPaper, 'title' | 'abstract' | 'fixes'>): string[] | undefined {
  const left = [...new Set([...unresolved(p.title), ...unresolved(p.abstract ?? '')])].filter((t) => !(t in (p.fixes ?? {})))
  return left.length ? left : undefined
}

/** How much of a text was read as math and marks: the length inside formulas, and the marks. */
const markup = (s: string) =>
  [...s.matchAll(/(?<!\\)\$((?:\\.|[^$\\])+)\$/g)].reduce((n, m) => n + m[1].length, 0) + (s.match(/\*+|<(?:b|strong|i|em|sub|sup)>/g)?.length ?? 0)

/** The same words with more of their math and marks kept: the channel, or its script, reads the source better now. */
const richer = (a: string, b: string) => a !== b && markup(a) > markup(b) && normTitle(plainText(a)) === normTitle(plainText(b))

/** Raised when merging keeps more of a paper's links than it did; every edition is then fetched once more. */
export const LINKS_VERSION = 1

/** Merge one channel's papers into the edition. */
export function mergeChannel(e: Edition, channel: string, found: RawPaper[]): MergeStats {
  const list = loadPapers(e.conf, e.year)
  const byKey = new Map(list.map((p) => [p.key, p]))
  const now = new Date().toISOString()
  const stats: MergeStats = { added: 0, abstracts: 0, pdfs: 0, pdfKeys: [] }
  const added: ConfPaper[] = []
  for (const r of found) {
    const p = byKey.get(r.key)
    if (!p) {
      const fresh: ConfPaper = { ...r, sources: [channel], firstSeen: now, pdfSeen: r.pdf ? now : undefined, leftovers: leftoversOf(r) }
      for (const k of Object.keys(fresh) as (keyof ConfPaper)[]) if (fresh[k] === undefined) delete fresh[k]
      byKey.set(r.key, fresh)
      list.push(fresh)
      added.push(fresh)
      stats.added++
      continue
    }
    if (!p.sources.includes(channel)) p.sources.push(channel)
    if (r.authors.length > p.authors.length) p.authors = r.authors
    const title = applyFixes(r.title, p.fixes)
    const abstract = r.abstract && applyFixes(r.abstract, p.fixes)
    const before = [p.title, p.abstract]
    if (richer(title, p.title)) p.title = title
    if (abstract && (!p.abstract || abstract.length > p.abstract.length + 20 || richer(abstract, p.abstract))) {
      if (!p.abstract) stats.abstracts++
      p.abstract = abstract
    }
    if (p.title !== before[0] || p.abstract !== before[1]) p.leftovers = leftoversOf(p)
    if (r.pdf && !p.pdf) {
      p.pdf = r.pdf
      p.pdfSeen = now
      stats.pdfs++
      stats.pdfKeys.push(p.key)
    } else if (r.pdf && r.pdf !== p.pdf && !p.pdfs?.includes(r.pdf)) p.pdfs = [...(p.pdfs ?? []), r.pdf]
    p.track ??= r.track
    p.kind ??= r.kind
    p.area ??= r.area
    p.url ??= r.url
    p.arxiv ??= r.arxiv
  }
  savePapers(e.conf, e.year, list)
  return stats
}

/** Edit distance, giving up once it passes `max`. */
function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    let low = i
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      low = Math.min(low, row[j])
    }
    if (low > max) return max + 1
    prev = row
  }
  return prev[b.length]
}

/**
 * Pairs that may be one paper listed twice under slightly different titles: one title starts with the other, the
 * two differ by a few letters, or they share a distinctive name before a colon ("LongVideoScaler: ..."). A first
 * author that differs settles it. Claude decides the rest on its next patrol.
 */
export function findAmbiguous(e: Edition): [string, string][] {
  const list = loadPapers(e.conf, e.year)
  const decided = new Set([...(e.distinct ?? []), ...(e.ambiguous ?? [])].map(([a, b]) => [a, b].sort().join()))
  const buckets = new Map<string, ConfPaper[]>()
  const put = (sig: string, p: ConfPaper) => buckets.set(sig, [...(buckets.get(sig) ?? []), p])
  for (const p of list) {
    put(`p:${normTitle(p.title).slice(0, 24)}`, p)
    const head = normTitle(p.title.split(':')[0])
    if (p.title.includes(':') && head.length >= 6 && head.length <= 30) put(`h:${head}`, p)
  }
  const out: [string, string][] = []
  for (const [sig, group] of buckets) {
    // A crowd sharing a beginning ("Towards efficient ...") is a common phrase, not a duplicate.
    if (group.length > 8) continue
    for (let i = 0; i < group.length; i++)
      for (let j = i + 1; j < group.length; j++) {
        const [a, b] = [group[i], group[j]]
        if (a.key === b.key) continue
        const sa = surname(a.authors[0])
        const sb = surname(b.authors[0])
        if (sa && sb && sa !== sb) continue
        const na = normTitle(a.title)
        const nb = normTitle(b.title)
        const [short, long] = na.length < nb.length ? [na, nb] : [nb, na]
        const close = sig.startsWith('h:') || long.startsWith(short) || distance(na, nb, Math.max(2, Math.round(long.length * 0.06))) <= Math.max(2, Math.round(long.length * 0.06))
        if (!close) continue
        const id = [a.key, b.key].sort().join()
        if (decided.has(id)) continue
        decided.add(id)
        out.push([a.key, b.key])
      }
  }
  return out.slice(0, 200)
}

/** Claude said these are one paper: keep the first, folding the second into it. */
export function mergeSame(e: Edition, pairs: [string, string][]): number {
  const list = loadPapers(e.conf, e.year)
  const byKey = new Map(list.map((p) => [p.key, p]))
  const gone = new Set<string>()
  for (const [ka, kb] of pairs) {
    const a = byKey.get(ka)
    const b = byKey.get(kb)
    if (!a || !b || gone.has(ka) || gone.has(kb)) continue
    a.sources = [...new Set([...a.sources, ...b.sources])]
    if (b.authors.length > a.authors.length) a.authors = b.authors
    if ((b.abstract?.length ?? 0) > (a.abstract?.length ?? 0)) a.abstract = b.abstract
    a.pdf ??= b.pdf
    const pdfs = [...new Set([...(a.pdfs ?? []), b.pdf, ...(b.pdfs ?? [])])].filter((u): u is string => !!u && u !== a.pdf)
    if (pdfs.length) a.pdfs = pdfs
    a.pdfSeen ??= b.pdfSeen
    a.track ??= b.track
    a.kind ??= b.kind
    a.url ??= b.url
    a.arxiv ??= b.arxiv
    a.follows = [...new Set([...(a.follows ?? []), ...(b.follows ?? [])])]
    if (b.firstSeen < a.firstSeen) a.firstSeen = b.firstSeen
    gone.add(kb)
  }
  if (gone.size) savePapers(e.conf, e.year, list.filter((p) => !gone.has(p.key)))
  return gone.size
}

/** What a run gave, for Claude to judge the script by. */
export function describeRun(id: string, run: ScriptRun): string {
  const n = run.papers.length
  const share = (f: (p: RawPaper) => unknown) => `${run.papers.filter(f).length}/${n}`
  const values = (f: (p: RawPaper) => string | undefined) => {
    const counts = new Map<string, number>()
    for (const p of run.papers) {
      const v = f(p)
      if (v) counts.set(v, (counts.get(v) ?? 0) + 1)
    }
    return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([v, c]) => `${v} (${c})`).join(', ') || '-'
  }
  const sample = run.papers
    .filter((_, i) => i === 0 || i === Math.floor(n / 2) || i === n - 1)
    .map((p) => JSON.stringify({ ...p, abstract: p.abstract && p.abstract.slice(0, 160) + (p.abstract.length > 160 ? '…' : '') }))
  return [
    `### ${id}`,
    run.ok ? `OK: ${n} papers in ${Math.round(run.ms / 1000)} s, ${run.requests} requests` : `FAILED after ${Math.round(run.ms / 1000)} s, ${run.requests} requests: ${run.error}`,
    ...(run.ok
      ? [
          `with authors ${share((p) => p.authors.length)}, abstract ${share((p) => p.abstract)}, pdf ${share((p) => p.pdf)}, url ${share((p) => p.url)}, arxiv ${share((p) => p.arxiv)}`,
          `track: ${values((p) => p.track)}`,
          `kind: ${values((p) => p.kind)}`,
          ...(sample.length ? ['samples:', ...sample] : [])
        ]
      : []),
    ...(run.log ? ['log:', run.log.slice(0, 4000)] : [])
  ].join('\n')
}
