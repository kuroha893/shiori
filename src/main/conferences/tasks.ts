import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { Channel, ConfPaper, Conference, Edition, Follow, Theme } from '../../shared/conferences'
import { editionRef } from '../../shared/conferences'
import { applyFixes, plainText, tidyTex } from '../../shared/tex'
import { modelFor, runAgent } from '../ai'
import { glossaryPrompt } from '../glossary'
import { getSettings } from '../settings'
import * as P from './prompts'
import { describeRun, leftoversOf, runScript } from './scripts'
import { confDir, confRoot, editionDir, loadFollows, loadPapers, loadThemes, readEdition, savePapers, saveThemes, updateEdition } from './store'

/*
 * Everything Claude does for conferences. It runs with the model chosen for processing papers. Claude cannot run
 * code, so when it writes a fetch script it asks Shiori to run it (a "RUN:" line) and gets the results back in the
 * same session, as many rounds as it needs.
 */

const glossary = () => {
  const g = glossaryPrompt()
  return g === '(empty)' ? '' : `\nGlossary (English → Chinese; 不译 keeps the English):\n${g}\n`
}

const processModel = () => modelFor(getSettings().processModel, 'process')
const chatModel = () => modelFor(getSettings().chatModel, 'chat')

/** A JSON file the run was asked to write; removed once read. */
function take<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  } finally {
    rmSync(file, { force: true })
  }
}

/** The files a reply asks Shiori to run, from its last RUN: line near the end. */
function requested(text: string): string[] | undefined {
  const tail = text.trim().split('\n').slice(-6)
  const line = tail.reverse().find((l) => /^\s*`?RUN:/.test(l))
  if (!line) return undefined
  return line
    .replace(/^\s*`?RUN:/, '')
    .replace(/`/g, '')
    .split(/[\s,]+/)
    .filter(Boolean)
}

export interface LoopOptions {
  effort: string
  signal?: AbortSignal
  onRound?: (round: number) => void
}

/** A run that may write fetch scripts and have Shiori test them, round after round, until it says DONE. */
async function scriptLoop(cwd: string, prompt: string, o: LoopOptions): Promise<void> {
  try {
    await rounds(cwd, prompt, o)
  } finally {
    // Scratch scripts (probes) don't outlive the run; channel scripts live in channels/.
    for (const f of readdirSync(cwd)) if (f.endsWith('.js')) rmSync(join(cwd, f), { force: true })
  }
}

async function rounds(cwd: string, prompt: string, o: LoopOptions): Promise<void> {
  const model = await processModel()
  const base = { cwd, model, effort: o.effort, write: true, search: true, fetch: true, keep: true, signal: o.signal }
  let r = await runAgent({ ...base, prompt })
  for (let round = 1; ; round++) {
    if (r.isError) throw new Error(r.text || 'Claude 出错了')
    const files = requested(r.text)
    if (!files || round > P.MAX_ROUNDS) return
    o.onRound?.(round)
    const reports: string[] = []
    for (const f of files.slice(0, 8)) {
      const full = resolve(cwd, f)
      if (!full.startsWith(resolve(cwd) + sep) || !f.endsWith('.js') || !existsSync(full)) {
        reports.push(`### ${f}\nnot found: give .js paths relative to this folder`)
        continue
      }
      reports.push(describeRun(f, await runScript(readFileSync(full, 'utf8'), f)))
    }
    const left = P.MAX_ROUNDS - round
    r = await runAgent({
      ...base,
      session: r.session,
      prompt: `${reports.join('\n\n')}\n\n${left ? `${left} rounds left.` : 'No rounds left: write channels.json as things stand and reply DONE.'}`
    })
  }
}

/** channels.json as Claude left it, keeping what Shiori knows about channels it already had. */
function readChannels(e: Edition): Channel[] {
  const dir = editionDir(e.conf, e.year)
  let list: any[]
  try {
    list = JSON.parse(readFileSync(join(dir, 'channels.json'), 'utf8'))
  } catch {
    return e.channels
  }
  if (!Array.isArray(list)) return e.channels
  const now = new Date().toISOString()
  const out: Channel[] = []
  for (const c of list) {
    const id = String(c?.id ?? '')
    const kind = c?.kind === 'data' ? 'data' : 'script'
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(id) || out.some((x) => x.id === id)) continue
    if (!existsSync(join(dir, 'channels', `${id}.${kind === 'script' ? 'js' : 'json'}`))) continue
    const before = e.channels.find((x) => x.id === id)
    out.push({
      ...before,
      id,
      kind,
      name: String(c.name || id).slice(0, 60),
      url: typeof c.url === 'string' ? c.url.slice(0, 500) : undefined,
      provides: Array.isArray(c.provides) ? c.provides.filter((x: unknown) => typeof x === 'string') : undefined,
      note: typeof c.note === 'string' ? c.note.slice(0, 120) : undefined,
      addedAt: before?.addedAt ?? now,
      // A rewritten script gets a fresh start.
      ...(before?.error ? { error: undefined, failures: 0 } : {})
    })
  }
  return out
}

/* ---------- a conference and its editions ---------- */

export interface SetupResult {
  /** Where its graphic mark can be downloaded */
  mark?: string
  name: string
  fullName?: string
  latest?: { year: number; releaseDate?: string; source?: string }
  next?: { year: number; releaseDate?: string; estimated?: boolean; source?: string }
}

export async function setupConference(c: Conference, signal?: AbortSignal): Promise<SetupResult> {
  const dir = confDir(c.id)
  mkdirSync(dir, { recursive: true })
  rmSync(join(dir, 'setup.json'), { force: true })
  const r = await runAgent({ cwd: dir, prompt: P.setupPrompt(c.name), model: await processModel(), effort: 'low', write: true, search: true, fetch: true, signal })
  if (r.isError) throw new Error(r.text || 'Claude 出错了')
  const out = take<any>(join(dir, 'setup.json'))
  if (!out) throw new Error('没有查到这个会议的信息')
  if (out.error) throw new Error(String(out.error))
  const year = (v: unknown) => (Number.isInteger(+String(v)) && +String(v) > 1980 ? +String(v) : undefined)
  const date = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined)
  const latestYear = year(out.latest?.year)
  const nextYear = year(out.next?.year)
  return {
    name: String(out.name || c.name).slice(0, 30),
    fullName: out.fullName ? String(out.fullName).slice(0, 160) : undefined,
    mark: typeof out.mark === 'string' && /^https?:\/\//.test(out.mark) ? out.mark : undefined,
    latest: latestYear ? { year: latestYear, releaseDate: date(out.latest.releaseDate), source: out.latest.source } : undefined,
    next: nextYear ? { year: nextYear, releaseDate: date(out.next.releaseDate), estimated: !!out.next.estimated, source: out.next.source } : undefined
  }
}

export interface DateResult {
  released: boolean
  releaseDate?: string
  source?: string
  note?: string
  nextYear?: number
}

export async function checkDate(e: Edition, fullName: string | undefined, signal?: AbortSignal): Promise<DateResult> {
  const dir = editionDir(e.conf, e.year)
  const file = join(dir, 'date.json')
  rmSync(file, { force: true })
  const name = e.name.replace(/\s+\d{4}$/, '')
  const r = await runAgent({
    cwd: dir,
    prompt: P.datePrompt({ name, fullName, year: e.year, known: e.releaseDate }),
    model: await processModel(),
    effort: 'low',
    write: true,
    search: true,
    fetch: true,
    signal
  })
  if (r.isError) throw new Error(r.text || 'Claude 出错了')
  const out = take<any>(file)
  if (!out) throw new Error('没有查到公布日期')
  return {
    released: out.released === true,
    releaseDate: typeof out.releaseDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(out.releaseDate) ? out.releaseDate : undefined,
    source: typeof out.source === 'string' ? out.source : undefined,
    note: typeof out.note === 'string' ? out.note.slice(0, 200) : undefined,
    nextYear: Number.isInteger(out.nextYear) && out.nextYear > e.year ? out.nextYear : undefined
  }
}

/** Find the channels of an edition and write their scripts. */
export async function discover(e: Edition, fullName: string | undefined, o: LoopOptions): Promise<Channel[]> {
  const dir = editionDir(e.conf, e.year)
  mkdirSync(join(dir, 'channels'), { recursive: true })
  const existing = e.channels.map((c) => `- ${c.id} (${c.name}, ${c.url ?? ''}): ${c.error ? `failing: ${c.error.slice(0, 160)}` : `${c.count ?? 0} papers`}`).join('\n')
  writeFileSync(join(dir, 'channels.json'), JSON.stringify(e.channels.map(({ id, name, url, kind, provides, note }) => ({ id, name, url, kind, provides, note })), null, 1))
  await scriptLoop(dir, P.discoverPrompt({ edition: e.name, fullName, releaseDate: e.releaseDate, past: e.past, existing }), o)
  return readChannels(e)
}

export interface PatrolResult {
  channels: Channel[]
  officialCount?: number
  same: [string, string][]
  different: [string, string][]
  note?: string
}

/** The daily look while papers are coming in; with search off, only failing scripts and duplicates. */
export async function patrol(e: Edition, o: LoopOptions & { search: boolean }): Promise<PatrolResult> {
  const dir = editionDir(e.conf, e.year)
  const papers = loadPapers(e.conf, e.year)
  const failing = e.channels.filter((c) => c.error).map((c) => c.id)
  const byKey = new Map(papers.map((p) => [p.key, p]))
  const pairs = (e.ambiguous ?? [])
    .slice(0, 60)
    .map(([a, b]) => {
      const pa = byKey.get(a)
      const pb = byKey.get(b)
      return pa && pb ? `  ${a}: ${pa.title} (${pa.authors.slice(0, 3).join(', ')})\n  ${b}: ${pb.title} (${pb.authors.slice(0, 3).join(', ')})` : ''
    })
    .filter(Boolean)
    .join('\n\n')
  const state = [
    `- ${papers.length} papers merged${e.officialCount ? `; the conference says it accepted ${e.officialCount}` : ''}; ${papers.filter((p) => p.abstract).length} with an abstract, ${papers.filter((p) => p.pdf).length} with a PDF link`,
    ...e.channels.map((c) => `- channel ${c.id} (${c.name}, ${c.url ?? ''}): ${c.error ? `FAILED: ${c.error.slice(0, 200)}` : `${c.count ?? 0} papers`}, last run ${c.ranAt ?? 'never'}`)
  ].join('\n')
  const file = join(dir, 'patrol.json')
  rmSync(file, { force: true })
  writeFileSync(join(dir, 'channels.json'), JSON.stringify(e.channels.map(({ id, name, url, kind, provides, note }) => ({ id, name, url, kind, provides, note })), null, 1))
  await scriptLoop(dir, P.patrolPrompt({ edition: e.name, state, failing, pairs, search: o.search }), o)
  const out = take<any>(file) ?? {}
  const pairList = (v: unknown) => (Array.isArray(v) ? v.filter((x) => Array.isArray(x) && x.length === 2 && x.every((k) => byKey.has(k))) : []) as [string, string][]
  return {
    channels: readChannels(e),
    officialCount: Number.isInteger(out.officialCount) && out.officialCount > 0 ? out.officialCount : undefined,
    same: pairList(out.same),
    different: pairList(out.different),
    note: typeof out.note === 'string' && out.note.trim() ? out.note.trim().slice(0, 200) : undefined
  }
}

/* ---------- the theme map ---------- */

export async function makeThemes(e: Edition, signal?: AbortSignal): Promise<Theme[]> {
  const dir = editionDir(e.conf, e.year)
  const papers = loadPapers(e.conf, e.year)
  writeFileSync(join(dir, 'titles.txt'), papers.map((p) => [p.key, p.title, [p.track, p.kind].filter(Boolean).join(' ')].join('\t')).join('\n'))
  const file = join(dir, 'themes.json')
  const r = await runAgent({
    cwd: dir,
    prompt: P.themesPrompt({ edition: e.name, count: papers.length, glossary: glossary() }),
    model: await processModel(),
    effort: 'medium',
    write: true,
    signal
  })
  rmSync(join(dir, 'titles.txt'), { force: true })
  if (r.isError) throw new Error(r.text || 'Claude 出错了')
  let raw: any
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new Error('没有写出主题')
  }
  const themes: Theme[] = (Array.isArray(raw) ? raw : [])
    .map((t: any, i: number) => {
      const id = `t${i + 1}`
      return {
        id,
        name: String(t?.name ?? '').slice(0, 40),
        note: String(t?.note ?? '').slice(0, 200),
        branches: (Array.isArray(t?.branches) ? t.branches : []).map((b: any, j: number) => ({
          id: `${id}.${j + 1}`,
          name: String(b?.name ?? '').slice(0, 40),
          note: String(b?.note ?? '').slice(0, 200),
          keywords: (Array.isArray(b?.keywords) ? b.keywords : []).map(String).slice(0, 12)
        }))
      }
    })
    .filter((t: Theme) => t.name && t.branches.length)
  if (themes.length < 3) throw new Error('主题归纳得不完整')
  saveThemes(e.conf, e.year, themes)
  // A new map: every paper is sorted again.
  savePapers(
    e.conf,
    e.year,
    papers.map(({ branch: _, ...p }) => p)
  )
  return themes
}

const BATCH = 250

const followLines = (follows: Follow[]) =>
  follows
    .filter((f) => !f.pending)
    .map((f) => `${f.id}: ${f.name}: ${f.note ?? ''}; ${f.keywords.join(', ')}`)
    .join('\n')

const line = (p: { key: string; title: string; abstract?: string }) => [p.key, p.title, (p.abstract ?? '').slice(0, 360)].join('\t')

/** Sort papers that have no branch yet, two batches at a time. Returns how many Claude sorted. */
export async function assignPapers(e: Edition, o: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void }): Promise<number> {
  const dir = editionDir(e.conf, e.year)
  const themes = loadThemes(e.conf, e.year)
  const branches = new Set(themes.flatMap((t) => t.branches.map((b) => b.id)))
  const fallback = themes[themes.length - 1]?.branches[0]?.id
  const follows = loadFollows().filter((f) => !f.pending)
  const followIds = new Set(follows.map((f) => f.id))
  const map = themes.flatMap((t) => t.branches.map((b) => `${b.id}: ${t.name} › ${b.name}: ${b.note}`)).join('\n')
  const todo = loadPapers(e.conf, e.year).filter((p) => !p.branch)
  const model = await processModel()
  const work = join(dir, 'assign')
  mkdirSync(work, { recursive: true })
  let done = 0
  let sorted = 0
  const runBatch = async (n: number, batch: typeof todo) => {
    const input = `batch-${n}.tsv`
    const out = `out-${n}.tsv`
    writeFileSync(join(work, input), batch.map(line).join('\n'))
    rmSync(join(work, out), { force: true })
    const r = await runAgent({
      cwd: work,
      prompt: P.assignPrompt({ edition: e.name, map, follows: followLines(follows), lines: batch.length, glossary: glossary(), batch: input, out }),
      model,
      effort: 'low',
      write: true,
      signal: o.signal
    })
    const result = new Map<string, { branch: string; follows: string[]; zh?: string }>()
    if (!r.isError && existsSync(join(work, out))) {
      for (const l of readFileSync(join(work, out), 'utf8').split('\n')) {
        const [key, branch, fs, zh] = l.split('\t').map((s) => s?.trim())
        if (!key || !branches.has(branch)) continue
        result.set(key, { branch, follows: (fs ?? '').split(',').map((s) => s.trim()).filter((f) => followIds.has(f)), zh: zh || undefined })
      }
    }
    rmSync(join(work, input), { force: true })
    rmSync(join(work, out), { force: true })
    // Read again: other batches have saved meanwhile.
    const list = loadPapers(e.conf, e.year)
    const now = new Date().toISOString()
    for (const p of list) {
      const got = result.get(p.key)
      if (got) {
        sorted++
        p.branch = got.branch
        p.titleZh ??= got.zh && applyFixes(tidyTex(got.zh), p.fixes)
        if (got.follows.length) {
          p.follows = [...new Set([...(p.follows ?? []), ...got.follows])]
          p.followedAt = now
        }
      } else if (batch.some((b) => b.key === p.key) && missed.get(p.key)! >= 1 && fallback) {
        // Left out twice: it goes to 其他 rather than holding the edition up.
        p.branch = fallback
      }
    }
    for (const p of batch) if (!result.has(p.key)) missed.set(p.key, (missed.get(p.key) ?? 0) + 1)
    savePapers(e.conf, e.year, list)
    done += batch.length
    o.onProgress?.(done, todo.length)
    if (r.isError) throw new Error(r.text || 'Claude 出错了')
  }
  const batches: (typeof todo)[] = []
  for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH))
  let next = 0
  const worker = async () => {
    while (next < batches.length && !o.signal?.aborted) {
      const n = next++
      await runBatch(n, batches[n])
    }
  }
  await Promise.all([worker(), worker()])
  return sorted
}

/** Papers a batch left out, by key; the second time they go to 其他. */
const missed = new Map<string, number>()

/* ---------- the owner's directions ---------- */

/** Mark a direction's papers in one edition: by branch when it came from this edition's map, else candidates by keyword, then Claude. */
export async function tagFollow(e: Edition, f: Follow, signal?: AbortSignal): Promise<number> {
  const ref = editionRef(e.conf, e.year)
  const list = loadPapers(e.conf, e.year)
  let keys: Set<string>
  if (f.from?.edition === ref) {
    const theme = f.from.theme
    keys = new Set(list.filter((p) => p.branch && (p.branch === f.from!.branch || (theme && p.branch.startsWith(`${theme}.`)))).map((p) => p.key))
  } else {
    const kws = f.keywords.map((k) => k.toLowerCase().trim()).filter(Boolean)
    const candidates = list.filter((p) => {
      const text = plainText(`${p.title} ${p.abstract ?? ''}`).toLowerCase()
      return kws.some((k) => text.includes(k))
    })
    keys = new Set()
    const dir = join(editionDir(e.conf, e.year), 'assign')
    mkdirSync(dir, { recursive: true })
    const model = await processModel()
    for (let i = 0; i < candidates.length; i += 300) {
      const batch = candidates.slice(i, i + 300)
      const input = `follow-${f.id}-${i}.tsv`
      const out = `follow-${f.id}-${i}.txt`
      writeFileSync(join(dir, input), batch.map(line).join('\n'))
      const r = await runAgent({
        cwd: dir,
        prompt: P.followTagPrompt({ edition: e.name, name: f.name, note: f.note, keywords: f.keywords, file: input, out }),
        model,
        effort: 'low',
        write: true,
        signal
      })
      rmSync(join(dir, input), { force: true })
      if (r.isError) throw new Error(r.text || 'Claude 出错了')
      try {
        for (const k of readFileSync(join(dir, out), 'utf8').split(/\s+/)) if (batch.some((p) => p.key === k)) keys.add(k)
      } catch {
        /* none of them */
      }
      rmSync(join(dir, out), { force: true })
    }
  }
  const now = loadPapers(e.conf, e.year)
  for (const p of now) if (keys.has(p.key) && !p.follows?.includes(f.id)) p.follows = [...(p.follows ?? []), f.id]
  savePapers(e.conf, e.year, now)
  updateEdition(e.conf, e.year, (x) => ({ followsDone: [...new Set([...(x.followsDone ?? []), f.id])] }))
  return keys.size
}

/** A direction's note and keywords, from its name and the papers filed under it. */
export async function describeFollow(name: string, titles?: string[]): Promise<{ name: string; note?: string; keywords: string[] }> {
  mkdirSync(confRoot(), { recursive: true })
  const r = await runAgent({ cwd: confRoot(), prompt: P.followPrompt({ name, titles }), model: await processModel(), effort: 'low', write: false })
  if (r.isError) throw new Error(r.text || 'Claude 出错了')
  const json = r.text.slice(r.text.indexOf('{'), r.text.lastIndexOf('}') + 1)
  const out = JSON.parse(json)
  const keywords = (Array.isArray(out.keywords) ? out.keywords : []).map((k: unknown) => String(k).trim()).filter(Boolean).slice(0, 20)
  if (!keywords.length) throw new Error('没有生成关键词')
  return { name: String(out.name || name).trim().slice(0, 40), note: out.note ? String(out.note).slice(0, 200) : undefined, keywords }
}

/** "KV cache 压缩" → "kv cache compression | kv cache eviction | kv cache quantization" */
export async function queryKeywords(text: string): Promise<string> {
  mkdirSync(confRoot(), { recursive: true })
  const r = await runAgent({ cwd: confRoot(), prompt: P.queryPrompt(text), model: await chatModel(), effort: 'low', write: false })
  if (r.isError) throw new Error(r.text || 'Claude 出错了')
  return r.text
    .trim()
    .split('\n')
    .pop()!
    .replace(/^["'`]|["'`]$/g, '')
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' | ')
}

/** A title line before the translation, which translations used to begin with: "标题：…", "**标题：…**". */
export const dropTitleLine = (zh: string) => zh.replace(/^\s*(\*\*)?\s*(标题|題目|题目|Title)\s*[:：][^\n]*\n+/i, '')

export async function translateAbstract(title: string, abstract: string): Promise<string> {
  mkdirSync(confRoot(), { recursive: true })
  const r = await runAgent({ cwd: confRoot(), prompt: P.abstractPrompt({ title, abstract, glossary: glossary() }), model: await chatModel(), effort: 'low', write: false })
  if (r.isError) throw new Error(r.text || 'Claude 出错了')
  return tidyTex(dropTitleLine(r.text.trim()))
}

/* ---------- what the rules couldn't read ---------- */

const LOOKUP_BATCH = 25

/**
 * The authors' own macros (\ours, \method) and formulas that don't compile, in an edition's titles and abstracts:
 * Claude says what each stands for, reading the paper itself when the abstract doesn't say, and its answers are put
 * in their place, a batch of papers at a time. Returns how many papers changed.
 */
export async function lookUpLeftovers(e: Edition, o: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {}): Promise<number> {
  const todo = loadPapers(e.conf, e.year).filter((p) => p.leftovers?.length)
  const model = await processModel()
  let changed = 0
  for (let i = 0; i < todo.length && !o.signal?.aborted; i += LOOKUP_BATCH) {
    o.onProgress?.(i, todo.length)
    changed += await lookUpBatch(e, todo.slice(i, i + LOOKUP_BATCH), model, o.signal)
  }
  return changed
}

/** One run over a few papers; their answers are saved before the next run starts. */
async function lookUpBatch(e: Edition, batch: ConfPaper[], model: string, signal?: AbortSignal): Promise<number> {
  const dir = editionDir(e.conf, e.year)
  const input = 'leftovers.json'
  const out = 'answers.json'
  writeFileSync(
    join(dir, input),
    JSON.stringify(
      batch.map((p) => ({ key: p.key, title: p.title, abstract: p.abstract, tokens: p.leftovers, page: p.url, pdf: p.pdf, arxiv: p.arxiv && `https://arxiv.org/abs/${p.arxiv}` })),
      null,
      1
    )
  )
  rmSync(join(dir, out), { force: true })
  const r = await runAgent({
    cwd: dir,
    prompt: P.leftoversPrompt({ edition: e.name, count: batch.length, input, out }),
    model,
    effort: 'medium',
    write: true,
    search: true,
    fetch: true,
    signal
  })
  rmSync(join(dir, input), { force: true })
  if (r.isError) throw new Error(r.text || 'Claude 出错了')
  const answers = take<Record<string, Record<string, unknown>>>(join(dir, out))
  if (!answers || typeof answers !== 'object') throw new Error('没有写出结果')
  // Read again: sorting may have saved meanwhile.
  const list = loadPapers(e.conf, e.year)
  const asked = new Set(batch.map((p) => p.key))
  let changed = 0
  for (const p of list) {
    if (!p.leftovers?.length || !asked.has(p.key)) continue
    const got = answers[p.key] ?? {}
    const fixes = { ...p.fixes }
    // A token left unanswered counts as asked: it isn't asked again.
    for (const t of p.leftovers) {
      const v = got[t]
      fixes[t] = typeof v === 'string' && v.length <= 160 && !/[\n\r]/.test(v) ? v : null
    }
    const fix = (s: string) => applyFixes(s, fixes)
    const before = [p.title, p.abstract]
    p.fixes = fixes
    p.title = fix(p.title)
    if (p.abstract) p.abstract = fix(p.abstract)
    if (p.titleZh) p.titleZh = fix(p.titleZh)
    if (p.abstractZh) p.abstractZh = fix(p.abstractZh)
    // Nor is anything an answer brought in.
    for (const t of leftoversOf(p) ?? []) fixes[t] = null
    p.leftovers = undefined
    if (p.title !== before[0] || p.abstract !== before[1]) changed++
  }
  savePapers(e.conf, e.year, list)
  return changed
}

export const stillThere = (e: Edition) => !!readEdition(e.conf, e.year)
